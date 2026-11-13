"""Manage the API keys a customer's backend uses to send events."""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from relay.api.deps import EditorDep, OrgDep, SessionDep, SettingsDep, utc_now
from relay.services import api_keys as api_key_service

router = APIRouter(prefix="/api-keys", tags=["api keys"])


class CreateApiKeyRequest(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class ApiKeyOut(BaseModel):
    """What the dashboard shows. Never includes the key or its hash."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    prefix: str
    last_used_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class ApiKeyCreated(ApiKeyOut):
    key: str = Field(description="The full API key. Shown once; store it now.")


@router.get("")
async def list_api_keys(context: OrgDep, session: SessionDep) -> list[ApiKeyOut]:
    keys = await api_key_service.list_api_keys(session, context.org_id)
    return [ApiKeyOut.model_validate(key) for key in keys]


@router.post("", status_code=201)
async def create_api_key(
    body: CreateApiKeyRequest, context: EditorDep, session: SessionDep, settings: SettingsDep
) -> ApiKeyCreated:
    api_key, key = await api_key_service.create_api_key(
        session,
        org_id=context.org_id,
        name=body.name,
        actor_user_id=context.user.id,
        live=settings.environment == "production",
    )
    return ApiKeyCreated(**ApiKeyOut.model_validate(api_key).model_dump(), key=key)


@router.delete("/{key_id}", status_code=204)
async def revoke_api_key(key_id: uuid.UUID, context: EditorDep, session: SessionDep) -> None:
    await api_key_service.revoke_api_key(
        session,
        org_id=context.org_id,
        key_id=key_id,
        actor_user_id=context.user.id,
        now=utc_now(),
    )
