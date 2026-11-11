"""Per-endpoint circuit breaker.

Stops a dead receiver from burning retries and worker time:

    CLOSED  --(N failures in a row)-->  OPEN
    OPEN    --(cool-down has passed)-->  HALF_OPEN   one "probe" delivery is let through
    HALF_OPEN --(probe succeeds)-->  CLOSED
    HALF_OPEN --(probe fails)---->  OPEN            and the cool-down starts again

While the breaker is OPEN, deliveries *wait* (they are rescheduled without using up
an attempt) rather than fail.

This module is pure: it turns (current snapshot, event, time) into a new snapshot.
Loading and saving the snapshot is the caller's job, which makes every transition
testable without a database. Each state is its own small class (the State pattern),
so the rules for one state sit in one place.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from enum import StrEnum

from relay.domain.enums import BreakerState


@dataclass(frozen=True, slots=True)
class BreakerConfig:
    failure_threshold: int = 5
    cooldown: timedelta = timedelta(seconds=60)
    # If a probe never reports back (its worker died), allow another after this long.
    probe_timeout: timedelta = timedelta(seconds=60)

    def __post_init__(self) -> None:
        if self.failure_threshold < 1:
            raise ValueError("failure_threshold must be at least 1")
        if self.cooldown <= timedelta(0) or self.probe_timeout <= timedelta(0):
            raise ValueError("cooldown and probe_timeout must be positive")


@dataclass(frozen=True, slots=True)
class BreakerSnapshot:
    """Everything the breaker remembers about one endpoint."""

    state: BreakerState = BreakerState.CLOSED
    consecutive_failures: int = 0
    # When the breaker opened (OPEN) or the probe started (HALF_OPEN).
    changed_at: datetime | None = None


class PermissionKind(StrEnum):
    ALLOW = "allow"  # send normally
    PROBE = "probe"  # send, but call begin_probe() first: this is the test delivery
    WAIT = "wait"  # don't send; try again at retry_at


@dataclass(frozen=True, slots=True)
class Permission:
    kind: PermissionKind
    retry_at: datetime | None = None


class _State(ABC):
    @abstractmethod
    def permission(
        self, snapshot: BreakerSnapshot, now: datetime, config: BreakerConfig
    ) -> Permission: ...

    @abstractmethod
    def on_failure(
        self, snapshot: BreakerSnapshot, now: datetime, config: BreakerConfig
    ) -> BreakerSnapshot: ...

    def on_success(self, snapshot: BreakerSnapshot) -> BreakerSnapshot:
        # A success in any state proves the receiver is healthy.
        return BreakerSnapshot()


def _opened(snapshot: BreakerSnapshot, now: datetime) -> BreakerSnapshot:
    return BreakerSnapshot(BreakerState.OPEN, snapshot.consecutive_failures + 1, now)


class _Closed(_State):
    def permission(
        self, snapshot: BreakerSnapshot, now: datetime, config: BreakerConfig
    ) -> Permission:
        return Permission(PermissionKind.ALLOW)

    def on_failure(
        self, snapshot: BreakerSnapshot, now: datetime, config: BreakerConfig
    ) -> BreakerSnapshot:
        if snapshot.consecutive_failures + 1 >= config.failure_threshold:
            return _opened(snapshot, now)
        return replace(snapshot, consecutive_failures=snapshot.consecutive_failures + 1)


class _Open(_State):
    def permission(
        self, snapshot: BreakerSnapshot, now: datetime, config: BreakerConfig
    ) -> Permission:
        if snapshot.changed_at is None:
            return Permission(PermissionKind.PROBE)
        retry_at = snapshot.changed_at + config.cooldown
        if now >= retry_at:
            return Permission(PermissionKind.PROBE)
        return Permission(PermissionKind.WAIT, retry_at)

    def on_failure(
        self, snapshot: BreakerSnapshot, now: datetime, config: BreakerConfig
    ) -> BreakerSnapshot:
        # A delivery that was already in flight when the breaker opened. Count it,
        # but don't restart the cool-down, or stragglers could hold it open forever.
        return replace(snapshot, consecutive_failures=snapshot.consecutive_failures + 1)


class _HalfOpen(_State):
    def permission(
        self, snapshot: BreakerSnapshot, now: datetime, config: BreakerConfig
    ) -> Permission:
        if snapshot.changed_at is None:
            return Permission(PermissionKind.PROBE)
        probe_deadline = snapshot.changed_at + config.probe_timeout
        if now >= probe_deadline:
            return Permission(PermissionKind.PROBE)  # the earlier probe was lost
        return Permission(PermissionKind.WAIT, probe_deadline)

    def on_failure(
        self, snapshot: BreakerSnapshot, now: datetime, config: BreakerConfig
    ) -> BreakerSnapshot:
        return _opened(snapshot, now)


_STATES: dict[BreakerState, _State] = {
    BreakerState.CLOSED: _Closed(),
    BreakerState.OPEN: _Open(),
    BreakerState.HALF_OPEN: _HalfOpen(),
}


@dataclass(frozen=True, slots=True)
class CircuitBreaker:
    config: BreakerConfig = field(default_factory=BreakerConfig)

    def permission(self, snapshot: BreakerSnapshot, now: datetime) -> Permission:
        """May a delivery be sent to this endpoint right now?"""
        return _STATES[snapshot.state].permission(snapshot, now, self.config)

    def begin_probe(self, snapshot: BreakerSnapshot, now: datetime) -> BreakerSnapshot:
        """Record that the single test delivery is on its way."""
        if self.permission(snapshot, now).kind is not PermissionKind.PROBE:
            raise ValueError(f"cannot start a probe while the breaker is {snapshot.state}")
        return BreakerSnapshot(BreakerState.HALF_OPEN, snapshot.consecutive_failures, now)

    def on_success(self, snapshot: BreakerSnapshot) -> BreakerSnapshot:
        return _STATES[snapshot.state].on_success(snapshot)

    def on_failure(self, snapshot: BreakerSnapshot, now: datetime) -> BreakerSnapshot:
        return _STATES[snapshot.state].on_failure(snapshot, now, self.config)
