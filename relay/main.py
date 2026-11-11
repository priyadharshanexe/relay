"""FastAPI application factory.

Run with: ``uvicorn --factory relay.main:create_app``
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI

from relay import __version__
from relay.api import api_keys, auth, health, orgs
from relay.core.config import Settings, get_settings
from relay.core.errors import register_exception_handlers
from relay.core.logging import configure_logging, get_logger
from relay.core.middleware import RequestContextMiddleware
from relay.core.redis import create_redis
from relay.db.session import create_engine, create_session_factory

log = get_logger("relay.api")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level, json=settings.log_json)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_engine(settings, application_name="relay-api")
        redis = create_redis(settings)
        app.state.settings = settings
        app.state.engine = engine
        app.state.session_factory = create_session_factory(engine)
        app.state.redis = redis
        log.info("api.started", version=__version__, environment=settings.environment)
        try:
            yield
        finally:
            await redis.aclose()
            await engine.dispose()
            log.info("api.stopped")

    app = FastAPI(
        title="Relay",
        summary="Reliable, signed webhook delivery.",
        version=__version__,
        lifespan=lifespan,
    )
    register_exception_handlers(app)
    app.add_middleware(RequestContextMiddleware)
    app.include_router(health.router)

    v1 = APIRouter(prefix="/v1")
    v1.include_router(auth.router)
    v1.include_router(orgs.router)
    v1.include_router(api_keys.router)
    app.include_router(v1)
    return app
