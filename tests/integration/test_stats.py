"""GET /v1/stats/overview: hourly activity for the dashboard."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from relay.db.models import Attempt, Delivery, Endpoint, Event
from relay.domain.enums import DeliveryStatus
from relay.services import stats
from tests.integration.helpers import register

pytestmark = pytest.mark.integration

NOW = datetime(2026, 3, 10, 12, 40, tzinfo=UTC)


async def seed_activity(session: AsyncSession, org_id: str) -> tuple[str, str]:
    """Two endpoints. Endpoint A: 2 successes and 1 failure at 11:xx, 1 success
    at 12:xx. Endpoint B: 1 failure at 12:xx. Plus one attempt 2 days ago."""
    a = Endpoint(org_id=org_id, url="https://a.example.com/")
    b = Endpoint(org_id=org_id, url="https://b.example.com/")
    session.add_all([a, b])
    await session.flush()

    async def attempt(endpoint: Endpoint, at: datetime, *, ok: bool, ms: int) -> None:
        event = Event(org_id=org_id, type="order.paid", payload={}, created_at=at)
        session.add(event)
        await session.flush()
        delivery = Delivery(
            org_id=org_id,
            event_id=event.id,
            endpoint_id=endpoint.id,
            status=DeliveryStatus.SUCCEEDED if ok else DeliveryStatus.DEAD,
        )
        session.add(delivery)
        await session.flush()
        session.add(
            Attempt(
                delivery_id=delivery.id,
                attempt_number=1,
                started_at=at,
                duration_ms=ms,
                status_code=200 if ok else 500,
                error_kind=None if ok else "http_status",
            )
        )

    hour_11 = NOW.replace(hour=11, minute=5)
    await attempt(a, hour_11, ok=True, ms=10)
    await attempt(a, hour_11 + timedelta(minutes=20), ok=True, ms=30)
    await attempt(a, hour_11 + timedelta(minutes=50), ok=False, ms=100)
    await attempt(a, NOW.replace(minute=1), ok=True, ms=20)
    await attempt(b, NOW.replace(minute=2), ok=False, ms=40)
    await attempt(a, NOW - timedelta(days=2), ok=True, ms=5)  # outside the window
    await session.commit()
    return str(a.id), str(b.id)


async def test_the_overview_counts_attempts_hour_by_hour(
    client: AsyncClient, session: AsyncSession
) -> None:
    org_id = (await register(client))["organizations"][0]["id"]
    a, b = await seed_activity(session, org_id)

    data = await stats.overview(session, uuid.UUID(org_id), now=NOW)

    assert len(data.buckets) == 24
    assert data.buckets[0].start == NOW.replace(minute=0) - timedelta(hours=23)
    assert data.buckets[-1].start == NOW.replace(minute=0)
    # Empty hours are present, with zeros.
    assert all(
        (bucket.succeeded, bucket.failed, bucket.p95_ms) == (0, 0, None)
        for bucket in data.buckets[:-2]
    )
    eleven, twelve = data.buckets[-2], data.buckets[-1]
    assert (eleven.succeeded, eleven.failed) == (2, 1)
    assert (twelve.succeeded, twelve.failed) == (1, 1)
    assert eleven.p95_ms is not None
    assert 30 < eleven.p95_ms <= 100

    series = {str(item.endpoint_id): item for item in data.endpoints}
    assert set(series) == {a, b}
    assert series[a].succeeded[-2:] == [2, 1]
    assert series[a].failed[-2:] == [1, 0]
    assert series[b].failed[-1] == 1
    assert len(series[a].succeeded) == 24

    assert (data.attempts, data.successes) == (5, 3)
    assert data.events == 5  # the one from two days ago is outside the window
    assert data.deliveries_by_status == {
        "pending": 0,
        "in_flight": 0,
        "retrying": 0,
        "succeeded": 4,
        "dead": 2,
    }


async def test_the_hours_are_utc_whatever_the_database_timezone(
    client: AsyncClient, session: AsyncSession
) -> None:
    org_id = (await register(client))["organizations"][0]["id"]
    await seed_activity(session, org_id)
    # India is UTC+5:30: truncating to the hour there would shift every bucket.
    await session.execute(text("SET TIME ZONE 'Asia/Kolkata'"))

    data = await stats.overview(session, uuid.UUID(org_id), now=NOW)

    assert data.buckets[-1].start == NOW.replace(minute=0)
    assert (data.buckets[-2].succeeded, data.buckets[-2].failed) == (2, 1)
    assert sum(sum(item.succeeded) for item in data.endpoints) == 3


async def test_the_overview_route_is_scoped_to_the_organisation(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    org_id = (await register(client))["organizations"][0]["id"]
    await seed_activity(session, org_id)
    await register(other_client, email="other@example.com", organization="Other")

    mine = await client.get("/v1/stats/overview")
    theirs = await other_client.get("/v1/stats/overview")

    assert mine.status_code == 200, mine.text
    body = mine.json()
    assert len(body["buckets"]) == 24
    assert set(body) >= {"events", "attempts", "success_rate", "p95_ms", "endpoints"}
    assert theirs.json()["attempts"] == 0
    assert theirs.json()["success_rate"] is None
    assert theirs.json()["endpoints"] == []


async def test_the_overview_needs_a_login(client: AsyncClient) -> None:
    assert (await client.get("/v1/stats/overview")).status_code == 401
