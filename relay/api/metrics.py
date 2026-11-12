"""``GET /metrics`` for Prometheus."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from relay.api.deps import get_engine
from relay.core import metrics
from relay.core.logging import get_logger

router = APIRouter(tags=["health"])
log = get_logger("relay.metrics")

_QUEUE_DEPTH = text(
    """
    SELECT status, count(*) AS deliveries
    FROM deliveries
    WHERE status IN ('pending', 'retrying', 'in_flight')
    GROUP BY status
    """
)

# "Overdue" only counts deliveries a worker could take right now: due, and for an
# active endpoint. Deliveries waiting on a paused endpoint or on a retry delay
# are not a sign that workers are falling behind.
_OLDEST_DUE = text(
    """
    SELECT coalesce(extract(epoch FROM now() - min(d.next_attempt_at)), 0)
    FROM deliveries d
    JOIN endpoints e ON e.id = d.endpoint_id
    WHERE d.status IN ('pending', 'retrying')
      AND d.next_attempt_at <= now()
      AND e.status = 'active'
    """
)

_OPEN_BREAKERS = text("SELECT count(*) FROM endpoints WHERE breaker_state <> 'closed'")


async def refresh_queue_gauges(engine: AsyncEngine) -> None:
    """Read the queue's state from the database into the gauges."""
    async with engine.connect() as connection:
        depth = {row.status: row.deliveries for row in await connection.execute(_QUEUE_DEPTH)}
        for status in metrics.QUEUE_STATUSES:
            metrics.QUEUE_DEPTH.labels(status=status).set(depth.get(status, 0))
        oldest = await connection.scalar(_OLDEST_DUE)
        metrics.OLDEST_PENDING_AGE.set(max(float(oldest or 0), 0.0))
        metrics.BREAKER_OPEN_ENDPOINTS.set(int(await connection.scalar(_OPEN_BREAKERS) or 0))


@router.get("/metrics", include_in_schema=False)
async def prometheus_metrics(engine: Annotated[AsyncEngine, Depends(get_engine)]) -> Response:
    try:
        await refresh_queue_gauges(engine)
    except Exception as exc:
        # Keep serving the in-memory metrics even if the database is down: that
        # is exactly when someone will be looking at them.
        log.warning("metrics.queue_gauges_unavailable", error=type(exc).__name__)
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
