"""Browsing deliveries and replaying them."""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast

from sqlalchemy import CursorResult, Select, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core.errors import AppError
from relay.db.models import Attempt, Delivery, Endpoint, Event
from relay.domain.enums import DeliveryStatus
from relay.services import audit

# Only finished deliveries can be replayed. One that is pending, retrying or in
# flight is already on its way; "replaying" it would just reset its history.
REPLAYABLE = (DeliveryStatus.DEAD, DeliveryStatus.SUCCEEDED)


@dataclass(frozen=True, slots=True)
class DeliveryFilter:
    status: DeliveryStatus | None = None
    endpoint_id: uuid.UUID | None = None
    event_type: str | None = None
    created_from: datetime | None = None
    created_to: datetime | None = None


def _conditions(org_id: uuid.UUID, filters: DeliveryFilter) -> list[Any]:
    # org_id comes first, always: this is the tenancy boundary.
    conditions: list[Any] = [Delivery.org_id == org_id]
    if filters.status is not None:
        conditions.append(Delivery.status == filters.status)
    if filters.endpoint_id is not None:
        conditions.append(Delivery.endpoint_id == filters.endpoint_id)
    if filters.created_from is not None:
        conditions.append(Delivery.created_at >= filters.created_from)
    if filters.created_to is not None:
        conditions.append(Delivery.created_at < filters.created_to)
    if filters.event_type is not None:
        conditions.append(
            Delivery.event_id.in_(
                select(Event.id).where(Event.org_id == org_id, Event.type == filters.event_type)
            )
        )
    return conditions


def deliveries_query(org_id: uuid.UUID, filters: DeliveryFilter) -> Select[Delivery, str, str]:
    """Deliveries with their event type and endpoint URL."""
    return (
        select(Delivery, Event.type, Endpoint.url)
        .join(Event, Event.id == Delivery.event_id)
        .join(Endpoint, Endpoint.id == Delivery.endpoint_id)
        .where(*_conditions(org_id, filters))
    )


async def get_delivery(
    session: AsyncSession, org_id: uuid.UUID, delivery_id: uuid.UUID
) -> tuple[Delivery, Event, Endpoint, list[Attempt]]:
    row = (
        await session.execute(
            select(Delivery, Event, Endpoint)
            .join(Event, Event.id == Delivery.event_id)
            .join(Endpoint, Endpoint.id == Delivery.endpoint_id)
            .where(Delivery.id == delivery_id, Delivery.org_id == org_id)
        )
    ).first()
    if row is None:
        raise AppError(404, "delivery_not_found", "No such delivery.")
    delivery, event, endpoint = row
    attempts = await session.scalars(
        select(Attempt)
        .where(Attempt.delivery_id == delivery.id)
        .order_by(Attempt.started_at, Attempt.attempt_number)
    )
    return delivery, event, endpoint, list(attempts)


def _requeue(now: datetime) -> dict[str, Any]:
    """A replay is a fresh start: full retry schedule, due immediately. The old
    attempts stay in the log."""
    return {
        "status": DeliveryStatus.PENDING,
        "attempts": 0,
        "next_attempt_at": now,
        "locked_until": None,
        "locked_by": None,
        "last_error": None,
    }


async def replay_delivery(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    delivery_id: uuid.UUID,
    actor_user_id: uuid.UUID,
    now: datetime,
) -> Delivery:
    # The status check is in the UPDATE itself, so a delivery that a worker picks
    # up at this very moment cannot also be reset by us.
    replayed = (
        await session.execute(
            update(Delivery)
            .where(
                Delivery.id == delivery_id,
                Delivery.org_id == org_id,
                Delivery.status.in_(REPLAYABLE),
            )
            .values(**_requeue(now))
            .returning(Delivery)
        )
    ).scalar_one_or_none()

    if replayed is None:
        exists = await session.scalar(
            select(Delivery.status).where(Delivery.id == delivery_id, Delivery.org_id == org_id)
        )
        if exists is None:
            raise AppError(404, "delivery_not_found", "No such delivery.")
        raise AppError(
            409,
            "delivery_not_replayable",
            f"This delivery is {exists}; only dead or succeeded deliveries can be replayed.",
        )

    audit.record(
        session,
        org_id=org_id,
        actor_user_id=actor_user_id,
        action="delivery.replayed",
        target_type="delivery",
        target_id=delivery_id,
    )
    await session.commit()
    return replayed


async def replay_matching(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    filters: DeliveryFilter,
    actor_user_id: uuid.UUID,
    now: datetime,
) -> int:
    """Replay every dead (or succeeded) delivery matching ``filters``."""
    if filters.status not in REPLAYABLE:
        raise AppError(
            422, "invalid_replay_status", "Bulk replay needs status 'dead' or 'succeeded'."
        )
    result = cast(
        CursorResult[Any],
        await session.execute(
            update(Delivery).where(*_conditions(org_id, filters)).values(**_requeue(now))
        ),
    )
    count = int(result.rowcount)
    if count:
        audit.record(
            session,
            org_id=org_id,
            actor_user_id=actor_user_id,
            action="delivery.bulk_replayed",
            target_type="delivery",
            target_id="bulk",
            details={
                "count": count,
                "status": filters.status,
                "endpoint_id": str(filters.endpoint_id) if filters.endpoint_id else None,
                "event_type": filters.event_type,
            },
        )
    await session.commit()
    return count
