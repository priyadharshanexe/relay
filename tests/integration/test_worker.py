"""The delivery pipeline against a real HTTP receiver, real PostgreSQL and real Redis."""

import asyncio
import json
import socket
import uuid
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from redis.asyncio import Redis
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from relay.core.config import DEV_ENCRYPTION_KEY, Settings
from relay.core.crypto import SecretBox
from relay.core.redis_rate_limit import RedisRateLimiter
from relay.db.models import Attempt, Delivery, Endpoint
from relay.domain.backoff import ScheduleBackoff
from relay.domain.circuit_breaker import BreakerConfig, CircuitBreaker
from relay.domain.signing import VerificationError, Verifier
from relay.domain.ssrf import AddressPolicy, Resolver, UnresolvableHostError
from relay.worker.claim import claim_due, sweep_expired
from relay.worker.deliver import DeliveryProcessor
from relay.worker.loop import DeliveryWorker
from relay.worker.sender import Sender, system_resolver
from tests.conftest import TEST_REDIS_URL, make_settings
from tests.integration.fake_receiver import FakeReceiver, Reply
from tests.integration.helpers import bearer, create_api_key, create_endpoint, register

pytestmark = pytest.mark.integration

FAILING = Reply(status=500, body=b"boom")


@pytest.fixture
def settings() -> Settings:
    # The fake receiver lives on 127.0.0.1, which the SSRF guard blocks by default.
    return make_settings(endpoints_allow_private_networks=True)


@pytest.fixture
async def receiver() -> AsyncIterator[FakeReceiver]:
    receiver = FakeReceiver()
    await receiver.start()
    try:
        yield receiver
    finally:
        await receiver.stop()


class Pipeline:
    """Builds workers for a test and runs their ticks by hand."""

    def __init__(self, engine: AsyncEngine, redis: Redis) -> None:
        self.sessions = async_sessionmaker(engine, expire_on_commit=False)
        self._redis = redis
        self._senders: list[Sender] = []

    def processor(
        self,
        worker_id: str = "worker-1",
        *,
        schedule: Sequence[float] | None = None,
        failure_threshold: int = 1000,
        resolver: Resolver = system_resolver,
        allow_private: bool = True,
        timeout: float = 1.0,
        trusted_url_prefix: str | None = None,
        only_trusted: bool = False,
    ) -> DeliveryProcessor:
        sender = Sender(connect_timeout=timeout, total_timeout=timeout, snippet_bytes=64)
        self._senders.append(sender)
        return DeliveryProcessor(
            sessions=self.sessions,
            sender=sender,
            resolver=resolver,
            address_policy=AddressPolicy(allow_private_networks=allow_private),
            require_https=False,
            secret_box=SecretBox(DEV_ENCRYPTION_KEY),
            backoff=ScheduleBackoff(schedule, jitter=0) if schedule else ScheduleBackoff(jitter=0),
            breaker=CircuitBreaker(
                BreakerConfig(failure_threshold=failure_threshold, cooldown=timedelta(seconds=60))
            ),
            rate_limiter=RedisRateLimiter(self._redis),
            worker_id=worker_id,
            trusted_url_prefix=trusted_url_prefix,
            only_trusted=only_trusted,
        )

    async def tick(
        self, processor: DeliveryProcessor | None = None, worker_id: str = "worker-1"
    ) -> int:
        """Sweep, claim, and process the claimed deliveries one by one (so the
        order of effects is predictable). Returns how many were claimed."""
        processor = processor or self.processor(worker_id)
        await sweep_expired(self.sessions)
        claimed = await claim_due(self.sessions, worker_id=worker_id, limit=100, lock_seconds=60)
        for delivery_id in claimed:
            await processor.process(delivery_id)
        return len(claimed)

    async def aclose(self) -> None:
        for sender in self._senders:
            await sender.aclose()


@pytest.fixture
async def pipeline(engine: AsyncEngine) -> AsyncIterator[Pipeline]:
    redis = Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    pipeline = Pipeline(engine, redis)
    try:
        yield pipeline
    finally:
        await pipeline.aclose()
        await redis.aclose()


class Org:
    """A registered organisation with an API key, for sending events."""

    def __init__(self, client: AsyncClient, key: str) -> None:
        self.client = client
        self.key = key

    async def endpoint(self, url: str, **fields: Any) -> dict[str, Any]:
        return await create_endpoint(self.client, url=url, **fields)

    async def emit(self, event_type: str = "order.paid", **payload: Any) -> str:
        response = await self.client.post(
            "/v1/events",
            json={"type": event_type, "payload": payload or {"order_id": 42}},
            headers=bearer(self.key),
        )
        assert response.status_code == 201, response.text
        return str(response.json()["id"])


@pytest.fixture
async def org(client: AsyncClient) -> Org:
    await register(client)
    return Org(client, await create_api_key(client))


async def deliveries(session: AsyncSession) -> list[Delivery]:
    session.expire_all()
    return list(await session.scalars(select(Delivery).order_by(Delivery.created_at, Delivery.id)))


async def only_delivery(session: AsyncSession) -> Delivery:
    (delivery,) = await deliveries(session)
    return delivery


async def attempts(session: AsyncSession) -> list[Attempt]:
    return list(await session.scalars(select(Attempt).order_by(Attempt.attempt_number)))


async def make_everything_due(session: AsyncSession) -> None:
    await session.execute(text("UPDATE deliveries SET next_attempt_at = now()"))
    await session.commit()


def seconds_from_now(moment: datetime) -> float:
    return (moment - datetime.now(UTC)).total_seconds()


# ----------------------------------------------------------------- happy path
async def test_a_delivery_is_signed_sent_and_marked_succeeded(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    endpoint = await org.endpoint(receiver.url())
    event_id = await org.emit(order_id=42, amount=1999)

    assert await pipeline.tick() == 1

    (request,) = receiver.requests
    assert request.path == "/hook"
    assert request.headers["content-type"] == "application/json"
    assert request.headers["user-agent"].startswith("Relay/")
    assert request.headers["webhook-id"] == event_id
    # A receiver holding the endpoint's secret can verify the request as it arrived.
    Verifier(endpoint["secret"]).verify(request.headers, request.body, now=datetime.now(UTC))
    body = json.loads(request.body)
    assert body["id"] == event_id
    assert body["type"] == "order.paid"
    assert body["data"] == {"order_id": 42, "amount": 1999}

    delivery = await only_delivery(session)
    assert delivery.status == "succeeded"
    assert delivery.attempts == 1
    assert delivery.locked_by is None
    assert delivery.locked_until is None
    assert delivery.last_error is None
    (attempt,) = await attempts(session)
    assert attempt.attempt_number == 1
    assert attempt.status_code == 200
    assert attempt.error_kind is None
    assert attempt.response_snippet == '{"received":true}'
    assert attempt.duration_ms >= 0


async def test_a_tampered_body_would_fail_the_receivers_check(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline
) -> None:
    endpoint = await org.endpoint(receiver.url())
    await org.emit(amount=1999)
    await pipeline.tick()
    (request,) = receiver.requests

    with pytest.raises(VerificationError):
        Verifier(endpoint["secret"]).verify(
            request.headers, request.body.replace(b"1999", b"9999"), now=datetime.now(UTC)
        )


async def test_nothing_is_claimed_twice_once_it_is_done(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline
) -> None:
    await org.endpoint(receiver.url())
    await org.emit()

    assert await pipeline.tick() == 1
    assert await pipeline.tick() == 0
    assert len(receiver.requests) == 1


async def test_the_signature_is_masked_in_the_stored_request_headers(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    await org.endpoint(receiver.url())
    await org.emit()
    await pipeline.tick()

    (attempt,) = await attempts(session)
    sent_signature = receiver.requests[0].headers["webhook-signature"]

    stored = attempt.request_headers["webhook-signature"]
    assert stored.startswith("v1,")
    assert stored.endswith("****")
    assert sent_signature not in str(attempt.request_headers)
    assert attempt.request_headers["webhook-id"] == receiver.requests[0].headers["webhook-id"]


async def test_during_secret_rotation_both_secrets_verify(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline
) -> None:
    endpoint = await org.endpoint(receiver.url())
    rotated = (await org.client.post(f"/v1/endpoints/{endpoint['id']}/rotate-secret")).json()
    await org.emit()

    await pipeline.tick()

    (request,) = receiver.requests
    now = datetime.now(UTC)
    assert len(request.headers["webhook-signature"].split(" ")) == 2
    Verifier(endpoint["secret"]).verify(request.headers, request.body, now=now)  # old
    Verifier(rotated["secret"]).verify(request.headers, request.body, now=now)  # new


# ---------------------------------------------------------- failure and retry
async def test_a_500_schedules_a_retry_thirty_seconds_later(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.default = FAILING
    await org.endpoint(receiver.url())
    await org.emit()

    await pipeline.tick()

    delivery = await only_delivery(session)
    assert delivery.status == "retrying"
    assert delivery.attempts == 1
    assert 25 < seconds_from_now(delivery.next_attempt_at) <= 30
    assert delivery.last_error == "http_status: the receiver answered HTTP 500"
    assert delivery.locked_by is None
    (attempt,) = await attempts(session)
    assert attempt.status_code == 500
    assert attempt.error_kind == "http_status"
    assert attempt.response_snippet == "boom"
    # Not due yet, so the next tick leaves it alone.
    assert await pipeline.tick() == 0


async def test_the_default_schedule_is_followed_attempt_by_attempt(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.default = FAILING
    await org.endpoint(receiver.url())
    await org.emit()
    expected_gaps = [30, 120, 600, 3600, 21600, 86400]

    for attempt_number, gap in enumerate(expected_gaps, start=1):
        await pipeline.tick()
        delivery = await only_delivery(session)
        assert delivery.status == "retrying", attempt_number
        assert delivery.attempts == attempt_number
        assert gap - 5 < seconds_from_now(delivery.next_attempt_at) <= gap
        await make_everything_due(session)

    await pipeline.tick()  # the 7th and last attempt
    delivery = await only_delivery(session)
    assert delivery.status == "dead"
    assert delivery.attempts == 7
    assert [a.attempt_number for a in await attempts(session)] == [1, 2, 3, 4, 5, 6, 7]
    assert await pipeline.tick() == 0  # dead deliveries are never claimed


async def test_a_receiver_that_recovers_gets_the_delivery(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.reply_with(FAILING, FAILING)  # then the default: 200
    await org.endpoint(receiver.url())
    await org.emit()
    processor = pipeline.processor(schedule=[0, 0, 0, 0])

    for _ in range(3):
        await pipeline.tick(processor)

    delivery = await only_delivery(session)
    assert delivery.status == "succeeded"
    assert delivery.attempts == 3
    assert delivery.last_error is None
    assert [a.status_code for a in await attempts(session)] == [500, 500, 200]
    assert len({r.headers["webhook-id"] for r in receiver.requests}) == 1  # same id on retries


async def test_retry_after_from_a_429_is_honoured(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.reply_with(Reply(status=429, headers={"Retry-After": "120"}))
    await org.endpoint(receiver.url())
    await org.emit()

    await pipeline.tick()

    delivery = await only_delivery(session)
    assert delivery.status == "retrying"
    assert 115 < seconds_from_now(delivery.next_attempt_at) <= 120  # not the usual 30
    (attempt,) = await attempts(session)
    assert attempt.status_code == 429
    assert attempt.response_headers is not None
    assert attempt.response_headers["retry-after"] == "120"


async def test_a_receiver_that_never_answers_times_out(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.reply_with(Reply(hang=True))
    await org.endpoint(receiver.url())
    await org.emit()

    await pipeline.tick(pipeline.processor(timeout=0.5))

    (attempt,) = await attempts(session)
    assert attempt.error_kind == "timeout"
    assert attempt.status_code is None
    assert 400 <= attempt.duration_ms < 3000
    assert (await only_delivery(session)).status == "retrying"


async def test_a_refused_connection_is_recorded_as_a_connect_error(
    org: Org, pipeline: Pipeline, session: AsyncSession
) -> None:
    with socket.socket() as probe:  # find a port nothing listens on
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]
    await org.endpoint(f"http://127.0.0.1:{closed_port}/hook")
    await org.emit()

    await pipeline.tick(pipeline.processor(timeout=8))

    (attempt,) = await attempts(session)
    assert attempt.error_kind == "connect"
    assert attempt.status_code is None
    assert (await only_delivery(session)).status == "retrying"


async def test_redirects_are_not_followed(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.reply_with(Reply(status=302, headers={"Location": receiver.url("/internal-admin")}))
    await org.endpoint(receiver.url())
    await org.emit()

    await pipeline.tick()

    assert [r.path for r in receiver.requests] == ["/hook"]  # never went to /internal-admin
    (attempt,) = await attempts(session)
    assert attempt.status_code == 302
    assert attempt.error_kind == "http_status"


async def test_huge_or_binary_responses_are_stored_safely(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.reply_with(Reply(status=500, body=b"\x00\xff" + b"A" * 100_000))
    await org.endpoint(receiver.url())
    await org.emit()

    await pipeline.tick()

    (attempt,) = await attempts(session)
    assert attempt.response_snippet is not None
    assert len(attempt.response_snippet) <= 64
    assert "\x00" not in attempt.response_snippet


# -------------------------------------------------------------------- SSRF/DNS
async def test_a_hostname_resolving_to_a_private_ip_is_blocked_at_delivery(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    """The URL looked fine when saved; the danger only shows when DNS answers."""

    async def resolves_to_internal(host: str, port: int) -> Sequence[str]:
        return ["127.0.0.1"]

    await org.endpoint(receiver.url(host="innocent.example.test"))
    await org.emit()

    await pipeline.tick(pipeline.processor(resolver=resolves_to_internal, allow_private=False))

    assert receiver.requests == []  # no connection was ever made
    (attempt,) = await attempts(session)
    assert attempt.error_kind == "ssrf_blocked"
    assert attempt.status_code is None
    delivery = await only_delivery(session)
    assert delivery.status == "retrying"
    assert "blocked" in (delivery.last_error or "")


async def test_we_connect_to_the_vetted_ip_but_keep_the_original_host_header(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    lookups: list[str] = []

    async def resolver(host: str, port: int) -> Sequence[str]:
        lookups.append(host)
        return ["127.0.0.1"]

    await org.endpoint(receiver.url(host="hooks.example.test"))
    await org.emit()

    await pipeline.tick(pipeline.processor(resolver=resolver))

    # "hooks.example.test" does not exist in real DNS. The request arriving at all
    # proves the connection went to the IP our resolver returned, not to a second
    # lookup by the HTTP client.
    (request,) = receiver.requests
    assert request.headers["host"] == f"hooks.example.test:{receiver.port}"
    assert lookups == ["hooks.example.test"]
    assert (await only_delivery(session)).status == "succeeded"


async def test_a_dns_failure_is_recorded_and_retried(
    org: Org, pipeline: Pipeline, session: AsyncSession
) -> None:
    async def fails(host: str, port: int) -> Sequence[str]:
        raise UnresolvableHostError(f"{host} could not be resolved")

    await org.endpoint("http://gone.example.test/hook")
    await org.emit()

    await pipeline.tick(pipeline.processor(resolver=fails))

    (attempt,) = await attempts(session)
    assert attempt.error_kind == "dns"
    assert (await only_delivery(session)).status == "retrying"


async def test_the_system_resolver_turns_lookup_failures_into_a_clean_error() -> None:
    with pytest.raises(UnresolvableHostError):
        await system_resolver("definitely-not-a-real-host.invalid", 443)

    assert "127.0.0.1" in await system_resolver("localhost", 80) or "::1" in await system_resolver(
        "localhost", 80
    )


# ------------------------------------------------------- concurrency and crashes
async def emit_many(org: Org, count: int) -> None:
    await asyncio.gather(*(org.emit(n=n) for n in range(count)))


async def test_two_workers_never_claim_the_same_delivery(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline
) -> None:
    await org.endpoint(receiver.url())
    await emit_many(org, 40)

    first, second = await asyncio.gather(
        claim_due(pipeline.sessions, worker_id="worker-1", limit=30, lock_seconds=60),
        claim_due(pipeline.sessions, worker_id="worker-2", limit=30, lock_seconds=60),
    )

    assert set(first).isdisjoint(second)
    assert len(first) + len(second) == 40


async def test_two_workers_running_together_deliver_everything_exactly_once(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    await org.endpoint(receiver.url())
    await emit_many(org, 40)
    workers = [
        DeliveryWorker(
            sessions=pipeline.sessions,
            process=pipeline.processor(worker_id).process,
            poll_interval=0.01,
            batch_size=7,
            concurrency=5,
            lock_seconds=60,
            worker_id=worker_id,
        )
        for worker_id in ("worker-1", "worker-2")
    ]

    async def drain(worker: DeliveryWorker) -> None:
        while await worker.tick():
            pass

    await asyncio.gather(*(drain(worker) for worker in workers))
    await asyncio.gather(*(drain(worker) for worker in workers))  # pick up any leftovers

    assert len(receiver.requests) == 40
    assert len({r.headers["webhook-id"] for r in receiver.requests}) == 40
    assert {d.status for d in await deliveries(session)} == {"succeeded"}
    assert {d.attempts for d in await deliveries(session)} == {1}


async def test_a_delivery_held_by_a_live_worker_is_left_alone(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    await org.endpoint(receiver.url())
    await org.emit()
    await claim_due(pipeline.sessions, worker_id="busy-worker", limit=10, lock_seconds=60)

    assert await pipeline.tick(worker_id="worker-2") == 0
    assert receiver.requests == []
    assert (await only_delivery(session)).locked_by == "busy-worker"


async def test_a_crashed_workers_delivery_is_recovered_and_delivered(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    """A worker claims a delivery and dies before sending it."""
    await org.endpoint(receiver.url())
    await org.emit()
    await claim_due(pipeline.sessions, worker_id="doomed-worker", limit=10, lock_seconds=60)
    # ...the worker is killed here; time passes until its lease runs out.
    await session.execute(text("UPDATE deliveries SET locked_until = now() - interval '1 second'"))
    await session.commit()

    assert await pipeline.tick(worker_id="worker-2") == 1

    delivery = await only_delivery(session)
    assert delivery.status == "succeeded"
    assert delivery.attempts == 1
    assert len(receiver.requests) == 1


async def test_a_worker_that_lost_its_lease_does_not_send_a_duplicate(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    """A slow worker wakes up after its delivery was handed to someone else."""
    await org.endpoint(receiver.url())
    await org.emit()
    (delivery_id,) = await claim_due(
        pipeline.sessions, worker_id="slow-worker", limit=10, lock_seconds=60
    )
    await session.execute(text("UPDATE deliveries SET locked_until = now() - interval '1 second'"))
    await session.commit()
    await pipeline.tick(worker_id="worker-2")  # recovers and delivers it

    await pipeline.processor("slow-worker").process(delivery_id)  # the slow worker resumes

    assert len(receiver.requests) == 1
    delivery = await only_delivery(session)
    assert delivery.status == "succeeded"
    assert delivery.attempts == 1


async def test_one_crashing_delivery_does_not_stop_the_rest_of_the_batch(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    await org.endpoint(receiver.url())
    await emit_many(org, 5)
    real = pipeline.processor().process
    first_seen: list[uuid.UUID] = []

    async def flaky(delivery_id: uuid.UUID) -> None:
        if not first_seen:
            first_seen.append(delivery_id)
            raise RuntimeError("a bug in the worker")
        await real(delivery_id)

    worker = DeliveryWorker(
        sessions=pipeline.sessions,
        process=flaky,
        poll_interval=0.01,
        batch_size=50,
        concurrency=1,
        lock_seconds=60,
        worker_id="worker-1",
    )

    await worker.tick()

    statuses = sorted(d.status for d in await deliveries(session))
    assert statuses == ["in_flight", "succeeded", "succeeded", "succeeded", "succeeded"]
    assert len(receiver.requests) == 4
    # The stuck one is not lost: once its lease expires, the sweeper re-queues it.
    await session.execute(text("UPDATE deliveries SET locked_until = now() - interval '1 second'"))
    await session.commit()
    await worker.tick()
    assert {d.status for d in await deliveries(session)} == {"succeeded"}


async def test_a_full_batch_asks_for_another_tick_immediately(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline
) -> None:
    await org.endpoint(receiver.url())
    await emit_many(org, 5)
    worker = DeliveryWorker(
        sessions=pipeline.sessions,
        process=pipeline.processor().process,
        poll_interval=60,
        batch_size=3,
        concurrency=3,
        lock_seconds=60,
        worker_id="worker-1",
    )

    assert await worker.tick() is True  # 3 claimed = full batch: more may be waiting
    assert await worker.tick() is False  # 2 claimed: queue drained, sleep


# ----------------------------------------------------------------------- pause
async def test_deliveries_for_a_paused_endpoint_wait_until_it_is_resumed(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    endpoint = await org.endpoint(receiver.url())
    await org.client.post(f"/v1/endpoints/{endpoint['id']}/pause")
    await org.emit()

    assert await pipeline.tick() == 0
    assert receiver.requests == []
    assert (await only_delivery(session)).status == "pending"

    await org.client.post(f"/v1/endpoints/{endpoint['id']}/resume")
    assert await pipeline.tick() == 1
    assert (await only_delivery(session)).status == "succeeded"


# -------------------------------------------------------------- circuit breaker
async def endpoint_row(session: AsyncSession) -> Endpoint:
    session.expire_all()
    endpoint: Endpoint | None = await session.scalar(select(Endpoint))
    assert endpoint is not None
    return endpoint


async def test_the_breaker_opens_and_waiting_deliveries_keep_their_attempts(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.default = FAILING
    await org.endpoint(receiver.url())
    for n in range(4):
        await org.emit(n=n)

    await pipeline.tick(pipeline.processor(failure_threshold=2))

    # Two failures opened the breaker; the other two were never sent.
    assert len(receiver.requests) == 2
    endpoint = await endpoint_row(session)
    assert endpoint.breaker_state == "open"
    assert endpoint.consecutive_failures == 2
    waiting = [d for d in await deliveries(session) if d.attempts == 0]
    assert len(waiting) == 2
    for delivery in waiting:
        assert delivery.status == "pending"  # not "retrying": no attempt was used
        assert delivery.locked_by is None
        assert 50 < seconds_from_now(delivery.next_attempt_at) <= 60  # after the cool-down
    assert len(await attempts(session)) == 2


async def test_after_the_cooldown_a_successful_probe_closes_the_breaker(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.reply_with(FAILING, FAILING)  # then it recovers
    await org.endpoint(receiver.url())
    for n in range(4):
        await org.emit(n=n)
    processor = pipeline.processor(failure_threshold=2, schedule=[0, 0, 0, 0])
    await pipeline.tick(processor)
    assert (await endpoint_row(session)).breaker_state == "open"

    # The cool-down passes.
    await session.execute(
        text("UPDATE endpoints SET breaker_opened_at = now() - interval '61 seconds'")
    )
    await make_everything_due(session)
    await pipeline.tick(processor)

    endpoint = await endpoint_row(session)
    assert endpoint.breaker_state == "closed"
    assert endpoint.consecutive_failures == 0
    assert endpoint.breaker_opened_at is None
    assert {d.status for d in await deliveries(session)} == {"succeeded"}


async def test_a_failed_probe_reopens_the_breaker_and_nothing_else_is_sent(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    receiver.default = FAILING
    await org.endpoint(receiver.url())
    for n in range(4):
        await org.emit(n=n)
    processor = pipeline.processor(failure_threshold=2, schedule=[0, 0, 0, 0])
    await pipeline.tick(processor)
    await session.execute(
        text("UPDATE endpoints SET breaker_opened_at = now() - interval '61 seconds'")
    )
    await make_everything_due(session)
    sent_before = len(receiver.requests)

    await pipeline.tick(processor)

    assert len(receiver.requests) == sent_before + 1  # only the probe went out
    endpoint = await endpoint_row(session)
    assert endpoint.breaker_state == "open"
    assert endpoint.breaker_opened_at is not None
    assert seconds_from_now(endpoint.breaker_opened_at) > -5  # the cool-down restarted


# ------------------------------------------------------------------- rate limit
async def test_the_rate_limit_holds_back_the_backlog_without_using_attempts(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    await org.endpoint(receiver.url(), rate_limit_per_sec=2)
    for n in range(6):
        await org.emit(n=n)

    await pipeline.tick()

    assert len(receiver.requests) == 2  # the burst the bucket allows
    held = [d for d in await deliveries(session) if d.status != "succeeded"]
    assert len(held) == 4
    for delivery in held:
        assert delivery.status == "pending"
        assert delivery.attempts == 0
        assert 0 < seconds_from_now(delivery.next_attempt_at) < 5
    assert len(await attempts(session)) == 2


async def test_an_endpoint_without_a_rate_limit_is_not_throttled(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline
) -> None:
    await org.endpoint(receiver.url())
    for n in range(6):
        await org.emit(n=n)

    await pipeline.tick()

    assert len(receiver.requests) == 6


# ----------------------------------------------------------- dead-letter, replay
async def test_see_failure_then_replay_then_success(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    """The full support story: a delivery dies, the customer fixes their server,
    and replays it from the dead-letter queue."""
    receiver.default = FAILING
    await org.endpoint(receiver.url())
    await org.emit()
    processor = pipeline.processor(schedule=[0, 0])
    await pipeline.tick(processor)
    await pipeline.tick(processor)
    dead = await only_delivery(session)
    assert dead.status == "dead"

    listed = (await org.client.get("/v1/deliveries", params={"status": "dead"})).json()
    assert [item["id"] for item in listed["items"]] == [str(dead.id)]
    assert listed["items"][0]["last_error"] == "http_status: the receiver answered HTTP 500"

    receiver.default = Reply()  # the customer fixes their receiver
    replayed = await org.client.post(f"/v1/deliveries/{dead.id}/replay")
    assert replayed.status_code == 200
    assert replayed.json()["status"] == "pending"
    await pipeline.tick(processor)

    detail = (await org.client.get(f"/v1/deliveries/{dead.id}")).json()
    assert detail["status"] == "succeeded"
    assert detail["attempts"] == 1  # a replay starts a fresh schedule
    # ...but the whole history is still there.
    assert [a["status_code"] for a in detail["attempt_log"]] == [500, 500, 200]
    assert detail["payload"] == {"order_id": 42}


# ------------------------------------------------- built-in receiver, demo mode
async def test_the_built_in_receiver_is_reachable_even_under_the_strict_policy(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    """Our own receiver lives on a private address on purpose."""
    await org.endpoint(receiver.url("/receiver/some-token"))
    await org.emit()

    await pipeline.tick(
        pipeline.processor(allow_private=False, trusted_url_prefix=receiver.url("/receiver/"))
    )

    assert [r.path for r in receiver.requests] == ["/receiver/some-token"]
    assert (await only_delivery(session)).status == "succeeded"


async def test_the_trust_does_not_extend_to_other_paths_on_the_same_host(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    await org.endpoint(receiver.url("/internal-admin"))
    await org.emit()

    await pipeline.tick(
        pipeline.processor(allow_private=False, trusted_url_prefix=receiver.url("/receiver/"))
    )

    assert receiver.requests == []
    (attempt,) = await attempts(session)
    assert attempt.error_kind == "ssrf_blocked"


async def test_demo_mode_delivers_only_to_the_built_in_receiver(
    org: Org, receiver: FakeReceiver, pipeline: Pipeline, session: AsyncSession
) -> None:
    await org.endpoint(receiver.url("/receiver/demo-token"), event_types=["to.receiver"])
    await org.endpoint(receiver.url("/somewhere-else"), event_types=["to.elsewhere"])
    await org.emit("to.receiver")
    await org.emit("to.elsewhere")

    await pipeline.tick(
        pipeline.processor(trusted_url_prefix=receiver.url("/receiver/"), only_trusted=True)
    )

    assert [r.path for r in receiver.requests] == ["/receiver/demo-token"]
    blocked = [d for d in await deliveries(session) if d.status != "succeeded"]
    assert len(blocked) == 1
    assert "demo mode" in (blocked[0].last_error or "")
