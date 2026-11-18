"""Retention: old, finished events go; recent or unfinished ones stay."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from relay.db.models import Attempt, Delivery, Endpoint, Event, Organization
from relay.domain.enums import DeliveryStatus
from relay.services.retention import purge_old_events
from relay.worker.maintenance import MaintenanceWorker
from tests.conftest import make_settings

pytestmark = pytest.mark.integration

NOW = datetime.now(UTC)
OLD = NOW - timedelta(days=45)
RECENT = NOW - timedelta(days=5)
CUTOFF = NOW - timedelta(days=30)


@pytest.fixture
def sessions(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
async def endpoint(session: AsyncSession) -> Endpoint:
    org = Organization(name="Acme")
    session.add(org)
    await session.flush()
    row = Endpoint(org_id=org.id, url="https://hooks.example.com/relay")
    session.add(row)
    await session.commit()
    return row


async def make_event(
    session: AsyncSession,
    endpoint: Endpoint,
    *,
    created_at: datetime,
    statuses: tuple[str, ...] = (DeliveryStatus.SUCCEEDED,),
) -> uuid.UUID:
    """An event with one delivery per status, each with one attempt.

    An event has at most one delivery per endpoint, so each delivery after the
    first goes to an endpoint of its own.
    """
    event = Event(org_id=endpoint.org_id, type="order.paid", payload={}, created_at=created_at)
    session.add(event)
    await session.flush()
    for number, status in enumerate(statuses):
        target = endpoint
        if number:
            target = Endpoint(org_id=endpoint.org_id, url=f"https://hooks{number}.example.com/")
            session.add(target)
            await session.flush()
        delivery = Delivery(
            org_id=endpoint.org_id,
            event_id=event.id,
            endpoint_id=target.id,
            status=status,
            created_at=created_at,
        )
        session.add(delivery)
        await session.flush()
        session.add(
            Attempt(
                delivery_id=delivery.id,
                attempt_number=1,
                started_at=created_at,
                duration_ms=10,
                status_code=200,
            )
        )
    await session.commit()
    return event.id


async def count(session: AsyncSession, model: type[Event] | type[Delivery] | type[Attempt]) -> int:
    return int(await session.scalar(select(func.count()).select_from(model)) or 0)


async def event_exists(session: AsyncSession, event_id: uuid.UUID) -> bool:
    session.expire_all()
    return await session.get(Event, event_id) is not None


async def test_old_finished_events_are_deleted_with_their_deliveries_and_attempts(
    session: AsyncSession, sessions: async_sessionmaker[AsyncSession], endpoint: Endpoint
) -> None:
    await make_event(
        session, endpoint, created_at=OLD, statuses=(DeliveryStatus.SUCCEEDED, DeliveryStatus.DEAD)
    )
    await make_event(session, endpoint, created_at=OLD, statuses=())  # matched no endpoint

    deleted = await purge_old_events(sessions, cutoff=CUTOFF, batch_size=100)

    assert deleted == 2
    assert await count(session, Event) == 0
    assert await count(session, Delivery) == 0
    assert await count(session, Attempt) == 0


async def test_recent_events_are_kept(
    session: AsyncSession, sessions: async_sessionmaker[AsyncSession], endpoint: Endpoint
) -> None:
    recent = await make_event(session, endpoint, created_at=RECENT)

    assert await purge_old_events(sessions, cutoff=CUTOFF, batch_size=100) == 0
    assert await event_exists(session, recent)


@pytest.mark.parametrize(
    "unfinished", [DeliveryStatus.PENDING, DeliveryStatus.IN_FLIGHT, DeliveryStatus.RETRYING]
)
async def test_an_old_event_with_a_delivery_still_in_progress_is_kept(
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    endpoint: Endpoint,
    unfinished: str,
) -> None:
    kept = await make_event(
        session, endpoint, created_at=OLD, statuses=(DeliveryStatus.SUCCEEDED, unfinished)
    )
    gone = await make_event(session, endpoint, created_at=OLD)

    assert await purge_old_events(sessions, cutoff=CUTOFF, batch_size=100) == 1
    assert await event_exists(session, kept)
    assert not await event_exists(session, gone)
    # Every delivery and attempt of the kept event is still there.
    assert await count(session, Delivery) == 2
    assert await count(session, Attempt) == 2


async def test_a_large_backlog_is_deleted_in_batches(
    session: AsyncSession, sessions: async_sessionmaker[AsyncSession], endpoint: Endpoint
) -> None:
    for _ in range(7):
        await make_event(session, endpoint, created_at=OLD)
    await make_event(session, endpoint, created_at=RECENT)

    assert await purge_old_events(sessions, cutoff=CUTOFF, batch_size=3) == 7
    assert await count(session, Event) == 1


async def test_a_run_is_bounded_and_the_next_run_continues(
    session: AsyncSession, sessions: async_sessionmaker[AsyncSession], endpoint: Endpoint
) -> None:
    for _ in range(5):
        await make_event(session, endpoint, created_at=OLD)

    assert await purge_old_events(sessions, cutoff=CUTOFF, batch_size=2, max_batches=1) == 2
    assert await purge_old_events(sessions, cutoff=CUTOFF, batch_size=2) == 3


async def test_a_replay_committed_while_retention_waits_keeps_its_event(
    engine: AsyncEngine,
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    endpoint: Endpoint,
) -> None:
    """Retention looked at a dead delivery; meanwhile someone replays it.

    The replay's transaction holds the delivery row. Retention must wait for it,
    then see the delivery is pending again and keep the event.
    """
    event_id = await make_event(session, endpoint, created_at=OLD, statuses=(DeliveryStatus.DEAD,))

    async with AsyncSession(engine) as replayer:
        await replayer.execute(
            update(Delivery)
            .where(Delivery.event_id == event_id)
            .values(status=DeliveryStatus.PENDING)
        )
        purge = asyncio.create_task(purge_old_events(sessions, cutoff=CUTOFF, batch_size=100))
        await asyncio.sleep(0.5)
        assert not purge.done(), "retention should be waiting for the replay's lock"
        await replayer.commit()

    assert await asyncio.wait_for(purge, timeout=10) == 0
    assert await event_exists(session, event_id)


async def test_the_worker_runs_retention_with_the_configured_period(
    session: AsyncSession, sessions: async_sessionmaker[AsyncSession], endpoint: Endpoint
) -> None:
    old = await make_event(session, endpoint, created_at=NOW - timedelta(days=8))
    recent = await make_event(session, endpoint, created_at=NOW - timedelta(days=6))
    settings = make_settings(retention_days=7)
    worker = MaintenanceWorker(
        sessions=sessions,
        settings=settings,
        box=None,  # type: ignore[arg-type]
        clock=lambda: NOW,
    )

    await worker.tick()

    assert not await event_exists(session, old)
    assert await event_exists(session, recent)
