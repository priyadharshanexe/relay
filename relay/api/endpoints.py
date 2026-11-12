"""Endpoint management routes (dashboard)."""

import uuid
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from relay.api.deps import (
    EditorDep,
    OrgContext,
    OrgDep,
    SecretBoxDep,
    SessionDep,
    SettingsDep,
    utc_now,
)
from relay.domain.enums import BreakerState, EndpointStatus
from relay.services import endpoints as endpoint_service
from relay.services import events as event_service
from relay.services.endpoints import Actor

router = APIRouter(prefix="/endpoints", tags=["endpoints"])

EventType = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.\-]{1,200}$")]
EventTypes = Annotated[list[EventType], Field(max_length=100)]
Url = Annotated[str, StringConstraints(min_length=1, max_length=2048, strip_whitespace=True)]
Description = Annotated[str, StringConstraints(max_length=500, strip_whitespace=True)]
RateLimit = Annotated[int, Field(ge=1, le=10_000)]


class CreateEndpointRequest(BaseModel):
    url: Url
    description: Description = ""
    event_types: EventTypes = Field(
        default_factory=list, description="Event types to receive. Empty means all."
    )
    rate_limit_per_sec: RateLimit | None = None


class UpdateEndpointRequest(BaseModel):
    """Send only the fields you want to change."""

    model_config = ConfigDict(extra="forbid")

    url: Url | None = None
    description: Description | None = None
    event_types: EventTypes | None = None
    rate_limit_per_sec: RateLimit | None = None


class EndpointOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    url: str
    description: str
    event_types: list[str]
    status: EndpointStatus
    rate_limit_per_sec: int | None
    breaker_state: BreakerState
    created_at: datetime
    updated_at: datetime


class EndpointCreated(EndpointOut):
    secret: str = Field(description="The signing secret. Shown once; store it now.")


class RotatedSecret(BaseModel):
    secret: str = Field(description="The new signing secret. Shown once; store it now.")
    previous_secret_expires_at: datetime


class TestEventSent(BaseModel):
    event_id: uuid.UUID


def _actor(context: OrgContext) -> Actor:
    return Actor(org_id=context.org_id, user_id=context.user.id)


@router.get("")
async def list_endpoints(context: OrgDep, session: SessionDep) -> list[EndpointOut]:
    endpoints = await endpoint_service.list_endpoints(session, context.org_id)
    return [EndpointOut.model_validate(endpoint) for endpoint in endpoints]


@router.post("", status_code=201)
async def create_endpoint(
    body: CreateEndpointRequest,
    context: EditorDep,
    session: SessionDep,
    settings: SettingsDep,
    box: SecretBoxDep,
) -> EndpointCreated:
    endpoint, secret = await endpoint_service.create_endpoint(
        session,
        _actor(context),
        url=body.url,
        description=body.description,
        event_types=body.event_types,
        rate_limit_per_sec=body.rate_limit_per_sec,
        settings=settings,
        box=box,
        now=utc_now(),
    )
    return EndpointCreated(**EndpointOut.model_validate(endpoint).model_dump(), secret=secret)


class EndpointHealthOut(BaseModel):
    endpoint_id: uuid.UUID
    attempts: int
    successes: int
    success_rate: float | None = Field(description="0 to 1; null when there were no attempts.")
    p95_ms: int | None


# Declared before /{endpoint_id} so "health" is not read as an id.
@router.get("/health")
async def endpoint_health(context: OrgDep, session: SessionDep) -> list[EndpointHealthOut]:
    """Success rate and p95 latency of each endpoint over the last 24 hours."""
    health = await endpoint_service.endpoint_health(
        session, context.org_id, since=utc_now() - timedelta(hours=24)
    )
    return [
        EndpointHealthOut(
            endpoint_id=item.endpoint_id,
            attempts=item.attempts,
            successes=item.successes,
            success_rate=item.success_rate,
            p95_ms=item.p95_ms,
        )
        for item in health
    ]


@router.get("/{endpoint_id}")
async def get_endpoint(endpoint_id: uuid.UUID, context: OrgDep, session: SessionDep) -> EndpointOut:
    endpoint = await endpoint_service.get_endpoint(session, context.org_id, endpoint_id)
    return EndpointOut.model_validate(endpoint)


@router.patch("/{endpoint_id}")
async def update_endpoint(
    endpoint_id: uuid.UUID,
    body: UpdateEndpointRequest,
    context: EditorDep,
    session: SessionDep,
    settings: SettingsDep,
) -> EndpointOut:
    # exclude_unset: "field not sent" (leave alone) differs from "sent as null"
    # (clear it), which matters for rate_limit_per_sec.
    changes = body.model_dump(exclude_unset=True)
    for required in ("url", "description", "event_types"):
        if required in changes and changes[required] is None:
            del changes[required]
    endpoint = await endpoint_service.update_endpoint(
        session, _actor(context), endpoint_id, changes, settings=settings
    )
    return EndpointOut.model_validate(endpoint)


@router.delete("/{endpoint_id}", status_code=204)
async def delete_endpoint(endpoint_id: uuid.UUID, context: EditorDep, session: SessionDep) -> None:
    await endpoint_service.delete_endpoint(session, _actor(context), endpoint_id)


@router.post("/{endpoint_id}/pause")
async def pause_endpoint(
    endpoint_id: uuid.UUID, context: EditorDep, session: SessionDep
) -> EndpointOut:
    """Stop sending to this endpoint. New events are still queued for it and are
    delivered after it is resumed."""
    endpoint = await endpoint_service.set_status(
        session, _actor(context), endpoint_id, EndpointStatus.PAUSED
    )
    return EndpointOut.model_validate(endpoint)


@router.post("/{endpoint_id}/resume")
async def resume_endpoint(
    endpoint_id: uuid.UUID, context: EditorDep, session: SessionDep
) -> EndpointOut:
    endpoint = await endpoint_service.set_status(
        session, _actor(context), endpoint_id, EndpointStatus.ACTIVE
    )
    return EndpointOut.model_validate(endpoint)


@router.post("/{endpoint_id}/rotate-secret")
async def rotate_secret(
    endpoint_id: uuid.UUID,
    context: EditorDep,
    session: SessionDep,
    settings: SettingsDep,
    box: SecretBoxDep,
) -> RotatedSecret:
    """Get a new signing secret. The previous one keeps working until
    ``previous_secret_expires_at``; until then messages carry both signatures."""
    secret, expires_at = await endpoint_service.rotate_secret(
        session, _actor(context), endpoint_id, settings=settings, box=box, now=utc_now()
    )
    return RotatedSecret(secret=secret, previous_secret_expires_at=expires_at)


@router.post("/{endpoint_id}/test", status_code=202)
async def send_test_event(
    endpoint_id: uuid.UUID, context: EditorDep, session: SessionDep
) -> TestEventSent:
    """Queue a ``relay.test`` event for this endpoint only."""
    endpoint = await endpoint_service.get_endpoint(session, context.org_id, endpoint_id)
    result = await event_service.create_event(
        session,
        org_id=context.org_id,
        event_type=event_service.TEST_EVENT_TYPE,
        payload={"message": "This is a test event from Relay.", "endpoint_id": str(endpoint.id)},
        idempotency_key=None,
        only_endpoint_id=endpoint.id,
    )
    return TestEventSent(event_id=result.event.id)
