"""Fixtures for tests that need a real database.

Once per test run the ``relay_test`` database is dropped, recreated and built by
running the real migrations, so the migrations themselves are tested on every run.
After each test every table is emptied, so tests can't affect one another.
"""

import asyncio
from collections.abc import AsyncIterator, Callable
from concurrent.futures import ThreadPoolExecutor

import asyncpg
import pytest
from alembic import command
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from redis.asyncio import Redis
from sqlalchemy import make_url, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from relay.db.migrate import alembic_config
from relay.db.models import Base
from tests.conftest import TEST_DATABASE_URL, TEST_REDIS_URL


def run_in_thread[T](fn: Callable[[], T]) -> T:
    """Alembic starts its own event loop, which must not happen on the thread
    that runs the test loop."""
    with ThreadPoolExecutor(max_workers=1) as executor:
        return executor.submit(fn).result()


def upgrade_database(revision: str = "head") -> None:
    command.upgrade(alembic_config(TEST_DATABASE_URL), revision)


def downgrade_database(revision: str) -> None:
    command.downgrade(alembic_config(TEST_DATABASE_URL), revision)


async def _recreate_test_database() -> None:
    url = make_url(TEST_DATABASE_URL)
    name = url.database
    assert name, "the test database URL must name a database"
    assert name.endswith("_test"), f"refusing to drop {name!r}: not a test database"
    connection = await asyncpg.connect(
        host=url.host, port=url.port, user=url.username, password=url.password, database="postgres"
    )
    try:
        await connection.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await connection.execute(f'CREATE DATABASE "{name}"')
    finally:
        await connection.close()


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    run_in_thread(lambda: asyncio.run(_recreate_test_database()))
    run_in_thread(upgrade_database)


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=NullPool)
    try:
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture(autouse=True)
async def clean_state(engine: AsyncEngine) -> AsyncIterator[None]:
    """Empty every table and the test Redis database after each test."""
    yield
    tables = ", ".join(table.name for table in Base.metadata.sorted_tables)
    async with engine.begin() as connection:
        await connection.execute(text(f"TRUNCATE {tables} CASCADE"))
    redis = Redis.from_url(TEST_REDIS_URL)
    try:
        await redis.flushdb()
    finally:
        await redis.aclose()


@pytest.fixture
async def session(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        yield session


@pytest.fixture
async def other_client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """A second browser (or a machine) talking to the same app as ``client``."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client
