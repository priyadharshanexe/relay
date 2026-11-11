"""Liveness and readiness probes.

* ``/healthz`` - the process is up. Never touches dependencies, so a database
  outage doesn't make the orchestrator kill healthy API processes.
* ``/readyz`` - the process can serve traffic: PostgreSQL and Redis both answer
  within a short timeout. Returns 503 otherwise.
"""

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from relay.api.deps import get_engine, get_redis
from relay.core.logging import get_logger

router = APIRouter(tags=["health"])
log = get_logger("relay.health")

READINESS_TIMEOUT_SECONDS = 2.0

CheckStatus = Literal["ok", "unavailable"]


class HealthResponse(BaseModel):
    status: Literal["ok"]


class ReadinessResponse(BaseModel):
    status: CheckStatus
    checks: dict[str, CheckStatus]


async def database_is_ready(engine: AsyncEngine) -> bool:
    try:
        async with asyncio.timeout(READINESS_TIMEOUT_SECONDS), engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:
        # Log the type only: driver messages can include connection details.
        log.warning("readiness.database_unavailable", error=type(exc).__name__)
        return False
    return True


async def redis_is_ready(redis: Redis) -> bool:
    try:
        async with asyncio.timeout(READINESS_TIMEOUT_SECONDS):
            await redis.ping()
    except Exception as exc:
        log.warning("readiness.redis_unavailable", error=type(exc).__name__)
        return False
    return True


@router.get("/healthz")
async def healthz() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/readyz", responses={503: {"model": ReadinessResponse}})
async def readyz(
    response: Response,
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    redis: Annotated[Redis, Depends(get_redis)],
) -> ReadinessResponse:
    db_ok, redis_ok = await asyncio.gather(database_is_ready(engine), redis_is_ready(redis))
    checks: dict[str, CheckStatus] = {
        "database": "ok" if db_ok else "unavailable",
        "redis": "ok" if redis_ok else "unavailable",
    }
    ready = db_ok and redis_ok
    if not ready:
        response.status_code = 503
    return ReadinessResponse(status="ok" if ready else "unavailable", checks=checks)
