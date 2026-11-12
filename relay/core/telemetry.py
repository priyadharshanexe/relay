"""Distributed tracing with OpenTelemetry.

A *trace* is the story of one piece of work as it crosses processes; each step in
it is a *span* with a start, an end and a parent. For one webhook the trace is:

    POST /v1/events            (API process)
      INSERT event, deliveries (database)
      relay.deliver            (worker process, minutes or hours later)
        POST https://customer  (outbound HTTP)
        INSERT attempt, UPDATE (database)

The API and the worker are different processes, so the link between them has to
be carried explicitly. When an event is ingested, the current trace's id is saved
on the event row (the W3C ``traceparent`` string). When a worker later delivers
it, the worker reads that string back and continues the same trace.

Tracing is off unless ``RELAY_OTLP_ENDPOINT`` is set: the instrumentation calls
below then do nothing measurable.
"""

from collections.abc import Sequence
from typing import Any

from fastapi import FastAPI
from httpx import AsyncClient
from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.sampling import (
    Decision,
    ParentBased,
    Sampler,
    SamplingResult,
)
from opentelemetry.trace import Link, SpanKind, Status, StatusCode, Tracer
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.trace.span import TraceState
from opentelemetry.util.types import Attributes
from sqlalchemy import Connection, event
from sqlalchemy.engine import ExceptionContext
from sqlalchemy.ext.asyncio import AsyncEngine

from relay import __version__
from relay.core.config import Settings

_propagator = TraceContextTextMapPropagator()
_ROOT_KINDS = frozenset({SpanKind.SERVER, SpanKind.CONSUMER})


class EntryPointsOnly(Sampler):
    """Start a trace only for real units of work.

    A trace may begin with an incoming request (SERVER) or a delivery picked up
    by a worker (CONSUMER). Anything else that has no parent is background noise:
    the worker polling the queue every second, Prometheus reading queue depth,
    health checks. Recording those would bury the useful traces.
    """

    def should_sample(
        self,
        parent_context: Context | None,
        trace_id: int,
        name: str,
        kind: SpanKind | None = None,
        attributes: Attributes = None,
        links: Sequence[Link] | None = None,
        trace_state: TraceState | None = None,
    ) -> SamplingResult:
        decision = Decision.RECORD_AND_SAMPLE if kind in _ROOT_KINDS else Decision.DROP
        return SamplingResult(decision, attributes, trace_state)

    def get_description(self) -> str:
        return "EntryPointsOnly"


def build_provider(
    service_name: str, environment: str, processors: Sequence[SpanProcessor]
) -> TracerProvider:
    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": service_name,
                "service.version": __version__,
                "deployment.environment": environment,
            }
        ),
        # A span with a parent follows its parent's decision; a span without one
        # is kept only if it is an entry point.
        sampler=ParentBased(root=EntryPointsOnly()),
    )
    for processor in processors:
        provider.add_span_processor(processor)
    return provider


def configure_tracing(settings: Settings, service_name: str) -> TracerProvider | None:
    """Send traces to the OTLP endpoint, if one is configured."""
    if not settings.otlp_endpoint:
        return None
    exporter = OTLPSpanExporter(endpoint=settings.otlp_endpoint.rstrip("/") + "/v1/traces")
    # Batch: spans are queued and exported in the background, so tracing never
    # adds a network call to a request or a delivery.
    provider = build_provider(service_name, settings.environment, [BatchSpanProcessor(exporter)])
    trace.set_tracer_provider(provider)
    return provider


def get_tracer() -> Tracer:
    return trace.get_tracer("relay")


def instrument_app(app: FastAPI) -> None:
    FastAPIInstrumentor.instrument_app(app, excluded_urls="healthz,readyz,metrics")


_SPAN_KEY = "relay_otel_spans"


def instrument_engine(engine: AsyncEngine) -> None:
    """Record one span per SQL statement, using SQLAlchemy's own event hooks.

    (The OpenTelemetry SQLAlchemy plugin does not support SQLAlchemy 2.1 yet.)
    Only the statement text is recorded, with its ``$1``-style placeholders:
    parameter values, which can be personal data or secrets, never leave the
    process.
    """
    sync_engine = engine.sync_engine

    def before(conn: Connection, _cursor: Any, statement: str, *_: Any) -> None:
        span = get_tracer().start_span(
            statement.split(None, 1)[0].upper() if statement.strip() else "SQL",
            kind=SpanKind.CLIENT,
            attributes={"db.system": "postgresql", "db.statement": statement[:2000]},
        )
        conn.info.setdefault(_SPAN_KEY, []).append(span)

    def after(conn: Connection, *_: Any) -> None:
        spans = conn.info.get(_SPAN_KEY)
        if spans:
            spans.pop().end()

    def failed(context: ExceptionContext) -> None:
        conn = context.connection
        spans = conn.info.get(_SPAN_KEY) if conn is not None else None
        if spans:
            span = spans.pop()
            span.set_status(Status(StatusCode.ERROR, type(context.original_exception).__name__))
            span.end()

    event.listen(sync_engine, "before_cursor_execute", before)
    event.listen(sync_engine, "after_cursor_execute", after)
    event.listen(sync_engine, "handle_error", failed)


def instrument_http_client(client: AsyncClient) -> None:
    HTTPXClientInstrumentor.instrument_client(client)


def current_traceparent() -> str | None:
    """The active trace as a W3C ``traceparent`` string, to store for later."""
    carrier: dict[str, str] = {}
    _propagator.inject(carrier)
    return carrier.get("traceparent")


def context_from(traceparent: str | None) -> Context:
    """Turn a stored ``traceparent`` back into a context to continue its trace.
    Missing or malformed values give an empty context, which starts a new trace."""
    return _propagator.extract({"traceparent": traceparent} if traceparent else {})
