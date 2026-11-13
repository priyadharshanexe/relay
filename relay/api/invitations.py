"""Looking at and accepting an invitation.

``GET`` needs no login: someone who was invited has no account yet, and must be
able to see who invited them before deciding to create one. It reveals only the
organisation's name, the invited address and the role, and only to whoever holds
the unguessable link.
"""

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel

from relay.api.auth import OrganizationOut
from relay.api.deps import CurrentUser, SessionDep, utc_now
from relay.domain.enums import Role
from relay.services import members as member_service

router = APIRouter(prefix="/invitations", tags=["team"])


class InvitationInfo(BaseModel):
    organization_name: str
    email: str
    role: Role
    expires_at: datetime


@router.get("/{token}")
async def get_invitation(token: str, session: SessionDep) -> InvitationInfo:
    invitation, organization = await member_service.find_pending_invitation(
        session, token, now=utc_now()
    )
    return InvitationInfo(
        organization_name=organization.name,
        email=invitation.email,
        role=Role(invitation.role),
        expires_at=invitation.expires_at,
    )


@router.post("/{token}/accept")
async def accept_invitation(token: str, user: CurrentUser, session: SessionDep) -> OrganizationOut:
    """Join the organisation. You must be logged in as the invited address."""
    invitation, _ = await member_service.find_pending_invitation(session, token, now=utc_now())
    role = Role(invitation.role)
    organization = await member_service.accept_invitation(session, token, user, now=utc_now())
    return OrganizationOut(id=organization.id, name=organization.name, role=role)
