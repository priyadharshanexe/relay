from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from httpx import AsyncClient
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import Decision
from opentelemetry.trace import SpanContext, SpanKind, StatusCode
from redis.asyncio import Redis
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from relay.core.config import Settings
from relay.core.logging import _add_trace_id
from relay.core.telemetry import (
    EntryPointsOnly,
    configure_tracing,
    context_from,
    current_traceparent,
    get_tracer,
    instrument_engine,
    instrument_http_client,
)
from relay.db.models import Event
from relay.worker.claim import claim_due
from tests.conftest import SPANS, TEST_REDIS_URL, make_settings
from tests.integration.fake_receiver import FakeReceiver, Reply
from tests.integration.helpers import bearer, create_api_key, create_endpoint, register
from tests.integration.test_worker import Pipeline

pytestmark = pytest.mark.integration


@pytest.fixture
def settings() -> Settings:
    return make_settings(endpoints_allow_private_networks=True)


@pytest.fixture
def spans() -> Iterator[InMemorySpanExporter]:
    SPANS.clear()
    yield SPANS
    SPANS.clear()


@pytest.fixture
async def receiver() -> AsyncIterator[FakeReceiver]:
    receiver = FakeReceiver()
    await receiver.start()
    try:
        yield receiver
    finally:
        await receiver.stop()


@pytest.fixture
async def pipeline(engine: AsyncEngine) -> AsyncIterator[Pipeline]:
    instrument_engine(engine)
    redis = Redis.from_url(TEST_REDIS_URL, decode_responses=True)
    pipeline = Pipeline(engine, redis)
    try:
        yield pipeline
    finally:
        await pipeline.aclose()
        await redis.aclose()


def traced_processor(pipeline: Pipeline, **kwargs: Any) -> Any:
    processor = pipeline.processor(**kwargs)
    instrument_http_client(pipeline._senders[-1].client)
    return processor


def span_context(span: ReadableSpan) -> SpanContext:
    context = span.get_span_context()
    assert context is not None
    return context


def trace_id(span: ReadableSpan) -> str:
    return format(span_context(span).trace_id, "032x")


def attempt_number(span: ReadableSpan) -> int:
    assert span.attributes is not None
    value = span.attributes["relay.attempt"]
    assert isinstance(value, int)
    return value


def named(spans: InMemorySpanExporter, name: str) -> list[ReadableSpan]:
    return [span for span in spans.get_finished_spans() if span.name == name]


def one(spans: InMemorySpanExporter, name: str) -> ReadableSpan:
    (span,) = named(spans, name)
    return span


async def ingest(client: AsyncClient, key: str) -> str:
    response = await client.post(
        "/v1/events", json={"type": "order.paid", "payload": {"n": 1}}, headers=bearer(key)
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


# ------------------------------------------------------------------- ingestion
async def test_ingesting_an_event_saves_the_trace_it_belongs_to(
    client: AsyncClient, session: AsyncSession, spans: InMemorySpanExporter
) -> None:
    await register(client)
    key = await create_api_key(client)
    spans.clear()

    await ingest(client, key)

    request_span = one(spans, "POST /v1/events")
    assert request_span.kind is SpanKind.SERVER
    stored = await session.scalar(select(Event.traceparent))
    assert stored is not None
    version, stored_trace_id, _parent_id, flags = stored.split("-")
    assert version == "00"
    assert int(flags, 16) & 1  # the "sampled" bit: the worker will record its part too
    assert stored_trace_id == trace_id(request_span)


async def test_the_database_work_of_a_request_is_part_of_its_trace(
    client: AsyncClient, spans: InMemorySpanExporter
) -> None:
    await register(client)
    key = await create_api_key(client)
    spans.clear()

    await ingest(client, key)

    request_span = one(spans, "POST /v1/events")
    database = [
        span
        for span in spans.get_finished_spans()
        if span.kind is SpanKind.CLIENT and trace_id(span) == trace_id(request_span)
    ]
    statements = " ".join(
        str(span.attributes.get("db.statement", "")) for span in database if span.attributes
    )
    assert "INSERT INTO events" in statements
    assert "INSERT INTO deliveries" in statements


# -------------------------------------------------------------------- delivery
async def test_the_worker_continues_the_trace_that_ingestion_started(
    client: AsyncClient, receiver: FakeReceiver, pipeline: Pipeline, spans: InMemorySpanExporter
) -> None:
    """The whole point: one trace from the API request to the outbound call."""
    await register(client)
    key = await create_api_key(client)
    endpoint = await create_endpoint(client, url=receiver.url())
    spans.clear()

    event_id = await ingest(client, key)
    await pipeline.tick(traced_processor(pipeline))

    request_span = one(spans, "POST /v1/events")
    deliver = one(spans, "relay.deliver")
    assert trace_id(deliver) == trace_id(request_span)  # same trace, two processes
    assert deliver.kind is SpanKind.CONSUMER
    assert deliver.parent is not None
    assert deliver.status.status_code is not StatusCode.ERROR
    assert deliver.attributes is not None
    assert deliver.attributes["relay.event_id"] == event_id
    assert deliver.attributes["relay.event_type"] == "order.paid"
    assert deliver.attributes["relay.endpoint_id"] == endpoint["id"]
    assert deliver.attributes["relay.attempt"] == 1
    assert deliver.attributes["http.response.status_code"] == 200

    # The outbound HTTP call is a child of the delivery span...
    outbound = [
        span
        for span in spans.get_finished_spans()
        if span.kind is SpanKind.CLIENT
        and span.parent is not None
        and span.parent.span_id == span_context(deliver).span_id
        and span.name == "POST"
    ]
    assert len(outbound) == 1
    # ...and so is recording the result.
    recorded = [
        str(span.attributes.get("db.statement", ""))
        for span in spans.get_finished_spans()
        if span.attributes
        and span.parent is not None
        and span.parent.span_id == span_context(deliver).span_id
    ]
    assert any("INSERT INTO attempts" in statement for statement in recorded)


async def test_a_failed_delivery_is_marked_as_an_error_in_the_trace(
    client: AsyncClient, receiver: FakeReceiver, pipeline: Pipeline, spans: InMemorySpanExporter
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client, url=receiver.url())
    receiver.default = Reply(status=503)
    await ingest(client, key)
    spans.clear()

    await pipeline.tick(traced_processor(pipeline))

    deliver = one(spans, "relay.deliver")
    assert deliver.status.status_code is StatusCode.ERROR
    assert deliver.attributes is not None
    assert deliver.attributes["relay.error_kind"] == "http_status"
    assert deliver.attributes["http.response.status_code"] == 503


async def test_every_retry_joins_the_same_trace(
    client: AsyncClient, receiver: FakeReceiver, pipeline: Pipeline, spans: InMemorySpanExporter
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client, url=receiver.url())
    receiver.reply_with(Reply(status=500), Reply(status=500))  # then 200
    spans.clear()
    processor = traced_processor(pipeline, schedule=[0, 0, 0, 0])

    await ingest(client, key)
    for _ in range(3):
        await pipeline.tick(processor)

    request_span = one(spans, "POST /v1/events")
    attempts = sorted(named(spans, "relay.deliver"), key=attempt_number)
    assert [attempt_number(span) for span in attempts] == [1, 2, 3]
    assert {trace_id(span) for span in attempts} == {trace_id(request_span)}
    assert [span.status.status_code is StatusCode.ERROR for span in attempts] == [True, True, False]


@pytest.mark.parametrize("stored", [None, "garbage", "00-zzzz-zzzz-01", ""])
async def test_an_event_without_usable_trace_context_still_delivers_in_a_new_trace(
    client: AsyncClient,
    receiver: FakeReceiver,
    pipeline: Pipeline,
    session: AsyncSession,
    spans: InMemorySpanExporter,
    stored: str | None,
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client, url=receiver.url())
    await ingest(client, key)
    request_trace = trace_id(one(spans, "POST /v1/events"))
    await session.execute(text("UPDATE events SET traceparent = :value"), {"value": stored})
    await session.commit()

    await pipeline.tick(traced_processor(pipeline))

    deliver = one(spans, "relay.deliver")
    assert deliver.parent is None  # a fresh trace
    assert trace_id(deliver) != request_trace
    assert len(receiver.requests) == 1  # and the webhook still went out


# ---------------------------------------------------------------------- noise
async def test_background_polling_does_not_create_traces(
    pipeline: Pipeline, spans: InMemorySpanExporter
) -> None:
    """A worker polls the queue every second. Those queries have no parent and
    must not each become a trace."""
    for _ in range(3):
        await claim_due(pipeline.sessions, worker_id="w", limit=10, lock_seconds=60)

    assert spans.get_finished_spans() == ()


async def test_health_checks_and_scrapes_are_not_traced(
    client: AsyncClient, spans: InMemorySpanExporter
) -> None:
    spans.clear()

    for path in ("/healthz", "/readyz", "/metrics"):
        await client.get(path)

    assert spans.get_finished_spans() == ()


async def test_ordinary_requests_are_traced(
    client: AsyncClient, spans: InMemorySpanExporter
) -> None:
    await client.get("/v1/auth/me")

    assert one(spans, "GET /v1/auth/me").kind is SpanKind.SERVER


# ---------------------------------------------------------------- unit pieces
def test_the_sampler_starts_traces_only_at_entry_points() -> None:
    sampler = EntryPointsOnly()

    def decide(kind: SpanKind) -> Decision:
        return sampler.should_sample(None, 1, "span", kind).decision

    assert decide(SpanKind.SERVER) is Decision.RECORD_AND_SAMPLE
    assert decide(SpanKind.CONSUMER) is Decision.RECORD_AND_SAMPLE
    assert decide(SpanKind.CLIENT) is Decision.DROP
    assert decide(SpanKind.INTERNAL) is Decision.DROP


def test_trace_context_survives_being_stored_as_text(spans: InMemorySpanExporter) -> None:
    assert current_traceparent() is None  # nothing active

    with get_tracer().start_as_current_span("work", kind=SpanKind.SERVER) as span:
        stored = current_traceparent()
    assert stored is not None

    restored = trace.get_current_span(context_from(stored)).get_span_context()
    assert restored.trace_id == span.get_span_context().trace_id
    assert restored.span_id == span.get_span_context().span_id
    assert restored.is_remote


def test_log_lines_carry_the_trace_id_only_inside_a_trace(spans: InMemorySpanExporter) -> None:
    assert "trace_id" not in _add_trace_id(None, "info", {"event": "outside"})

    with get_tracer().start_as_current_span("work", kind=SpanKind.SERVER) as span:
        line = _add_trace_id(None, "info", {"event": "inside"})

    assert line["trace_id"] == format(span.get_span_context().trace_id, "032x")


def test_tracing_is_off_unless_an_endpoint_is_configured() -> None:
    assert make_settings().otlp_endpoint is None
    assert configure_tracing(make_settings(), "relay-test") is None
