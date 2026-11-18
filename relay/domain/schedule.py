"""When a once-a-day job is due. Pure functions: no clock, no database.

A daily job has one *slot* per day, at a fixed hour (UTC). It is due when it has
not run since the most recent slot. Asking "has it run since the last slot?"
rather than "is it that hour now?" means a job missed because every worker was
down at that hour still runs as soon as one comes back, and runs only once.
"""

from datetime import UTC, datetime, timedelta


def latest_daily_slot(now: datetime, hour_utc: int) -> datetime:
    """The most recent moment, at or before ``now``, when the clock read ``hour_utc``:00."""
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    if not 0 <= hour_utc <= 23:
        raise ValueError("hour_utc must be between 0 and 23")
    now = now.astimezone(UTC)
    slot = now.replace(hour=hour_utc, minute=0, second=0, microsecond=0)
    return slot if slot <= now else slot - timedelta(days=1)


def daily_run_due(*, now: datetime, last_run: datetime | None, hour_utc: int) -> bool:
    """True when the job has not run since the latest slot. Never run means due."""
    return last_run is None or last_run < latest_daily_slot(now, hour_utc)
