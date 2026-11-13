"""Live delivery updates, from the workers to the dashboard.

Workers and API servers are separate processes, possibly on separate machines, so
they need something in between. Redis pub/sub is that something: a worker
publishes a small message after each attempt, and every API process with a
dashboard connected for that organisation forwards it to the browser.

Pub/sub is fire-and-forget: a message published while nobody is listening is
gone. That is fine here, because the feed is only a convenience. The database
remains the source of truth, and the dashboard reads history from it.
"""

import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError

from relay.core.logging import get_logger

log = get_logger("relay.live")


def channel_for(org_id: uuid.UUID) -> str:
    # One channel per organisation: a subscriber can only ever receive its own
    # organisation's updates.
    return f"relay:live:{org_id}"


class LivePublisher:
    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def publish(self, org_id: uuid.UUID, message: dict[str, Any]) -> None:
        try:
            await self._redis.publish(channel_for(org_id), json.dumps(message))
        except RedisError as exc:
            # The live feed must never get in the way of delivering webhooks.
            log.warning("live.publish_failed", error=type(exc).__name__)


async def live_updates(
    redis: Redis,
    org_id: uuid.UUID,
    *,
    heartbeat_seconds: float,
    max_seconds: float | None = None,
) -> AsyncIterator[dict[str, Any] | None]:
    """Yield this organisation's updates as they happen.

    Yields ``None`` whenever ``heartbeat_seconds`` pass in silence, so the caller
    can send a keep-alive and notice a browser that has gone away.

    Ends after ``max_seconds``. The caller's permission was checked once, when
    the stream opened; a stream with no end would keep sending data long after
    that person logged out or was removed. Ending it makes the browser
    reconnect, and reconnecting means being checked again.
    """
    deadline = None if max_seconds is None else time.monotonic() + max_seconds
    pubsub = redis.pubsub()
    await pubsub.subscribe(channel_for(org_id))
    try:
        while deadline is None or time.monotonic() < deadline:
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=heartbeat_seconds
            )
            if message is None:
                yield None
                continue
            try:
                yield json.loads(message["data"])
            except (TypeError, ValueError):
                continue
    finally:
        await pubsub.aclose()  # type: ignore[no-untyped-call]
