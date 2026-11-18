"""Retention: delete old events, with their deliveries and attempts.

An event is deleted once it is older than the retention period AND none of its
deliveries is still on its way (pending, in flight or retrying). Deleting the
event removes its deliveries and attempts too (ON DELETE CASCADE).

Work is done in small batches, each in its own short transaction, so a large
backlog never holds locks for long or blocks the workers.

Concurrency. Two things could change an old delivery while we look at it:

* a person replaying a dead delivery, which sets it back to pending;
* a worker recording an attempt.

So each batch locks the candidate events (SKIP LOCKED: another worker running
retention at the same time takes different rows), then locks their deliveries
FOR UPDATE and reads their status *after* the lock is granted. A replay that
committed first is seen, and the event is kept. A replay that comes after waits
for us, then finds nothing to replay. Either way nothing a person asked for is
silently thrown away.
"""

from datetime import datetime
from typing import Any, cast

from sqlalchemy import CursorResult, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from relay.core import metrics
from relay.core.logging import get_logger

log = get_logger("relay.retention")

# Deliveries in these states are still in progress: their event must stay.
_UNFINISHED = "('pending', 'in_flight', 'retrying')"

_PURGE_BATCH = text(
    f"""
    WITH candidates AS (
        SELECT e.id
        FROM events e
        WHERE e.created_at < :cutoff
          AND NOT EXISTS (
              SELECT 1 FROM deliveries d
              WHERE d.event_id = e.id AND d.status IN {_UNFINISHED}
          )
        ORDER BY e.created_at
        LIMIT :batch_size
        FOR UPDATE SKIP LOCKED
    ),
    locked_deliveries AS (
        -- Lock, then read: FOR UPDATE returns each row as it is once the lock is
        -- ours, so a status changed by a transaction that just committed is seen.
        SELECT d.event_id, d.status
        FROM deliveries d
        WHERE d.event_id IN (SELECT id FROM candidates)
        FOR UPDATE
    )
    DELETE FROM events
    WHERE id IN (SELECT id FROM candidates)
      AND id NOT IN (
          SELECT event_id FROM locked_deliveries WHERE status IN {_UNFINISHED}
      )
    """  # noqa: S608 - the only interpolated value is the constant above
)


async def purge_batch(session: AsyncSession, *, cutoff: datetime, batch_size: int) -> int:
    """Delete at most ``batch_size`` old, finished events. Commits. Returns how many."""
    result = cast(
        CursorResult[Any],
        await session.execute(_PURGE_BATCH, {"cutoff": cutoff, "batch_size": batch_size}),
    )
    await session.commit()
    return int(result.rowcount)


async def purge_old_events(
    sessions: async_sessionmaker[AsyncSession],
    *,
    cutoff: datetime,
    batch_size: int,
    max_batches: int = 1000,
) -> int:
    """Delete every finished event created before ``cutoff``. Returns how many.

    ``max_batches`` bounds one run, so a huge backlog is worked off over several
    runs instead of keeping one worker busy indefinitely.
    """
    total = 0
    for _ in range(max_batches):
        async with sessions() as session:
            deleted = await purge_batch(session, cutoff=cutoff, batch_size=batch_size)
        total += deleted
        if deleted:
            metrics.EVENTS_PURGED.inc(deleted)
        if deleted < batch_size:
            break
    if total:
        log.info("retention.events_deleted", count=total, cutoff=cutoff.isoformat())
    return total
