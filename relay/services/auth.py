"""Sign-up, login and dashboard sessions.

A session is two tokens:

* an **access token** (JWT, 15 minutes) sent with every request, and
* a **refresh token** (random, 30 days) used only to get a new access token.

Refresh tokens rotate: using one returns a replacement and retires the old one.
If a retired token is ever presented again, someone has a copy they shouldn't,
so every token in that family is revoked and the user must log in again.
"""

import asyncio
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core import security
from relay.core.config import Settings
from relay.core.errors import AppError
from relay.core.logging import get_logger
from relay.db.models import Membership, Organization, RefreshToken, User
from relay.domain.enums import Role
from relay.services import audit

log = get_logger("relay.auth")


@dataclass(frozen=True, slots=True)
class SessionTokens:
    access_token: str
    refresh_token: str


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _invalid_credentials() -> AppError:
    # One message for "no such user" and "wrong password": never reveal which.
    return AppError(401, "invalid_credentials", "The email or password is incorrect.")


def _invalid_session() -> AppError:
    return AppError(401, "invalid_session", "Your session has ended. Please log in again.")


async def register(
    session: AsyncSession, *, email: str, password: str, organization_name: str
) -> User:
    """Create a user, their first organisation, and make them its owner."""
    email = normalize_email(email)
    # Argon2 is CPU-heavy by design; run it off the event loop.
    password_hash = await asyncio.to_thread(security.hash_password, password)

    user = User(email=email, password_hash=password_hash)
    organization = Organization(name=organization_name.strip())
    session.add_all([user, organization])
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        if "uq_users_email" in str(exc.orig):
            raise AppError(
                409, "email_taken", "An account with this email already exists."
            ) from exc
        raise

    session.add(Membership(user_id=user.id, org_id=organization.id, role=Role.OWNER))
    audit.record(
        session,
        org_id=organization.id,
        actor_user_id=user.id,
        action="organization.created",
        target_type="organization",
        target_id=organization.id,
    )
    await session.commit()
    log.info("auth.registered", user_id=str(user.id), org_id=str(organization.id))
    return user


async def authenticate(session: AsyncSession, *, email: str, password: str) -> User:
    user = await session.scalar(select(User).where(User.email == normalize_email(email)))
    password_hash = user.password_hash if user else security.dummy_password_hash()
    password_ok = await asyncio.to_thread(security.verify_password, password_hash, password)
    if user is None or not password_ok:
        raise _invalid_credentials()
    return user


def _issue(
    session: AsyncSession,
    user_id: uuid.UUID,
    family_id: uuid.UUID,
    settings: Settings,
    now: datetime,
) -> SessionTokens:
    refresh_token, token_hash = security.new_refresh_token()
    session.add(
        RefreshToken(
            user_id=user_id,
            family_id=family_id,
            token_hash=token_hash,
            expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
        )
    )
    access_token = security.create_access_token(
        user_id,
        secret=settings.jwt_secret.get_secret_value(),
        ttl=timedelta(seconds=settings.access_token_ttl_seconds),
        now=now,
    )
    return SessionTokens(access_token, refresh_token)


async def start_session(
    session: AsyncSession, user: User, settings: Settings, *, now: datetime
) -> SessionTokens:
    tokens = _issue(session, user.id, uuid.uuid4(), settings, now)
    await session.commit()
    return tokens


async def rotate_session(
    session: AsyncSession, refresh_token: str, settings: Settings, *, now: datetime
) -> tuple[User, SessionTokens]:
    """Exchange a refresh token for a new pair. Each token works exactly once."""
    token_hash = security.hash_token(refresh_token)

    # One atomic statement: of two simultaneous requests with the same token,
    # only one can flip used_at from NULL.
    claimed = (
        await session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.token_hash == token_hash,
                RefreshToken.used_at.is_(None),
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > now,
            )
            .values(used_at=now)
            .returning(RefreshToken.user_id, RefreshToken.family_id)
        )
    ).first()

    if claimed is None:
        existing = await session.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == token_hash)
        )
        if existing is not None and existing.used_at is not None and existing.revoked_at is None:
            await _revoke_family(session, existing.family_id, now)
            await session.commit()
            log.warning(
                "auth.refresh_token_reuse",
                user_id=str(existing.user_id),
                family_id=str(existing.family_id),
            )
        raise _invalid_session()

    user = await session.get(User, claimed.user_id)
    if user is None:
        raise _invalid_session()
    tokens = _issue(session, user.id, claimed.family_id, settings, now)
    await session.commit()
    return user, tokens


async def end_session(session: AsyncSession, refresh_token: str | None, *, now: datetime) -> None:
    """Log out: revoke every refresh token in this session's family."""
    if not refresh_token:
        return
    existing = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == security.hash_token(refresh_token))
    )
    if existing is not None:
        await _revoke_family(session, existing.family_id, now)
        await session.commit()


async def _revoke_family(session: AsyncSession, family_id: uuid.UUID, now: datetime) -> None:
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )


async def list_memberships(
    session: AsyncSession, user_id: uuid.UUID
) -> list[tuple[Organization, Role]]:
    rows = await session.execute(
        select(Organization, Membership.role)
        .join(Membership, Membership.org_id == Organization.id)
        .where(Membership.user_id == user_id)
        .order_by(Membership.created_at, Organization.id)
    )
    return [(organization, Role(role)) for organization, role in rows]
