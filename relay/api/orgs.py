"""Organisations the caller belongs to, and who else is in the current one."""

import uuid
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr, Field, StringConstraints
from sqlalchemy import select

from relay.api.auth import OrganizationOut
from relay.api.deps import (
    CurrentUser,
    OrgDep,
    OwnerDep,
    SessionDep,
    SettingsDep,
    utc_now,
)
from relay.db.models import Membership, User
from relay.domain.enums import Role
from relay.services import auth as auth_service
from relay.services import members as member_service

router = APIRouter(prefix="/orgs", tags=["organisations"])


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    role: Role
    joined_at: datetime


@router.get("")
async def list_my_organizations(user: CurrentUser, session: SessionDep) -> list[OrganizationOut]:
    memberships = await auth_service.list_memberships(session, user.id)
    return [
        OrganizationOut(id=organization.id, name=organization.name, role=role)
        for organization, role in memberships
    ]


@router.get("/current/members")
async def list_members(context: OrgDep, session: SessionDep) -> list[MemberOut]:
    """Members of the organisation selected by ``X-Org-ID`` (or your first one)."""
    rows = await session.execute(
        select(User.id, User.email, Membership.role, Membership.created_at)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.org_id == context.org_id)
        .order_by(Membership.created_at, User.id)
    )
    return [
        MemberOut(user_id=user_id, email=email, role=Role(role), joined_at=joined_at)
        for user_id, email, role, joined_at in rows
    ]


# ----------------------------------------------------------- owner-only routes
class RenameOrganizationRequest(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class ChangeRoleRequest(BaseModel):
    role: Role


class CreateInvitationRequest(BaseModel):
    email: EmailStr
    role: Role = Role.DEVELOPER


class InvitationOut(BaseModel):
    id: uuid.UUID
    email: str
    role: Role
    expires_at: datetime
    created_at: datetime


class InvitationCreated(InvitationOut):
    token: str = Field(
        description="Goes in the invitation link. Shown once; it cannot be recovered."
    )


@router.patch("/current")
async def rename_organization(
    body: RenameOrganizationRequest, context: OwnerDep, session: SessionDep
) -> OrganizationOut:
    organization = await member_service.rename_organization(
        session, org_id=context.org_id, name=body.name, actor_user_id=context.user.id
    )
    return OrganizationOut(id=organization.id, name=organization.name, role=context.role)


@router.patch("/current/members/{user_id}")
async def change_member_role(
    user_id: uuid.UUID, body: ChangeRoleRequest, context: OwnerDep, session: SessionDep
) -> MemberOut:
    membership = await member_service.change_role(
        session,
        org_id=context.org_id,
        user_id=user_id,
        role=body.role,
        actor_user_id=context.user.id,
    )
    user = await session.get_one(User, user_id)
    return MemberOut(
        user_id=user.id,
        email=user.email,
        role=Role(membership.role),
        joined_at=membership.created_at,
    )


@router.delete("/current/members/{user_id}", status_code=204)
async def remove_member(user_id: uuid.UUID, context: OwnerDep, session: SessionDep) -> None:
    await member_service.remove_member(
        session, org_id=context.org_id, user_id=user_id, actor_user_id=context.user.id
    )


@router.get("/current/invitations")
async def list_invitations(context: OwnerDep, session: SessionDep) -> list[InvitationOut]:
    invitations = await member_service.list_invitations(session, context.org_id, now=utc_now())
    return [
        InvitationOut(
            id=invitation.id,
            email=invitation.email,
            role=Role(invitation.role),
            expires_at=invitation.expires_at,
            created_at=invitation.created_at,
        )
        for invitation in invitations
    ]


@router.post("/current/invitations", status_code=201)
async def create_invitation(
    body: CreateInvitationRequest, context: OwnerDep, session: SessionDep, settings: SettingsDep
) -> InvitationCreated:
    """Invite someone by email address. The response carries the link's token,
    once: build the link, send it to them, and it cannot be shown again."""
    invitation, token = await member_service.create_invitation(
        session,
        org_id=context.org_id,
        email=body.email,
        role=body.role,
        actor_user_id=context.user.id,
        now=utc_now(),
        ttl=timedelta(days=settings.invitation_ttl_days),
    )
    return InvitationCreated(
        id=invitation.id,
        email=invitation.email,
        role=Role(invitation.role),
        expires_at=invitation.expires_at,
        created_at=invitation.created_at,
        token=token,
    )


@router.delete("/current/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(
    invitation_id: uuid.UUID, context: OwnerDep, session: SessionDep
) -> None:
    await member_service.revoke_invitation(
        session,
        org_id=context.org_id,
        invitation_id=invitation_id,
        actor_user_id=context.user.id,
        now=utc_now(),
    )
