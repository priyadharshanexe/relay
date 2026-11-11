"""Organisations the caller belongs to, and who else is in the current one."""

import uuid
from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import select

from relay.api.auth import OrganizationOut
from relay.api.deps import CurrentUser, OrgDep, SessionDep
from relay.db.models import Membership, User
from relay.domain.enums import Role
from relay.services import auth as auth_service

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
