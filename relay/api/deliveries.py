"""Delivery explorer, attempt log and replay (dashboard)."""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field

from relay.api.deps import EditorDep, OrgDep, SessionDep, utc_now
from relay.api.endpoints import EventType
from relay.api.pagination import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, Page, encode_cursor, newest_first
from relay.db.models import Delivery
from relay.domain.enums import DeliveryStatus, ErrorKind
from relay.services import deliveries as delivery_service
from relay.services.deliveries import DeliveryFilter

router = APIRouter(prefix="/deliveries", tags=["deliveries"])


class DeliveryOut(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    event_type: str
    endpoint_id: uuid.UUID
    endpoint_url: str
    status: DeliveryStatus
    attempts: int
    next_attempt_at: datetime
    last_error: str | None
    created_at: datetime
    updated_at: datetime


class AttemptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    attempt_number: int
    started_at: datetime
    duration_ms: int
    status_code: int | None
    error_kind: ErrorKind | None
    response_snippet: str | None
    request_headers: dict[str, Any]
    response_headers: dict[str, Any] | None


class DeliveryDetail(DeliveryOut):
    payload: dict[str, Any]
    attempt_log: list[AttemptOut]


class BulkReplayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: DeliveryStatus = DeliveryStatus.DEAD
    endpoint_id: uuid.UUID | None = None
    event_type: EventType | None = None
    created_from: datetime | None = Field(default=None, alias="from")
    created_to: datetime | None = Field(default=None, alias="to")


class BulkReplayResult(BaseModel):
    replayed: int


def _out(delivery: Delivery, event_type: str, endpoint_url: str) -> DeliveryOut:
    return DeliveryOut(
        id=delivery.id,
        event_id=delivery.event_id,
        event_type=event_type,
        endpoint_id=delivery.endpoint_id,
        endpoint_url=endpoint_url,
        status=DeliveryStatus(delivery.status),
        attempts=delivery.attempts,
        next_attempt_at=delivery.next_attempt_at,
        last_error=delivery.last_error,
        created_at=delivery.created_at,
        updated_at=delivery.updated_at,
    )


@router.get("")
async def list_deliveries(
    context: OrgDep,
    session: SessionDep,
    status: DeliveryStatus | None = None,
    endpoint_id: uuid.UUID | None = None,
    event_type: EventType | None = None,
    created_from: Annotated[datetime | None, Query(alias="from")] = None,
    created_to: Annotated[datetime | None, Query(alias="to")] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
) -> Page[DeliveryOut]:
    """Deliveries, newest first. Use ``status=dead`` for the dead-letter queue."""
    filters = DeliveryFilter(status, endpoint_id, event_type, created_from, created_to)
    query = newest_first(
        delivery_service.deliveries_query(context.org_id, filters),
        Delivery.created_at,
        Delivery.id,
        cursor=cursor,
        limit=limit,
    )
    rows = (await session.execute(query)).all()
    page, has_more = rows[:limit], len(rows) > limit
    return Page[DeliveryOut](
        items=[_out(delivery, event_type, url) for delivery, event_type, url in page],
        next_cursor=encode_cursor(page[-1][0].created_at, page[-1][0].id) if has_more else None,
    )


# Declared before /{delivery_id} routes so "replay" is not read as an id.
@router.post("/replay")
async def replay_matching(
    body: BulkReplayRequest, context: EditorDep, session: SessionDep
) -> BulkReplayResult:
    """Replay every delivery matching the filter (by default, everything dead)."""
    count = await delivery_service.replay_matching(
        session,
        org_id=context.org_id,
        filters=DeliveryFilter(
            body.status, body.endpoint_id, body.event_type, body.created_from, body.created_to
        ),
        actor_user_id=context.user.id,
        now=utc_now(),
    )
    return BulkReplayResult(replayed=count)


@router.get("/{delivery_id}")
async def get_delivery(
    delivery_id: uuid.UUID, context: OrgDep, session: SessionDep
) -> DeliveryDetail:
    """One delivery with its payload and every attempt made so far."""
    delivery, event, endpoint, attempts = await delivery_service.get_delivery(
        session, context.org_id, delivery_id
    )
    return DeliveryDetail(
        **_out(delivery, event.type, endpoint.url).model_dump(),
        payload=event.payload,
        attempt_log=[AttemptOut.model_validate(attempt) for attempt in attempts],
    )


@router.post("/{delivery_id}/replay")
async def replay_delivery(
    delivery_id: uuid.UUID, context: EditorDep, session: SessionDep
) -> DeliveryOut:
    """Send a dead or succeeded delivery again, with a fresh retry schedule."""
    await delivery_service.replay_delivery(
        session,
        org_id=context.org_id,
        delivery_id=delivery_id,
        actor_user_id=context.user.id,
        now=utc_now(),
    )
    delivery, event, endpoint, _ = await delivery_service.get_delivery(
        session, context.org_id, delivery_id
    )
    return _out(delivery, event.type, endpoint.url)
