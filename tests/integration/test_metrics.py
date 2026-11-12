from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import AsyncClient
from prometheus_client import REGISTRY
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core.config import Settings
from tests.conftest import TEST_REDIS_URL, make_settings
from tests.integration.fake_receiver import FakeReceiver, Reply
from tests.integration.helpers import bearer, create_api_key, create_endpoint, register
from tests.integration.test_worker import Pipeline

pytestmark = pytest.mark.integration


@pytest.fixture
def settings() -> Settings:
    return make_settings(endpoints_allow_private_networks=True)


@pytest.fixture
async def receiver() -> AsyncIterator[FakeReceiver]:
    receiver = FakeReceiver()
    await receiver.start()
    try:
        yield receiver
    finally:
        await receiver.stop()


@pytest.fixture
async def pipeline(engine: Any) -> AsyncIterator[Pipeline]:
    redis = Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    pipeline = Pipeline(engine, redis)
    try:
        yield pipeline
    finally:
        await pipeline.aclose()
        await redis.aclose()


def value(name: str, **labels: str) -> float:
    """Current value of a metric in this process (0 if it has no samples yet)."""
    return REGISTRY.get_sample_value(name, labels) or 0.0


def scraped(body: str, name: str) -> float:
    """The value of an unlabelled metric in a /metrics response."""
    for line in body.splitlines():
        if line.startswith(name + " "):
            return float(line.split(" ")[1])
    raise AssertionError(f"{name} not found in the scrape")


async def emit(client: AsyncClient, key: str, **headers: str) -> None:
    response = await client.post(
        "/v1/events",
        json={"type": "order.paid", "payload": {"n": 1}},
        headers=bearer(key) | headers,
    )
    assert response.status_code in (200, 201), response.text


# ----------------------------------------------------------------------- ingest
async def test_ingested_events_are_counted_but_idempotent_replays_are_not(
    client: AsyncClient,
) -> None:
    await register(client)
    key = await create_api_key(client)
    before = value("relay_events_ingested_total")

    await emit(client, key)
    await emit(client, key, **{"Idempotency-Key": "same"})
    await emit(client, key, **{"Idempotency-Key": "same"})  # a replay: nothing new stored

    assert value("relay_events_ingested_total") - before == 2


# -------------------------------------------------------------------- delivery
async def test_attempts_are_counted_by_result_and_timed(
    client: AsyncClient, receiver: FakeReceiver, pipeline: Pipeline
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client, url=receiver.url())
    receiver.reply_with(Reply(status=500))  # then 200
    ok_before = value("relay_delivery_attempts_total", result="success")
    failed_before = value("relay_delivery_attempts_total", result="http_status")
    timed_before = value("relay_delivery_duration_seconds_count")
    succeeded_before = value("relay_deliveries_finished_total", outcome="succeeded")
    processor = pipeline.processor(schedule=[0, 0, 0])

    await emit(client, key)
    await pipeline.tick(processor)
    await pipeline.tick(processor)

    assert value("relay_delivery_attempts_total", result="success") - ok_before == 1
    assert value("relay_delivery_attempts_total", result="http_status") - failed_before == 1
    assert value("relay_delivery_duration_seconds_count") - timed_before == 2
    assert value("relay_deliveries_finished_total", outcome="succeeded") - succeeded_before == 1


async def test_a_delivery_that_runs_out_of_attempts_is_counted_as_dead(
    client: AsyncClient, receiver: FakeReceiver, pipeline: Pipeline
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client, url=receiver.url())
    receiver.default = Reply(status=500)
    before = value("relay_deliveries_finished_total", outcome="dead")
    processor = pipeline.processor(schedule=[0, 0])

    await emit(client, key)
    await pipeline.tick(processor)
    await pipeline.tick(processor)

    assert value("relay_deliveries_finished_total", outcome="dead") - before == 1


async def test_postponed_deliveries_are_counted_by_reason(
    client: AsyncClient, receiver: FakeReceiver, pipeline: Pipeline
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client, url=receiver.url())
    receiver.default = Reply(status=500)
    before = value("relay_deliveries_postponed_total", reason="breaker_open")

    for _ in range(4):
        await emit(client, key)
    await pipeline.tick(pipeline.processor(failure_threshold=2))

    # Two failures open the breaker; the other two wait without an attempt.
    assert value("relay_deliveries_postponed_total", reason="breaker_open") - before == 2


async def test_recovered_leases_are_counted(
    client: AsyncClient, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    from relay.worker.claim import claim_due
    from relay.worker.loop import DeliveryWorker

    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client, url=receiver.url())
    await emit(client, key)
    await claim_due(pipeline.sessions, worker_id="doomed", limit=10, lock_seconds=60)
    await session.execute(text("UPDATE deliveries SET locked_until = now() - interval '1 second'"))
    await session.commit()
    before = value("relay_leases_recovered_total")
    worker = DeliveryWorker(
        sessions=pipeline.sessions,
        process=pipeline.processor().process,
        poll_interval=0.01,
        batch_size=10,
        concurrency=2,
        lock_seconds=60,
        worker_id="worker-1",
    )

    await worker.tick()

    assert value("relay_leases_recovered_total") - before == 1


# ---------------------------------------------------------------- queue gauges
async def test_the_scrape_reports_queue_depth_lag_and_open_breakers(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    endpoint = await create_endpoint(client)
    for _ in range(3):
        await emit(client, key)
    await session.execute(
        text(
            "UPDATE deliveries SET next_attempt_at = now() - interval '90 seconds' "
            "WHERE id = (SELECT id FROM deliveries LIMIT 1)"
        )
    )
    await session.execute(
        text("UPDATE endpoints SET breaker_state = 'open' WHERE id = :id"), {"id": endpoint["id"]}
    )
    await session.commit()

    response = await client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    body = response.text
    assert 'relay_queue_depth{status="pending"} 3.0' in body
    assert 'relay_queue_depth{status="retrying"} 0.0' in body
    assert 88 <= scraped(body, "relay_oldest_pending_age_seconds") <= 120
    assert scraped(body, "relay_breaker_open_endpoints") == 1


async def test_deliveries_for_a_paused_endpoint_do_not_count_as_lag(
    client: AsyncClient, session: AsyncSession
) -> None:
    """A customer pausing their endpoint must not page the on-call engineer."""
    await register(client)
    key = await create_api_key(client)
    endpoint = await create_endpoint(client)
    await client.post(f"/v1/endpoints/{endpoint['id']}/pause")
    await emit(client, key)
    await session.execute(text("UPDATE deliveries SET next_attempt_at = now() - interval '1 hour'"))
    await session.commit()

    body = (await client.get("/metrics")).text

    assert 'relay_queue_depth{status="pending"} 1.0' in body
    assert scraped(body, "relay_oldest_pending_age_seconds") == 0


async def test_an_empty_queue_reports_zero_lag(client: AsyncClient) -> None:
    body = (await client.get("/metrics")).text

    assert scraped(body, "relay_oldest_pending_age_seconds") == 0
    assert scraped(body, "relay_breaker_open_endpoints") == 0


# ------------------------------------------------------------------------ HTTP
async def test_requests_are_counted_by_route_template_not_by_real_path(
    client: AsyncClient,
) -> None:
    await register(client)
    first = (await create_endpoint(client))["id"]
    second = (await create_endpoint(client))["id"]
    labels = {"method": "GET", "route": "/v1/endpoints/{endpoint_id}", "status": "200"}
    before = value("relay_http_requests_total", **labels)

    await client.get(f"/v1/endpoints/{first}")
    await client.get(f"/v1/endpoints/{second}")

    assert value("relay_http_requests_total", **labels) - before == 2
    body = (await client.get("/metrics")).text
    assert first not in body  # ids never become label values
    assert second not in body


async def test_unknown_paths_share_one_label_so_scanners_cannot_flood_the_metrics(
    client: AsyncClient,
) -> None:
    labels = {"method": "GET", "route": "unmatched", "status": "404"}
    before = value("relay_http_requests_total", **labels)

    for n in range(5):
        await client.get(f"/wp-admin/probe-{n}.php")

    assert value("relay_http_requests_total", **labels) - before == 5
    assert "probe-" not in (await client.get("/metrics")).text


async def test_errors_and_latency_are_recorded(client: AsyncClient) -> None:
    labels = {"method": "GET", "route": "/v1/auth/me", "status": "401"}
    before = value("relay_http_requests_total", **labels)
    timed_before = value(
        "relay_http_request_duration_seconds_count", method="GET", route="/v1/auth/me"
    )

    await client.get("/v1/auth/me")

    assert value("relay_http_requests_total", **labels) - before == 1
    assert (
        value("relay_http_request_duration_seconds_count", method="GET", route="/v1/auth/me")
        - timed_before
        == 1
    )


async def test_scraping_does_not_count_itself(client: AsyncClient) -> None:
    await client.get("/metrics")
    body = (await client.get("/metrics")).text

    assert 'route="/metrics"' not in body


async def test_metrics_are_still_served_when_the_database_is_down() -> None:
    from httpx import ASGITransport

    from relay.main import create_app

    app = create_app(make_settings(database_url="postgresql+asyncpg://relay:relay@127.0.0.1:1/x"))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        response = await client.get("/metrics")

    assert response.status_code == 200
    assert "relay_events_ingested_total" in response.text


async def test_no_secret_or_personal_data_appears_in_the_metrics(client: AsyncClient) -> None:
    body = await register(client, "private.person@example.com", "Secret Org Name")
    key = await create_api_key(client)
    await emit(client, key)

    scrape = (await client.get("/metrics")).text

    for private in ("private.person", "Secret Org Name", key, body["user"]["id"]):
        assert private not in scrape
