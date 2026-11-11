import os
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from relay.core.config import Settings
from relay.main import create_app

# Locally these come from `docker compose up -d postgres redis`; in CI from the
# workflow's service containers. Redis db 15 keeps test data away from dev data.
TEST_DATABASE_URL = os.environ.get(
    "RELAY_TEST_DATABASE_URL", "postgresql+asyncpg://relay:relay@localhost:5433/relay"
)
TEST_REDIS_URL = os.environ.get("RELAY_TEST_REDIS_URL", "redis://localhost:6379/15")


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
