"""Built-in test receivers: management routes and the receiver itself."""

import asyncio
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from relay.api.deps import EditorDep, OrgDep, SessionDep, SettingsDep, utc_now
from relay.core.config import Settings
from relay.core.errors import AppError
from relay.db.models import TestReceiver
from relay.domain.enums import ReceiverMode
from relay.services import receivers as receiver_service

# Dashboard routes, mounted under /v1.
router = APIRouter(prefix="/receivers", tags=["test receivers"])
# The receiver itself, mounted at the root: POST /receiver/{token}.
public_router = APIRouter(tags=["test receivers"])

Name = Annotated[str, StringConstraints(min_length=1, max_length=200, strip_whitespace=True)]
ErrorStatus = Annotated[int, Field(ge=400, le=599)]
DelayMs = Annotated[int, Field(ge=0, le=30_000)]
RetryAfter = Annotated[int, Field(ge=0, le=86_400)]


class CreateReceiverRequest(BaseModel):
    name: Name
    mode: ReceiverMode = ReceiverMode.OK
    status_code: ErrorStatus = Field(default=500, description="Used when mode is 'error'.")
    delay_ms: DelayMs = Field(default=2000, description="Used when mode is 'slow'.")
    retry_after_seconds: RetryAfter = Field(
        default=30, description="Used when mode is 'rate_limit'."
    )


class UpdateReceiverRequest(BaseModel):
    """Send only the fields you want to change."""

    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    mode: ReceiverMode | None = None
    status_code: ErrorStatus | None = None
    delay_ms: DelayMs | None = None
    retry_after_seconds: RetryAfter | None = None


class ReceiverOut(BaseModel):
    id: uuid.UUID
    name: str
    url: str = Field(description="Use this as an endpoint URL.")
    mode: ReceiverMode
    status_code: int
    delay_ms: int
    retry_after_seconds: int
    requests_received: int
    last_received_at: datetime | None
    created_at: datetime


def _out(receiver: TestReceiver, settings: Settings) -> ReceiverOut:
    return ReceiverOut(
        id=receiver.id,
        name=receiver.name,
        url=settings.receiver_url_prefix + receiver.token,
        mode=ReceiverMode(receiver.mode),
        status_code=receiver.status_code,
        delay_ms=receiver.delay_ms,
        retry_after_seconds=receiver.retry_after_seconds,
        requests_received=receiver.requests_received,
        last_received_at=receiver.last_received_at,
        created_at=receiver.created_at,
    )


@router.get("")
async def list_receivers(
    context: OrgDep, session: SessionDep, settings: SettingsDep
) -> list[ReceiverOut]:
    receivers = await receiver_service.list_receivers(session, context.org_id)
    return [_out(receiver, settings) for receiver in receivers]


@router.post("", status_code=201)
async def create_receiver(
    body: CreateReceiverRequest, context: EditorDep, session: SessionDep, settings: SettingsDep
) -> ReceiverOut:
    receiver = await receiver_service.create_receiver(
        session, org_id=context.org_id, fields=body.model_dump()
    )
    return _out(receiver, settings)


@router.patch("/{receiver_id}")
async def update_receiver(
    receiver_id: uuid.UUID,
    body: UpdateReceiverRequest,
    context: EditorDep,
    session: SessionDep,
    settings: SettingsDep,
) -> ReceiverOut:
    """Change how the receiver answers, e.g. switch it from 'error' to 'ok'."""
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    receiver = await receiver_service.update_receiver(session, context.org_id, receiver_id, changes)
    return _out(receiver, settings)


@router.delete("/{receiver_id}", status_code=204)
async def delete_receiver(receiver_id: uuid.UUID, context: EditorDep, session: SessionDep) -> None:
    await receiver_service.delete_receiver(session, context.org_id, receiver_id)


@public_router.post("/receiver/{token}", include_in_schema=True)
async def receive(
    token: str, request: Request, session: SessionDep, settings: SettingsDep
) -> Response:
    """The fake customer server. Answers according to the receiver's settings."""
    receiver = await receiver_service.record_request(session, token, now=utc_now())
    if receiver is None:
        raise AppError(404, "receiver_not_found", "No such test receiver.")
    mode = ReceiverMode(receiver.mode)
    # Copy what we need and give the database connection back before any sleep.
    status_code, delay_ms, retry_after = (
        receiver.status_code,
        receiver.delay_ms,
        receiver.retry_after_seconds,
    )
    await session.close()

    if mode is ReceiverMode.ERROR:
        return JSONResponse({"received": True, "mode": mode}, status_code=status_code)
    if mode is ReceiverMode.RATE_LIMIT:
        return JSONResponse(
            {"received": True, "mode": mode},
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )
    if mode is ReceiverMode.SLOW:
        await asyncio.sleep(delay_ms / 1000)
    elif mode is ReceiverMode.TIMEOUT:
        # Longer than the sender waits, so the sender records a timeout.
        await asyncio.sleep(settings.receiver_hold)
    return JSONResponse({"received": True, "mode": mode})
