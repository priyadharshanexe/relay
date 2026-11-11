"""Per-endpoint rate limiting with a token bucket.

A bucket holds up to ``capacity`` tokens and refills at ``rate`` tokens per second.
Sending one delivery costs one token. When a receiver comes back after an outage
with a large backlog, this lets a short burst through and then holds us to a steady
rate, instead of flooding the receiver the moment it recovers.

``take`` is the whole algorithm as a pure function. The Redis implementation runs
the same arithmetic atomically inside Redis so that all workers share one bucket;
this version is its specification and is what the tests check it against.
"""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class BucketState:
    tokens: float
    updated_at: float  # seconds, from any clock that only moves forward


@dataclass(frozen=True, slots=True)
class RateDecision:
    allowed: bool
    state: BucketState
    # Seconds until enough tokens will be available; 0 when allowed.
    retry_after: float


def take(
    state: BucketState | None,
    *,
    rate: float,
    capacity: float,
    now: float,
    cost: float = 1.0,
) -> RateDecision:
    """Try to take ``cost`` tokens. ``state`` is ``None`` for a bucket never used."""
    if rate <= 0 or capacity <= 0 or cost <= 0:
        raise ValueError("rate, capacity and cost must be positive")
    if cost > capacity:
        raise ValueError("cost can never be satisfied: it exceeds the bucket capacity")

    if state is None:
        tokens = capacity  # a new bucket starts full
    else:
        # max(): if clocks disagree and time appears to go backwards, add nothing.
        elapsed = max(0.0, now - state.updated_at)
        tokens = min(capacity, state.tokens + elapsed * rate)

    if tokens >= cost:
        return RateDecision(True, BucketState(tokens - cost, now), 0.0)
    return RateDecision(False, BucketState(tokens, now), (cost - tokens) / rate)


class RateLimiter(Protocol):
    async def acquire(self, key: str, *, rate: float, capacity: float) -> RateDecision:
        """Take one token from the bucket named ``key``."""
        ...
