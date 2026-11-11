"""Small fixed-window limiter for abuse-prone routes (login, sign-up).

Not to be confused with ``relay.domain.rate_limit``, which shapes outgoing
deliveries. This one just counts requests per key per time window in Redis.
"""

from redis.asyncio import Redis
from redis.exceptions import RedisError

from relay.core.errors import AppError
from relay.core.logging import get_logger

log = get_logger("relay.throttle")


async def throttle(redis: Redis, key: str, *, limit: int, window_seconds: int) -> None:
    """Count one hit on ``key``; raise a 429 once ``limit`` is exceeded in the window."""
    name = f"throttle:{key}"
    try:
        # SET NX EX + INCR in one transaction: the key can never exist without an
        # expiry, so nobody can be locked out forever.
        async with redis.pipeline(transaction=True) as pipe:
            pipe.set(name, 0, ex=window_seconds, nx=True)
            pipe.incr(name)
            pipe.ttl(name)
            _, count, ttl = await pipe.execute()
    except RedisError as exc:
        # Fail open: a Redis outage should not stop people logging in.
        log.warning("throttle.redis_unavailable", error=type(exc).__name__)
        return

    if int(count) > limit:
        retry_after = max(int(ttl), 1)
        raise AppError(
            429,
            "rate_limited",
            "Too many attempts. Please wait and try again.",
            {"retry_after_seconds": retry_after},
            headers={"Retry-After": str(retry_after)},
        )
