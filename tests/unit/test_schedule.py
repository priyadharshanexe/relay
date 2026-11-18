from datetime import UTC, datetime, timedelta, timezone

import pytest

from relay.domain.schedule import daily_run_due, latest_daily_slot


def at(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 3, day, hour, minute, tzinfo=UTC)


@pytest.mark.parametrize(
    ("now", "slot"),
    [
        (at(10, 3, 0), at(10, 3)),  # exactly on the slot
        (at(10, 3, 1), at(10, 3)),  # just after
        (at(10, 2, 59), at(9, 3)),  # just before: yesterday's slot
        (at(10, 23, 59), at(10, 3)),
        (at(1, 0, 0), datetime(2026, 2, 28, 3, tzinfo=UTC)),  # across a month
    ],
)
def test_latest_daily_slot(now: datetime, slot: datetime) -> None:
    assert latest_daily_slot(now, 3) == slot


def test_the_slot_is_in_utc_whatever_the_clocks_zone() -> None:
    india = timezone(timedelta(hours=5, minutes=30))
    # 09:00 in India is 03:30 UTC: today's 03:00 UTC slot has passed.
    now = datetime(2026, 3, 10, 9, 0, tzinfo=india)
    assert latest_daily_slot(now, 3) == at(10, 3)


def test_a_job_that_never_ran_is_due() -> None:
    assert daily_run_due(now=at(10, 12), last_run=None, hour_utc=3)


def test_a_job_runs_once_per_slot() -> None:
    ran = at(10, 3, 5)
    assert not daily_run_due(now=at(10, 4), last_run=ran, hour_utc=3)
    assert not daily_run_due(now=at(11, 2, 59), last_run=ran, hour_utc=3)
    assert daily_run_due(now=at(11, 3), last_run=ran, hour_utc=3)


def test_a_missed_slot_is_caught_up_once() -> None:
    # Every worker was down at 03:00; one comes back at 15:00.
    last = at(9, 3, 1)
    assert daily_run_due(now=at(10, 15), last_run=last, hour_utc=3)
    assert not daily_run_due(now=at(10, 15, 5), last_run=at(10, 15), hour_utc=3)


def test_naive_times_and_bad_hours_are_refused() -> None:
    with pytest.raises(ValueError, match="timezone"):
        latest_daily_slot(datetime(2026, 3, 10, 3), 3)
    with pytest.raises(ValueError, match="hour"):
        latest_daily_slot(at(10, 3), 24)
