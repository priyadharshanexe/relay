"""Numbers for the dashboard's overview: delivery activity over the last day.

Everything is computed from the attempts table at request time. Hours with no
activity are present with zeros (generate_series), so a chart never has gaps
and the client never has to fill them in.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from relay.domain.enums import DeliveryStatus

HOURS = 24


@dataclass(frozen=True, slots=True)
class Bucket:
    start: datetime
    succeeded: int
    failed: int
    p95_ms: int | None


@dataclass(frozen=True, slots=True)
class EndpointSeries:
    endpoint_id: uuid.UUID
    succeeded: list[int]
    failed: list[int]


@dataclass(frozen=True, slots=True)
class Overview:
    since: datetime
    buckets: list[Bucket]
    endpoints: list[EndpointSeries]
    deliveries_by_status: dict[str, int]
    events: int
    attempts: int
    successes: int
    p95_ms: int | None


# The hour buckets: from the start of the hour 23 hours ago to the current one.
_BUCKETS = """
    SELECT generate_series(
        date_trunc('hour', CAST(:now AS timestamptz), 'UTC') - interval '23 hours',
        date_trunc('hour', CAST(:now AS timestamptz), 'UTC'),
        interval '1 hour'
    ) AS start
"""

_SERIES = text(
    f"""
    WITH buckets AS ({_BUCKETS}),
    org_attempts AS (
        SELECT a.started_at, a.error_kind, a.duration_ms
        FROM attempts a
        JOIN deliveries d ON d.id = a.delivery_id
        WHERE d.org_id = :org_id AND a.started_at >= :since
    )
    SELECT b.start,
           count(o.started_at) FILTER (WHERE o.error_kind IS NULL) AS succeeded,
           count(o.started_at) FILTER (WHERE o.error_kind IS NOT NULL) AS failed,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY o.duration_ms) AS p95_ms
    FROM buckets b
    LEFT JOIN org_attempts o
      ON o.started_at >= b.start AND o.started_at < b.start + interval '1 hour'
    GROUP BY b.start
    ORDER BY b.start
    """  # noqa: S608 - _BUCKETS is a constant
)

_PER_ENDPOINT = text(
    """
    SELECT d.endpoint_id,
           date_trunc('hour', a.started_at, 'UTC') AS start,
           count(*) FILTER (WHERE a.error_kind IS NULL) AS succeeded,
           count(*) FILTER (WHERE a.error_kind IS NOT NULL) AS failed
    FROM attempts a
    JOIN deliveries d ON d.id = a.delivery_id
    WHERE d.org_id = :org_id AND a.started_at >= :since
    GROUP BY d.endpoint_id, date_trunc('hour', a.started_at, 'UTC')
    """
)

_TOTALS = text(
    """
    SELECT count(*) AS attempts,
           count(*) FILTER (WHERE a.error_kind IS NULL) AS successes,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms) AS p95_ms
    FROM attempts a
    JOIN deliveries d ON d.id = a.delivery_id
    WHERE d.org_id = :org_id AND a.started_at >= :since
    """
)

_STATUSES = text(
    "SELECT status, count(*) AS n FROM deliveries WHERE org_id = :org_id GROUP BY status"
)

_EVENTS = text("SELECT count(*) FROM events WHERE org_id = :org_id AND created_at >= :since")


def _ms(value: float | None) -> int | None:
    return round(value) if value is not None else None


async def overview(session: AsyncSession, org_id: uuid.UUID, *, now: datetime) -> Overview:
    first_hour = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=HOURS - 1)
    params = {"org_id": org_id, "now": now, "since": first_hour}

    buckets = [
        Bucket(row.start, row.succeeded, row.failed, _ms(row.p95_ms))
        for row in await session.execute(_SERIES, params)
    ]
    index = {bucket.start: position for position, bucket in enumerate(buckets)}

    per_endpoint: dict[uuid.UUID, EndpointSeries] = {}
    for row in await session.execute(_PER_ENDPOINT, params):
        position = index.get(row.start)
        if position is None:
            continue
        series = per_endpoint.setdefault(
            row.endpoint_id, EndpointSeries(row.endpoint_id, [0] * HOURS, [0] * HOURS)
        )
        series.succeeded[position] = row.succeeded
        series.failed[position] = row.failed

    totals = (await session.execute(_TOTALS, params)).one()
    statuses = {status.value: 0 for status in DeliveryStatus}
    for row in await session.execute(_STATUSES, params):
        statuses[row.status] = row.n

    return Overview(
        since=first_hour,
        buckets=buckets,
        endpoints=list(per_endpoint.values()),
        deliveries_by_status=statuses,
        events=int(await session.scalar(_EVENTS, params) or 0),
        attempts=totals.attempts,
        successes=totals.successes,
        p95_ms=_ms(totals.p95_ms),
    )
