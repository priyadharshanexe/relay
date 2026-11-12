import os
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from opentelemetry import trace
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from relay.core.config import Settings
from relay.core.telemetry import build_provider
from relay.main import create_app

# Locally these come from `docker compose up -d postgres redis`; in CI from the
# workflow's service containers. Tests use their own database (relay_test, rebuilt
# from the migrations on every run) and Redis db 15, so dev data is never touched.
TEST_DATABASE_URL = os.environ.get(
    "RELAY_TEST_DATABASE_URL", "postgresql+asyncpg://relay:relay@localhost:5433/relay_test"
)
TEST_REDIS_URL = os.environ.get("RELAY_TEST_REDIS_URL", "redis://localhost:6379/15")


# Tracing in tests: spans are collected in memory instead of being exported.
# The provider is process-wide and can only be installed once, so it lives here.
SPANS = InMemorySpanExporter()
trace.set_tracer_provider(build_provider("relay-test", "test", [SimpleSpanProcessor(SPANS)]))


def make_settings(**overrides: Any) -> Settings:
    """Settings for tests. ``model_validate`` ignores env vars and .env files, so
    tests behave the same on every machine."""
    values: dict[str, Any] = {
        "environment": "test",
        "database_url": TEST_DATABASE_URL,
        "redis_url": TEST_REDIS_URL,
        "log_level": "WARNING",
        "log_json": False,
    }
    values.update(overrides)
    return Settings.model_validate(values)


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    # Run the lifespan so app.state has its engine and Redis client. Both connect
    # lazily, so tests that don't touch them need no running services.
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        yield client
