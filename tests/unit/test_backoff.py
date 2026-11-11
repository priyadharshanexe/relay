import random
from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from relay.domain.backoff import (
    DEFAULT_SCHEDULE_SECONDS,
    BackoffPolicy,
    ScheduleBackoff,
    parse_retry_after,
)

NOW = datetime(2026, 11, 11, 12, 0, 0, tzinfo=UTC)


def no_jitter() -> ScheduleBackoff:
    return ScheduleBackoff(jitter=0)


def test_default_schedule_without_jitter() -> None:
    policy = no_jitter()

    delays = [policy.next_delay(attempts) for attempts in range(policy.max_attempts)]

    assert delays == [
        timedelta(0),
        timedelta(seconds=30),
        timedelta(minutes=2),
        timedelta(minutes=10),
        timedelta(hours=1),
        timedelta(hours=6),
        timedelta(hours=24),
    ]


def test_first_attempt_is_immediate_even_with_jitter() -> None:
    assert ScheduleBackoff().next_delay(0) == timedelta(0)


def test_no_delay_once_attempts_are_used_up_so_the_delivery_dead_letters() -> None:
    policy = no_jitter()

    assert policy.max_attempts == 7
    assert policy.next_delay(7) is None
    assert policy.next_delay(100) is None


def test_satisfies_the_backoff_policy_interface() -> None:
    policy: BackoffPolicy = ScheduleBackoff()

    assert policy.max_attempts == len(DEFAULT_SCHEDULE_SECONDS)


@given(attempts=st.integers(0, 6), seed=st.integers())
def test_jitter_stays_within_twenty_percent(attempts: int, seed: int) -> None:
    policy = ScheduleBackoff(rng=random.Random(seed))  # noqa: S311
    base = DEFAULT_SCHEDULE_SECONDS[attempts]

    delay = policy.next_delay(attempts)

    assert delay is not None
    assert base * 0.8 - 1e-6 <= delay.total_seconds() <= base * 1.2 + 1e-6


@given(attempts=st.integers(0, 50), seed=st.integers())
def test_delay_is_never_negative_and_never_beyond_the_longest_step(
    attempts: int, seed: int
) -> None:
    delay = ScheduleBackoff(rng=random.Random(seed)).next_delay(attempts)  # noqa: S311

    if delay is not None:
        assert timedelta(0) <= delay <= timedelta(hours=24) * 1.2


def test_jitter_actually_spreads_retries_out() -> None:
    policy = ScheduleBackoff(rng=random.Random(7))  # noqa: S311

    delays = {policy.next_delay(4) for _ in range(50)}

    assert len(delays) > 40


# ------------------------------------------------------------------ Retry-After
def test_retry_after_longer_than_the_schedule_is_honoured() -> None:
    assert no_jitter().next_delay(1, retry_after=timedelta(minutes=5)) == timedelta(minutes=5)


def test_retry_after_shorter_than_the_schedule_does_not_speed_us_up() -> None:
    assert no_jitter().next_delay(3, retry_after=timedelta(seconds=1)) == timedelta(minutes=10)


def test_retry_after_is_capped_so_a_receiver_cannot_park_a_delivery() -> None:
    policy = ScheduleBackoff(jitter=0, max_retry_after=timedelta(hours=1))

    assert policy.next_delay(1, retry_after=timedelta(days=365)) == timedelta(hours=1)


def test_negative_retry_after_is_ignored() -> None:
    assert no_jitter().next_delay(1, retry_after=timedelta(seconds=-10)) == timedelta(seconds=30)


def test_retry_after_does_not_grant_extra_attempts() -> None:
    assert no_jitter().next_delay(7, retry_after=timedelta(seconds=5)) is None


@given(
    attempts=st.integers(0, 6),
    retry_seconds=st.floats(0, 10_000_000, allow_nan=False),
    seed=st.integers(),
)
def test_with_retry_after_the_delay_is_at_least_the_capped_request(
    attempts: int, retry_seconds: float, seed: int
) -> None:
    cap = timedelta(hours=1)
    policy = ScheduleBackoff(max_retry_after=cap, rng=random.Random(seed))  # noqa: S311
    requested = timedelta(seconds=retry_seconds)

    delay = policy.next_delay(attempts, retry_after=requested)

    assert delay is not None
    assert delay >= min(requested, cap)


# ------------------------------------------------------------------- validation
@pytest.mark.parametrize(
    "kwargs",
    [
        {"schedule_seconds": []},
        {"schedule_seconds": [0, -1]},
        {"jitter": -0.1},
        {"jitter": 1.0},
        {"max_retry_after": timedelta(seconds=-1)},
    ],
)
def test_invalid_configuration_is_rejected(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):  # noqa: PT011
        ScheduleBackoff(**kwargs)  # type: ignore[arg-type]


def test_negative_attempt_count_is_rejected() -> None:
    with pytest.raises(ValueError, match="negative"):
        no_jitter().next_delay(-1)


# ---------------------------------------------------------- parsing the header
@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("120", timedelta(seconds=120)),
        ("0", timedelta(0)),
        ("  30  ", timedelta(seconds=30)),
        ("Wed, 11 Nov 2026 12:01:00 GMT", timedelta(minutes=1)),
        ("Wed, 11 Nov 2026 11:00:00 GMT", timedelta(0)),  # a date in the past
    ],
)
def test_parses_seconds_and_http_dates(header: str, expected: timedelta) -> None:
    assert parse_retry_after(header, now=NOW) == expected


@pytest.mark.parametrize("header", [None, "", "soon", "-5", "1.5", "12abc", "9" * 400])
def test_missing_or_malformed_header_falls_back_to_the_schedule(header: str | None) -> None:
    assert parse_retry_after(header, now=NOW) is None


@given(header=st.text(max_size=100))
def test_parsing_never_crashes_on_arbitrary_input(header: str) -> None:
    result = parse_retry_after(header, now=NOW)

    assert result is None or result >= timedelta(0)
