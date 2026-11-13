"""Event ingestion (API key) and browsing (dashboard)."""

import json
import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Header, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from relay.api.deps import ApiKeyDep, OrgDep, SessionDep, SettingsDep
from relay.api.endpoints import EventType
from relay.api.pagination import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, Page, encode_cursor, newest_first
from relay.core.errors import AppError
from relay.db.models import Event
from relay.services import events as event_service

router = APIRouter(prefix="/events", tags=["events"])


class EventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: EventType = Field(examples=["order.paid"])
    payload: dict[str, Any] = Field(examples=[{"order_id": 42, "amount": 1999}])


class EventAccepted(BaseModel):
    id: uuid.UUID
    type: str
    created_at: datetime
    deliveries: int = Field(description="How many endpoints this event is being delivered to.")


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    type: str
    payload: dict[str, Any]
    idempotency_key: str | None
    created_at: datetime


async def _read_body(request: Request, limit: int) -> bytes:
    """Read the body, refusing anything over ``limit`` without buffering it all."""
    too_large = AppError(
        413,
        "payload_too_large",
        f"The request body may be at most {limit} bytes.",
        {"limit": limit},
    )
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise too_large
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:  # Content-Length was missing or lied
            raise too_large
    return bytes(body)


def _reject(message: str, error_type: str) -> AppError:
    details = [{"loc": ["body", "payload"], "msg": message, "type": error_type}]
    return AppError(422, "validation_error", "The request is not valid.", details)


def _check_storable(payload: dict[str, Any]) -> None:
    """Refuse payloads that are valid for Python but not for JSON or PostgreSQL.

    Without this they fail deep inside the database driver and surface as a 500.
    """
    try:
        # allow_nan=False: Infinity and NaN (e.g. from 1e999) are not JSON.
        encoded = json.dumps(payload, allow_nan=False)
    except ValueError as exc:
        raise _reject(
            "The payload contains a number that is not valid JSON (Infinity or NaN).",
            "payload_not_finite",
        ) from exc
    if "\\u0000" in encoded:
        # PostgreSQL's jsonb cannot store the NUL character.
        raise _reject("The payload must not contain NUL characters.", "payload_nul_character")


def _parse_event(body: bytes) -> EventIn:
    try:
        event = EventIn.model_validate_json(body)
        _check_storable(event.payload)
        return event
    except ValidationError as exc:
        details = [
            {"loc": ["body", *error["loc"]], "msg": error["msg"], "type": error["type"]}
            for error in exc.errors(include_input=False, include_url=False, include_context=False)
        ]
        raise AppError(422, "validation_error", "The request is not valid.", details) from exc


@router.post(
    "",
    status_code=201,
    responses={
        200: {"model": EventAccepted, "description": "Idempotency-Key repeated: original event"},
        409: {"description": "Idempotency-Key reused with a different event"},
        413: {"description": "Body larger than the limit"},
    },
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": EventIn.model_json_schema()}},
        }
    },
)
async def ingest_event(
    request: Request,
    response: Response,
    context: ApiKeyDep,
    session: SessionDep,
    settings: SettingsDep,
    idempotency_key: Annotated[
        str | None,
        Header(
            min_length=1,
            max_length=255,
            pattern=r"^[\x21-\x7e]+$",
            description="Repeat a request safely: the same key returns the original event.",
        ),
    ] = None,
) -> EventAccepted:
    """Accept an event and queue it for delivery to every subscribed endpoint.

    Returns as soon as the event is stored. Delivery happens in the background.
    """
    event_in = _parse_event(await _read_body(request, settings.max_event_bytes))
    result = await event_service.create_event(
        session,
        org_id=context.org_id,
        event_type=event_in.type,
        payload=event_in.payload,
        idempotency_key=idempotency_key,
    )
    if result.replayed:
        response.status_code = 200
        response.headers["Idempotent-Replayed"] = "true"
    return EventAccepted(
        id=result.event.id,
        type=result.event.type,
        created_at=result.event.created_at,
        deliveries=result.deliveries_created,
    )


@router.get("")
async def list_events(
    context: OrgDep,
    session: SessionDep,
    type: Annotated[EventType | None, Query(description="Only this event type")] = None,
    since: Annotated[
        datetime | None, Query(description="Only events at or after this time")
    ] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = DEFAULT_PAGE_SIZE,
) -> Page[EventOut]:
    query = newest_first(
        event_service.events_query(context.org_id, event_type=type, since=since),
        Event.created_at,
        Event.id,
        cursor=cursor,
        limit=limit,
    )
    rows = list(await session.scalars(query))
    page, has_more = rows[:limit], len(rows) > limit
    return Page[EventOut](
        items=[EventOut.model_validate(event) for event in page],
        next_cursor=encode_cursor(page[-1].created_at, page[-1].id) if has_more else None,
    )


@router.get("/{event_id}")
async def get_event(event_id: uuid.UUID, context: OrgDep, session: SessionDep) -> EventOut:
    return EventOut.model_validate(await event_service.get_event(session, context.org_id, event_id))
