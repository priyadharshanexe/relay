import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import AsyncClient
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from relay.api.stream import format_sse, sse_stream
from relay.core.config import Settings
from relay.core.live import LivePublisher, live_updates
from tests.conftest import TEST_REDIS_URL, make_settings
from tests.integration.fake_receiver import FakeReceiver, Reply
from tests.integration.helpers import bearer, create_api_key, create_endpoint, register
from tests.integration.test_worker import Pipeline

pytestmark = pytest.mark.integration


@pytest.fixture
def settings() -> Settings:
    return make_settings(endpoints_allow_private_networks=True)


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    client = Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def receiver() -> AsyncIterator[FakeReceiver]:
    receiver = FakeReceiver()
    await receiver.start()
    try:
        yield receiver
    finally:
        await receiver.stop()


async def subscribed(redis: Redis, org_id: uuid.UUID) -> AsyncIterator[dict[str, Any] | None]:
    """A live feed that is already listening (the first heartbeat proves it)."""
    feed = live_updates(redis, org_id, heartbeat_seconds=0.2)
    assert await anext(feed) is None
    return feed


async def next_update(feed: AsyncIterator[dict[str, Any] | None]) -> dict[str, Any]:
    async with asyncio.timeout(5):
        async for update in feed:
            if update is not None:
                return update
    raise AssertionError("the feed ended")


# -------------------------------------------------------------------- live feed
async def test_an_update_published_for_an_organisation_reaches_its_feed(redis: Redis) -> None:
    org_id = uuid.uuid4()
    feed = await subscribed(redis, org_id)

    await LivePublisher(redis).publish(org_id, {"type": "delivery.attempt", "status": "succeeded"})

    assert await next_update(feed) == {"type": "delivery.attempt", "status": "succeeded"}
    await feed.aclose()  # type: ignore[attr-defined]


async def test_one_organisation_never_receives_anothers_updates(redis: Redis) -> None:
    mine, theirs = uuid.uuid4(), uuid.uuid4()
    feed = await subscribed(redis, mine)

    await LivePublisher(redis).publish(theirs, {"type": "delivery.attempt", "secret": "theirs"})
    await LivePublisher(redis).publish(mine, {"type": "delivery.attempt", "mine": True})

    assert await next_update(feed) == {"type": "delivery.attempt", "mine": True}
    await feed.aclose()  # type: ignore[attr-defined]


async def test_silence_produces_heartbeats(redis: Redis) -> None:
    feed = live_updates(redis, uuid.uuid4(), heartbeat_seconds=0.05)

    assert [await anext(feed) for _ in range(3)] == [None, None, None]
    await feed.aclose()  # type: ignore[attr-defined]


async def test_a_stream_ends_by_itself_so_permission_is_checked_again(redis: Redis) -> None:
    """Found by testing: a feed opened before logging out kept running for ever."""
    feed = live_updates(redis, uuid.uuid4(), heartbeat_seconds=0.05, max_seconds=0.3)

    async with asyncio.timeout(3):
        received = [update async for update in feed]

    assert received  # it sent heartbeats while it lived
    assert all(update is None for update in received)


def test_sse_formatting() -> None:
    assert format_sse(None) == ": keep-alive\n\n"
    formatted = format_sse({"type": "delivery.attempt", "status": "dead"})
    assert formatted.startswith("event: delivery.attempt\ndata: ")
    assert formatted.endswith("\n\n")
    assert json.loads(formatted.split("data: ")[1]) == {
        "type": "delivery.attempt",
        "status": "dead",
    }


async def test_the_stream_opens_with_a_comment_then_sends_events() -> None:
    async def updates() -> AsyncIterator[dict[str, Any] | None]:
        yield {"type": "delivery.attempt", "n": 1}
        yield None

    chunks = [chunk async for chunk in sse_stream(updates())]

    assert chunks[0] == ": connected\n\n"
    assert chunks[1].startswith("event: delivery.attempt\n")
    assert chunks[2] == ": keep-alive\n\n"


async def test_the_stream_requires_a_session_and_membership(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    org_a = (await register(client, "a@example.com", "Org A"))["organizations"][0]["id"]
    await register(other_client, "b@example.com", "Org B")
    client.cookies.clear()

    anonymous = await client.get("/v1/stream/deliveries")
    outsider = await other_client.get("/v1/stream/deliveries", params={"org_id": org_a})

    assert anonymous.status_code == 401
    assert outsider.status_code == 404  # cannot listen to another organisation


async def test_the_worker_publishes_each_attempt_to_the_feed(
    client: AsyncClient, receiver: FakeReceiver, engine: Any, redis: Redis
) -> None:
    body = await register(client)
    org_id = uuid.UUID(body["organizations"][0]["id"])
    key = await create_api_key(client)
    endpoint = await create_endpoint(client, url=receiver.url())
    feed = await subscribed(redis, org_id)
    pipeline = Pipeline(engine, redis)
    processor = pipeline.processor()
    processor._publisher = LivePublisher(redis)

    event = await client.post(
        "/v1/events", json={"type": "order.paid", "payload": {}}, headers=bearer(key)
    )
    await pipeline.tick(processor)

    update = await next_update(feed)
    assert update["type"] == "delivery.attempt"
    assert update["status"] == "succeeded"
    assert update["status_code"] == 200
    assert update["attempt"] == 1
    assert update["event_type"] == "order.paid"
    assert update["event_id"] == event.json()["id"]
    assert update["endpoint_id"] == endpoint["id"]
    await feed.aclose()  # type: ignore[attr-defined]
    await pipeline.aclose()


# -------------------------------------------------------------- endpoint health
async def test_health_reports_success_rate_and_p95_per_endpoint(
    client: AsyncClient, receiver: FakeReceiver, engine: Any, redis: Redis, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    flaky = await create_endpoint(client, url=receiver.url("/flaky"), event_types=["a.event"])
    idle = await create_endpoint(client, url=receiver.url("/idle"), event_types=["never.sent"])
    receiver.reply_with(Reply(status=500), Reply(status=500))  # then 200s
    pipeline = Pipeline(engine, redis)
    processor = pipeline.processor(schedule=[0, 0, 0, 0])
    for _ in range(2):
        await client.post(
            "/v1/events", json={"type": "a.event", "payload": {}}, headers=bearer(key)
        )
    for _ in range(3):
        await pipeline.tick(processor)
    await pipeline.aclose()

    response = await client.get("/v1/endpoints/health")

    assert response.status_code == 200
    (health,) = response.json()  # the idle endpoint has no attempts, so no row
    assert health["endpoint_id"] == flaky["id"]
    assert health["attempts"] == 4
    assert health["successes"] == 2
    assert health["success_rate"] == 0.5
    assert isinstance(health["p95_ms"], int)
    assert idle["id"] not in response.text


async def test_health_ignores_attempts_older_than_a_day(
    client: AsyncClient, receiver: FakeReceiver, engine: Any, redis: Redis, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client, url=receiver.url())
    pipeline = Pipeline(engine, redis)
    await client.post("/v1/events", json={"type": "a.event", "payload": {}}, headers=bearer(key))
    await pipeline.tick()
    await pipeline.aclose()
    await session.execute(text("UPDATE attempts SET started_at = now() - interval '25 hours'"))
    await session.commit()

    assert (await client.get("/v1/endpoints/health")).json() == []


async def test_health_is_scoped_to_the_organisation_and_needs_a_session(
    client: AsyncClient,
    other_client: AsyncClient,
    receiver: FakeReceiver,
    engine: Any,
    redis: Redis,
) -> None:
    await register(client, "a@example.com", "Org A")
    key = await create_api_key(client)
    await create_endpoint(client, url=receiver.url())
    pipeline = Pipeline(engine, redis)
    await client.post("/v1/events", json={"type": "a.event", "payload": {}}, headers=bearer(key))
    await pipeline.tick()
    await pipeline.aclose()
    await register(other_client, "b@example.com", "Org B")

    assert len((await client.get("/v1/endpoints/health")).json()) == 1
    assert (await other_client.get("/v1/endpoints/health")).json() == []
    other_client.cookies.clear()
    assert (await other_client.get("/v1/endpoints/health")).status_code == 401
