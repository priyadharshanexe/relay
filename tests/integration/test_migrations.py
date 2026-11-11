"""The migrations and the models must describe the same database."""

import asyncio

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, text
from sqlalchemy.ext.asyncio import AsyncEngine

from relay.db.models import Base
from tests.integration.conftest import downgrade_database, upgrade_database

pytestmark = pytest.mark.integration


async def _table_names(engine: AsyncEngine) -> set[str]:
    async with engine.connect() as connection:
        result = await connection.execute(
            text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
        )
        return {row[0] for row in result}


async def test_migrations_create_every_model_table(engine: AsyncEngine) -> None:
    expected = {table.name for table in Base.metadata.sorted_tables}

    assert await _table_names(engine) == expected | {"alembic_version"}


async def test_models_have_not_drifted_from_migrations(engine: AsyncEngine) -> None:
    """If someone changes a model and forgets the migration, this fails and
    prints the missing operations."""

    def diff(connection: Connection) -> list[object]:
        context = MigrationContext.configure(connection)
        return list(compare_metadata(context, Base.metadata))

    async with engine.connect() as connection:
        differences = await connection.run_sync(diff)

    assert differences == []


async def test_downgrade_removes_everything_and_upgrade_restores_it(engine: AsyncEngine) -> None:
    try:
        await asyncio.to_thread(downgrade_database, "base")
        assert await _table_names(engine) == {"alembic_version"}
    finally:
        await asyncio.to_thread(upgrade_database)

    assert "deliveries" in await _table_names(engine)
