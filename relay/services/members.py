"""Team management: members, their roles, invitations, and the organisation's name.

Two rules shape most of this module:

* **An organisation always has an owner.** The last owner cannot be demoted or
  removed, or nobody could manage the organisation again. The check locks the
  owner rows first, so two owners demoting each other at the same moment cannot
  both succeed.
* **An invitation is a secret link, bound to one email address.** Only the hash
  of its token is stored (like API keys), it expires, and it only works for the
  address it was issued to. Someone who finds the link cannot join as themselves.

There is no outgoing email here: the owner copies the link and sends it however
they like.
"""

import asyncio
import secrets
import uuid
from datetime import datetime, timedelta

from sqlalchemy import ColumnElement, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core import security
from relay.core.errors import AppError
from relay.db.models import Invitation, Membership, Organization, User
from relay.domain.enums import Role
from relay.services import audit
from relay.services.auth import normalize_email


# ----------------------------------------------------------------- organisation
async def rename_organization(
    session: AsyncSession, *, org_id: uuid.UUID, name: str, actor_user_id: uuid.UUID
) -> Organization:
    organization = await session.get_one(Organization, org_id)
    if organization.name != name:
        audit.record(
            session,
            org_id=org_id,
            actor_user_id=actor_user_id,
            action="organization.renamed",
            target_type="organization",
            target_id=org_id,
            details={"from": organization.name, "to": name},
        )
        organization.name = name
    await session.commit()
    return organization


# ---------------------------------------------------------------------- members
def _member_not_found() -> AppError:
    return AppError(404, "member_not_found", "No such member in this organisation.")


async def _other_owner_exists(session: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    # FOR UPDATE: lock every owner row of this organisation until we commit, so
    # the "is there another owner?" answer cannot change under us.
    owners = await session.scalars(
        select(Membership.user_id)
        .where(Membership.org_id == org_id, Membership.role == Role.OWNER)
        .with_for_update()
    )
    return any(owner != user_id for owner in owners)


def _last_owner() -> AppError:
    return AppError(
        409,
        "last_owner",
        "An organisation needs at least one owner. Make someone else an owner first.",
    )


async def change_role(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    role: Role,
    actor_user_id: uuid.UUID,
) -> Membership:
    membership = await session.get(Membership, (user_id, org_id))
    if membership is None:
        raise _member_not_found()
    demoting_owner = membership.role == Role.OWNER and role is not Role.OWNER
    if demoting_owner and not await _other_owner_exists(session, org_id, user_id):
        raise _last_owner()
    if membership.role != role:
        audit.record(
            session,
            org_id=org_id,
            actor_user_id=actor_user_id,
            action="member.role_changed",
            target_type="user",
            target_id=user_id,
            details={"from": membership.role, "to": role},
        )
        membership.role = role
    await session.commit()
    return membership


async def remove_member(
    session: AsyncSession, *, org_id: uuid.UUID, user_id: uuid.UUID, actor_user_id: uuid.UUID
) -> None:
    membership = await session.get(Membership, (user_id, org_id))
    if membership is None:
        raise _member_not_found()
    if membership.role == Role.OWNER and not await _other_owner_exists(session, org_id, user_id):
        raise _last_owner()
    await session.delete(membership)
    audit.record(
        session,
        org_id=org_id,
        actor_user_id=actor_user_id,
        action="member.removed",
        target_type="user",
        target_id=user_id,
        details={"role": membership.role},
    )
    await session.commit()


# ------------------------------------------------------------------ invitations
def _pending(now: datetime) -> list[ColumnElement[bool]]:
    return [
        Invitation.accepted_at.is_(None),
        Invitation.revoked_at.is_(None),
        Invitation.expires_at > now,
    ]


async def create_invitation(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    email: str,
    role: Role,
    actor_user_id: uuid.UUID,
    now: datetime,
    ttl: timedelta,
) -> tuple[Invitation, str]:
    """Invite ``email``. Returns the invitation and its token; the token is given
    out exactly once, here."""
    email = normalize_email(email)
    already_member = await session.scalar(
        select(Membership.user_id)
        .join(User, User.id == Membership.user_id)
        .where(Membership.org_id == org_id, User.email == email)
    )
    if already_member is not None:
        raise AppError(409, "already_member", "This person is already in the organisation.")

    # A new invitation replaces any earlier one for the same address: the old
    # link stops working, so only one link per person is ever live.
    await session.execute(
        update(Invitation)
        .where(
            Invitation.org_id == org_id,
            Invitation.email == email,
            Invitation.accepted_at.is_(None),
            Invitation.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )

    token = secrets.token_urlsafe(32)
    invitation = Invitation(
        org_id=org_id,
        email=email,
        role=role,
        token_hash=security.hash_token(token),
        invited_by=actor_user_id,
        expires_at=now + ttl,
    )
    session.add(invitation)
    await session.flush()
    audit.record(
        session,
        org_id=org_id,
        actor_user_id=actor_user_id,
        action="invitation.created",
        target_type="invitation",
        target_id=invitation.id,
        details={"email": email, "role": role},
    )
    await session.commit()
    return invitation, token


async def list_invitations(
    session: AsyncSession, org_id: uuid.UUID, *, now: datetime
) -> list[Invitation]:
    """Invitations still waiting for an answer."""
    result = await session.scalars(
        select(Invitation)
        .where(Invitation.org_id == org_id, *_pending(now))
        .order_by(Invitation.created_at.desc(), Invitation.id)
    )
    return list(result)


async def revoke_invitation(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    invitation_id: uuid.UUID,
    actor_user_id: uuid.UUID,
    now: datetime,
) -> None:
    invitation = await session.scalar(
        select(Invitation).where(Invitation.id == invitation_id, Invitation.org_id == org_id)
    )
    if invitation is None:
        raise AppError(404, "invitation_not_found", "No such invitation.")
    if invitation.accepted_at is None and invitation.revoked_at is None:
        invitation.revoked_at = now
        audit.record(
            session,
            org_id=org_id,
            actor_user_id=actor_user_id,
            action="invitation.revoked",
            target_type="invitation",
            target_id=invitation.id,
            details={"email": invitation.email},
        )
    await session.commit()


def _invitation_gone() -> AppError:
    # One answer for unknown, expired, revoked and already-used links.
    return AppError(404, "invitation_not_found", "This invitation link is not valid any more.")


async def find_pending_invitation(
    session: AsyncSession, token: str, *, now: datetime, lock: bool = False
) -> tuple[Invitation, Organization]:
    query = (
        select(Invitation, Organization)
        .join(Organization, Organization.id == Invitation.org_id)
        .where(Invitation.token_hash == security.hash_token(token), *_pending(now))
    )
    if lock:
        query = query.with_for_update(of=Invitation)
    row = (await session.execute(query)).first()
    if row is None:
        raise _invitation_gone()
    invitation, organization = row
    return invitation, organization


def _wrong_account() -> AppError:
    return AppError(
        403,
        "invitation_email_mismatch",
        "This invitation was sent to a different email address.",
    )


async def accept_invitation(
    session: AsyncSession, token: str, user: User, *, now: datetime
) -> Organization:
    """Add ``user`` to the inviting organisation. The link works once."""
    invitation, organization = await find_pending_invitation(session, token, now=now, lock=True)
    if invitation.email != user.email:
        raise _wrong_account()

    existing = await session.get(Membership, (user.id, invitation.org_id))
    if existing is None:
        session.add(Membership(user_id=user.id, org_id=invitation.org_id, role=invitation.role))
    invitation.accepted_at = now
    audit.record(
        session,
        org_id=invitation.org_id,
        actor_user_id=user.id,
        action="invitation.accepted",
        target_type="invitation",
        target_id=invitation.id,
        details={"email": invitation.email, "role": invitation.role},
    )
    await session.commit()
    return organization


async def register_with_invitation(
    session: AsyncSession, *, token: str, email: str, password: str, now: datetime
) -> User:
    """Create an account for someone who was invited. They join the inviting
    organisation directly, instead of being made to create one of their own."""
    email = normalize_email(email)
    invitation, _organization = await find_pending_invitation(session, token, now=now, lock=True)
    if invitation.email != email:
        raise _wrong_account()

    password_hash = await asyncio.to_thread(security.hash_password, password)
    user = User(email=email, password_hash=password_hash)
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        if "uq_users_email" in str(exc.orig):
            raise AppError(
                409,
                "email_taken",
                "An account with this email already exists. Log in to accept the invitation.",
            ) from exc
        raise

    session.add(Membership(user_id=user.id, org_id=invitation.org_id, role=invitation.role))
    invitation.accepted_at = now
    audit.record(
        session,
        org_id=invitation.org_id,
        actor_user_id=user.id,
        action="invitation.accepted",
        target_type="invitation",
        target_id=invitation.id,
        details={"email": email, "role": invitation.role, "new_account": True},
    )
    await session.commit()
    return user
