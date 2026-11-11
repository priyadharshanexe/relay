"""When to try a failed delivery again.

The default schedule spreads 7 attempts over about 31 hours:

    attempt 1  immediately
    attempt 2  30 seconds after the first failure
    attempt 3  2 minutes later
    attempt 4  10 minutes later
    attempt 5  1 hour later
    attempt 6  6 hours later
    attempt 7  24 hours later, then the delivery is dead-lettered

Each delay is moved randomly by up to +/-20% ("jitter"). Without it, every delivery
that failed during one outage would retry at the same instant and knock the
recovering receiver over again.
"""

import random
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Protocol

DEFAULT_SCHEDULE_SECONDS: tuple[float, ...] = (0, 30, 120, 600, 3600, 21600, 86400)


class BackoffPolicy(Protocol):
    @property
    def max_attempts(self) -> int: ...

    def next_delay(
        self, attempts_made: int, retry_after: timedelta | None = None
    ) -> timedelta | None:
        """How long to wait before the next attempt, or ``None`` if there are no
        attempts left and the delivery should be dead-lettered."""
        ...


class ScheduleBackoff:
    """A fixed schedule of delays with random jitter. See the module docstring."""

    def __init__(
        self,
        schedule_seconds: Sequence[float] = DEFAULT_SCHEDULE_SECONDS,
        *,
        jitter: float = 0.2,
        max_retry_after: timedelta = timedelta(hours=1),
        rng: random.Random | None = None,
    ) -> None:
        if not schedule_seconds:
            raise ValueError("the schedule needs at least one attempt")
        if any(delay < 0 for delay in schedule_seconds):
            raise ValueError("delays cannot be negative")
        if not 0 <= jitter < 1:
            raise ValueError("jitter must be at least 0 and below 1")
        if max_retry_after < timedelta(0):
            raise ValueError("max_retry_after cannot be negative")
        self._schedule = tuple(schedule_seconds)
        self._jitter = jitter
        self._max_retry_after = max_retry_after
        # Jitter only spreads load; it is not a security feature.
        self._rng = rng or random.Random()  # noqa: S311

    @property
    def max_attempts(self) -> int:
        return len(self._schedule)

    def next_delay(
        self, attempts_made: int, retry_after: timedelta | None = None
    ) -> timedelta | None:
        if attempts_made < 0:
            raise ValueError("attempts_made cannot be negative")
        if attempts_made >= len(self._schedule):
            return None

        base = self._schedule[attempts_made]
        delay = timedelta(seconds=base * (1 + self._rng.uniform(-self._jitter, self._jitter)))

        if retry_after is not None:
            # The receiver asked us to wait. Respect it, but never let a receiver
            # park a delivery for longer than the cap.
            requested = min(max(retry_after, timedelta(0)), self._max_retry_after)
            delay = max(delay, requested)
        return delay


def parse_retry_after(value: str | None, *, now: datetime) -> timedelta | None:
    """Parse a ``Retry-After`` header: either seconds (``120``) or an HTTP date.

    Returns ``None`` for a missing or malformed header, so a broken receiver falls
    back to the normal schedule instead of crashing the worker.
    """
    if value is None:
        return None
    value = value.strip()
    if value.isascii() and value.isdigit():
        try:
            return timedelta(seconds=int(value))
        except OverflowError:
            return None
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(when - now, timedelta(0))
