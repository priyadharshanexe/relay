"""Database engine and session factory."""

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from relay.core.config import Settings


def create_engine(settings: Settings, *, application_name: str) -> AsyncEngine:
    """Create the async engine.

    ``application_name`` shows up in ``pg_stat_activity``, so it's easy to see which
    connections belong to the API and which to the workers.
    """
    return create_async_engine(
        settings.database_url,
        pool_size=settings.database_pool_size,
        max_overflow=settings.database_pool_size,
        pool_pre_ping=True,
        pool_recycle=1800,
        connect_args={
            "timeout": 5,
            "server_settings": {"application_name": application_name},
        },
    )


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)
