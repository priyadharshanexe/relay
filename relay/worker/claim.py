"""Claiming work from the queue, and recovering work whose worker died.

The ``deliveries`` table is the queue. Many worker processes poll it at once, so
two things must hold:

* **No delivery is taken by two workers.** ``FOR UPDATE SKIP LOCKED`` makes each
  worker lock the rows it selects and silently skip rows another worker has
  already locked, so concurrent claims never overlap and never wait on each other.
* **No delivery is lost if a worker crashes.** A claim is a lease
  (``locked_until``), not a permanent mark. A crashed worker simply stops
  renewing; once the lease expires, ``sweep_expired`` puts the delivery back.

The claim commits immediately. The HTTP call happens afterwards with no
transaction open, so a slow receiver never holds a database connection.
"""

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# Deliveries for paused or disabled endpoints are left alone: they simply wait.
_CLAIM = text(
    """
    UPDATE deliveries
    SET status = 'in_flight',
        locked_until = now() + make_interval(secs => :lock_seconds),
        locked_by = :worker_id,
        updated_at = now()
    WHERE id IN (
        SELECT d.id
        FROM deliveries d
        JOIN endpoints e ON e.id = d.endpoint_id
        WHERE d.status IN ('pending', 'retrying')
          AND d.next_attempt_at <= now()
          AND e.status = 'active'
        ORDER BY d.next_attempt_at
        LIMIT :limit
        FOR UPDATE OF d SKIP LOCKED
    )
    RETURNING id
    """
)

_SWEEP = text(
    """
    UPDATE deliveries
    SET status = CASE WHEN attempts > 0 THEN 'retrying' ELSE 'pending' END,
        locked_until = NULL,
        locked_by = NULL,
        next_attempt_at = now(),
        updated_at = now()
    WHERE status = 'in_flight' AND locked_until < now()
    RETURNING id
    """
)


async def claim_due(
    sessions: async_sessionmaker[AsyncSession],
    *,
    worker_id: str,
    limit: int,
    lock_seconds: int,
) -> list[uuid.UUID]:
    """Lease up to ``limit`` due deliveries to this worker and return their ids."""
    async with sessions() as session:
        result = await session.execute(
            _CLAIM, {"worker_id": worker_id, "limit": limit, "lock_seconds": lock_seconds}
        )
        claimed = [row.id for row in result]
        await session.commit()
    return claimed


async def sweep_expired(sessions: async_sessionmaker[AsyncSession]) -> list[uuid.UUID]:
    """Return deliveries whose lease ran out (their worker died) to the queue.

    The dead worker may already have sent the request without recording it, so
    the receiver can see the message twice. That is the at-least-once guarantee:
    receivers deduplicate on ``webhook-id``.
    """
    async with sessions() as session:
        recovered = [row.id for row in await session.execute(_SWEEP)]
        await session.commit()
    return recovered
