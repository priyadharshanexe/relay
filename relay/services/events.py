"""Event ingestion: the transactional outbox.

``create_event`` does two things in ONE database transaction:

1. insert the event,
2. insert one delivery row for every endpoint subscribed to that event type.

Either both are committed or neither is. There is no moment where an event is
saved but its deliveries are not queued, which is the classic way systems that
"save, then publish to a queue" lose messages when they crash in between.

Nothing here talks to a customer's server. Ingestion only writes rows; the workers
pick the deliveries up afterwards. So a slow or dead receiver can never slow down
the API.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from sqlalchemy import CursorResult, func, insert, literal, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core import metrics
from relay.core.errors import AppError
from relay.core.telemetry import current_traceparent
from relay.db.models import Delivery, Endpoint, Event
from relay.domain.enums import EndpointStatus

TEST_EVENT_TYPE = "relay.test"

# Paused endpoints still get deliveries queued (they wait until resume), so
# pausing never loses events. Disabled endpoints get nothing.
_RECEIVING_STATUSES = (EndpointStatus.ACTIVE, EndpointStatus.PAUSED)


@dataclass(frozen=True, slots=True)
class IngestResult:
    event: Event
    deliveries_created: int
    # True when this request repeated an Idempotency-Key and nothing new was stored.
    replayed: bool


async def create_event(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    event_type: str,
    payload: dict[str, Any],
    idempotency_key: str | None,
    only_endpoint_id: uuid.UUID | None = None,
) -> IngestResult:
    """Store an event and queue its deliveries atomically.

    ``only_endpoint_id`` sends the event to that one endpoint regardless of its
    subscriptions; it is how "send test event" works.
    """
    event_id = uuid.uuid4()

    # INSERT ... ON CONFLICT DO NOTHING: the unique index on
    # (org_id, idempotency_key) decides the winner. If another request with the
    # same key is mid-transaction, this statement waits for it, then inserts
    # nothing. A "SELECT first, then INSERT" would let both requests through.
    inserted = (
        await session.execute(
            pg_insert(Event)
            .values(
                id=event_id,
                org_id=org_id,
                type=event_type,
                payload=payload,
                idempotency_key=idempotency_key,
                traceparent=current_traceparent(),
            )
            .on_conflict_do_nothing(index_elements=[Event.org_id, Event.idempotency_key])
            .returning(Event.id)
        )
    ).first()

    if inserted is None:
        await session.rollback()
        return await _replay(session, org_id, event_type, payload, idempotency_key)

    subscribed = select(literal(org_id), literal(event_id), Endpoint.id).where(
        Endpoint.org_id == org_id
    )
    if only_endpoint_id is not None:
        subscribed = subscribed.where(Endpoint.id == only_endpoint_id)
    else:
        subscribed = subscribed.where(
            Endpoint.status.in_(_RECEIVING_STATUSES),
            or_(
                func.cardinality(Endpoint.event_types) == 0,  # subscribed to everything
                Endpoint.event_types.contains([event_type]),
            ),
        )
    # One INSERT ... SELECT: however many endpoints match, it is a single statement.
    queued = cast(
        CursorResult[Any],
        await session.execute(
            insert(Delivery).from_select(
                [Delivery.org_id, Delivery.event_id, Delivery.endpoint_id],
                subscribed,
                # Let Postgres generate each row's id. With Python-side defaults
                # SQLAlchemy would compute ONE uuid and reuse it for every row.
                include_defaults=False,
            )
        ),
    )

    await session.commit()
    metrics.EVENTS_INGESTED.inc()
    event = await session.get_one(Event, event_id)
    return IngestResult(event, deliveries_created=queued.rowcount, replayed=False)


async def _replay(
    session: AsyncSession,
    org_id: uuid.UUID,
    event_type: str,
    payload: dict[str, Any],
    idempotency_key: str | None,
) -> IngestResult:
    existing = await session.scalar(
        select(Event).where(Event.org_id == org_id, Event.idempotency_key == idempotency_key)
    )
    if existing is None:  # pragma: no cover - the conflicting row was just deleted
        raise AppError(409, "idempotency_conflict", "Please retry the request.")

    # The same key must mean the same request. Reusing a key for different data
    # is a client bug; answering with the old event would hide it.
    if existing.type != event_type or existing.payload != payload:
        raise AppError(
            409,
            "idempotency_key_reused",
            "This Idempotency-Key was already used with a different event.",
            {"event_id": str(existing.id)},
        )
    deliveries = await session.scalar(
        select(func.count()).select_from(Delivery).where(Delivery.event_id == existing.id)
    )
    return IngestResult(existing, deliveries_created=int(deliveries or 0), replayed=True)


async def get_event(session: AsyncSession, org_id: uuid.UUID, event_id: uuid.UUID) -> Event:
    event = await session.scalar(select(Event).where(Event.id == event_id, Event.org_id == org_id))
    if event is None:
        raise AppError(404, "event_not_found", "No such event.")
    return event


def events_query(org_id: uuid.UUID, *, event_type: str | None, since: datetime | None) -> Any:
    query = select(Event).where(Event.org_id == org_id)
    if event_type is not None:
        query = query.where(Event.type == event_type)
    if since is not None:
        query = query.where(Event.created_at >= since)
    return query
