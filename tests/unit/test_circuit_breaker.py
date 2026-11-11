from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from relay.domain.circuit_breaker import (
    BreakerConfig,
    BreakerSnapshot,
    CircuitBreaker,
    PermissionKind,
)
from relay.domain.enums import BreakerState

T0 = datetime(2026, 11, 11, 12, 0, 0, tzinfo=UTC)
CONFIG = BreakerConfig(
    failure_threshold=3, cooldown=timedelta(seconds=60), probe_timeout=timedelta(seconds=30)
)
breaker = CircuitBreaker(CONFIG)


def fail(snapshot: BreakerSnapshot, times: int, at: datetime = T0) -> BreakerSnapshot:
    for _ in range(times):
        snapshot = breaker.on_failure(snapshot, at)
    return snapshot


def opened_at_t0() -> BreakerSnapshot:
    return fail(BreakerSnapshot(), 3)


def probing_since(at: datetime) -> BreakerSnapshot:
    return breaker.begin_probe(opened_at_t0(), at)


# ----------------------------------------------------------------------- closed
def test_a_new_endpoint_is_closed_and_allows_deliveries() -> None:
    snapshot = BreakerSnapshot()

    assert snapshot.state is BreakerState.CLOSED
    assert breaker.permission(snapshot, T0).kind is PermissionKind.ALLOW


def test_failures_below_the_threshold_keep_it_closed() -> None:
    snapshot = fail(BreakerSnapshot(), 2)

    assert snapshot.state is BreakerState.CLOSED
    assert snapshot.consecutive_failures == 2
    assert breaker.permission(snapshot, T0).kind is PermissionKind.ALLOW


def test_a_success_resets_the_failure_count() -> None:
    snapshot = breaker.on_success(fail(BreakerSnapshot(), 2))

    assert snapshot == BreakerSnapshot()
    assert fail(snapshot, 2).state is BreakerState.CLOSED  # needs 3 in a row again


def test_reaching_the_threshold_opens_the_breaker() -> None:
    snapshot = opened_at_t0()

    assert snapshot.state is BreakerState.OPEN
    assert snapshot.changed_at == T0
    assert snapshot.consecutive_failures == 3


# ------------------------------------------------------------------------- open
def test_while_open_deliveries_wait_until_the_cooldown_ends() -> None:
    permission = breaker.permission(opened_at_t0(), T0 + timedelta(seconds=59))

    assert permission.kind is PermissionKind.WAIT
    assert permission.retry_at == T0 + timedelta(seconds=60)


def test_after_the_cooldown_one_probe_is_allowed() -> None:
    permission = breaker.permission(opened_at_t0(), T0 + timedelta(seconds=60))

    assert permission.kind is PermissionKind.PROBE


def test_a_straggler_failing_while_open_does_not_restart_the_cooldown() -> None:
    snapshot = breaker.on_failure(opened_at_t0(), T0 + timedelta(seconds=50))

    assert snapshot.state is BreakerState.OPEN
    assert snapshot.changed_at == T0
    assert snapshot.consecutive_failures == 4


def test_a_straggler_succeeding_while_open_closes_the_breaker() -> None:
    assert breaker.on_success(opened_at_t0()) == BreakerSnapshot()


def test_a_probe_cannot_start_before_the_cooldown_ends() -> None:
    with pytest.raises(ValueError, match="cannot start a probe"):
        breaker.begin_probe(opened_at_t0(), T0 + timedelta(seconds=10))


def test_a_probe_cannot_start_while_closed() -> None:
    with pytest.raises(ValueError, match="cannot start a probe"):
        breaker.begin_probe(BreakerSnapshot(), T0)


# -------------------------------------------------------------------- half-open
def test_starting_the_probe_moves_to_half_open() -> None:
    probe_start = T0 + timedelta(seconds=60)
    snapshot = probing_since(probe_start)

    assert snapshot.state is BreakerState.HALF_OPEN
    assert snapshot.changed_at == probe_start


def test_while_the_probe_is_out_other_deliveries_wait() -> None:
    probe_start = T0 + timedelta(seconds=60)

    permission = breaker.permission(probing_since(probe_start), probe_start + timedelta(seconds=5))

    assert permission.kind is PermissionKind.WAIT
    assert permission.retry_at == probe_start + timedelta(seconds=30)


def test_a_successful_probe_closes_the_breaker() -> None:
    snapshot = breaker.on_success(probing_since(T0 + timedelta(seconds=60)))

    assert snapshot == BreakerSnapshot()
    assert breaker.permission(snapshot, T0 + timedelta(seconds=61)).kind is PermissionKind.ALLOW


def test_a_failed_probe_reopens_and_restarts_the_cooldown() -> None:
    probe_start = T0 + timedelta(seconds=60)
    failed_at = probe_start + timedelta(seconds=3)

    snapshot = breaker.on_failure(probing_since(probe_start), failed_at)

    assert snapshot.state is BreakerState.OPEN
    assert snapshot.changed_at == failed_at
    waiting = breaker.permission(snapshot, failed_at + timedelta(seconds=59))
    assert waiting.kind is PermissionKind.WAIT


def test_a_lost_probe_does_not_leave_the_endpoint_stuck_forever() -> None:
    """The worker carrying the probe crashed and never reported back."""
    probe_start = T0 + timedelta(seconds=60)

    permission = breaker.permission(probing_since(probe_start), probe_start + timedelta(seconds=30))

    assert permission.kind is PermissionKind.PROBE


# ------------------------------------------------------------------- properties
events = st.lists(
    st.tuples(st.sampled_from(["success", "failure", "probe"]), st.integers(0, 120)), max_size=60
)


def replay(steps: list[tuple[str, int]]) -> list[tuple[str, BreakerSnapshot, BreakerSnapshot]]:
    """Drive the breaker the way the worker does and record every transition."""
    now = T0
    snapshot = BreakerSnapshot()
    history: list[tuple[str, BreakerSnapshot, BreakerSnapshot]] = []
    for event, seconds in steps:
        now += timedelta(seconds=seconds)
        before = snapshot
        if event == "probe":
            if breaker.permission(snapshot, now).kind is not PermissionKind.PROBE:
                continue
            snapshot = breaker.begin_probe(snapshot, now)
        elif event == "success":
            snapshot = breaker.on_success(snapshot)
        else:
            snapshot = breaker.on_failure(snapshot, now)
        history.append((event, before, snapshot))
    return history


@given(steps=events)
def test_snapshots_are_always_consistent(steps: list[tuple[str, int]]) -> None:
    for _, _, after in replay(steps):
        assert after.consecutive_failures >= 0
        if after.state is BreakerState.CLOSED:
            assert after.consecutive_failures < CONFIG.failure_threshold
            assert after.changed_at is None
        else:
            assert after.changed_at is not None
            assert after.consecutive_failures >= CONFIG.failure_threshold


@given(steps=events)
def test_only_legal_transitions_ever_happen(steps: list[tuple[str, int]]) -> None:
    legal = {
        ("failure", BreakerState.CLOSED, BreakerState.CLOSED),
        ("failure", BreakerState.CLOSED, BreakerState.OPEN),
        ("failure", BreakerState.OPEN, BreakerState.OPEN),
        ("failure", BreakerState.HALF_OPEN, BreakerState.OPEN),
        ("probe", BreakerState.OPEN, BreakerState.HALF_OPEN),
        ("probe", BreakerState.HALF_OPEN, BreakerState.HALF_OPEN),  # a lost probe retried
        ("success", BreakerState.CLOSED, BreakerState.CLOSED),
        ("success", BreakerState.OPEN, BreakerState.CLOSED),
        ("success", BreakerState.HALF_OPEN, BreakerState.CLOSED),
    }

    for event, before, after in replay(steps):
        assert (event, before.state, after.state) in legal


@given(steps=events)
def test_a_success_always_closes_the_breaker(steps: list[tuple[str, int]]) -> None:
    for event, _, after in replay(steps):
        if event == "success":
            assert after == BreakerSnapshot()


# ---------------------------------------------------------------- configuration
@pytest.mark.parametrize(
    "kwargs",
    [
        {"failure_threshold": 0},
        {"cooldown": timedelta(0)},
        {"probe_timeout": timedelta(seconds=-1)},
    ],
)
def test_invalid_configuration_is_rejected(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):  # noqa: PT011
        BreakerConfig(**kwargs)  # type: ignore[arg-type]
