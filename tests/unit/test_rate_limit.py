import pytest
from hypothesis import given
from hypothesis import strategies as st

from relay.domain.rate_limit import BucketState, take


def test_a_new_bucket_starts_full_and_allows_a_burst() -> None:
    state = None
    for _ in range(5):
        decision = take(state, rate=1, capacity=5, now=0)
        assert decision.allowed
        state = decision.state

    assert state is not None
    assert state.tokens == 0


def test_an_empty_bucket_refuses_and_says_how_long_to_wait() -> None:
    decision = take(BucketState(tokens=0, updated_at=0), rate=2, capacity=5, now=0)

    assert not decision.allowed
    assert decision.retry_after == pytest.approx(0.5)  # one token at 2 per second
    assert decision.state.tokens == 0


def test_tokens_refill_over_time() -> None:
    decision = take(BucketState(tokens=0, updated_at=0), rate=2, capacity=5, now=1.0)

    assert decision.allowed
    assert decision.state.tokens == pytest.approx(1.0)  # refilled 2, spent 1


def test_refill_never_exceeds_capacity() -> None:
    decision = take(BucketState(tokens=0, updated_at=0), rate=10, capacity=5, now=3600)

    assert decision.state.tokens == pytest.approx(4.0)  # full at 5, spent 1


def test_waiting_exactly_retry_after_is_enough() -> None:
    refused = take(BucketState(tokens=0.25, updated_at=10), rate=4, capacity=8, now=10)
    assert not refused.allowed

    allowed = take(refused.state, rate=4, capacity=8, now=10 + refused.retry_after)

    assert allowed.allowed


def test_a_clock_that_goes_backwards_adds_no_tokens() -> None:
    decision = take(BucketState(tokens=0, updated_at=100), rate=1, capacity=5, now=50)

    assert not decision.allowed
    assert decision.state.tokens == 0


@pytest.mark.parametrize(
    "kwargs",
    [
        {"rate": 0, "capacity": 5},
        {"rate": -1, "capacity": 5},
        {"rate": 1, "capacity": 0},
        {"rate": 1, "capacity": 5, "cost": 0},
        {"rate": 1, "capacity": 5, "cost": 6},  # could never be satisfied
    ],
)
def test_invalid_arguments_are_rejected(kwargs: dict[str, float]) -> None:
    with pytest.raises(ValueError):  # noqa: PT011
        take(None, now=0, **kwargs)


rates = st.floats(0.1, 1000, allow_nan=False)
capacities = st.floats(1, 1000, allow_nan=False)
gaps = st.lists(st.floats(0, 10, allow_nan=False), min_size=1, max_size=200)


@given(rate=rates, capacity=capacities, gaps=gaps)
def test_tokens_always_stay_between_zero_and_capacity(
    rate: float, capacity: float, gaps: list[float]
) -> None:
    state, now = None, 0.0
    for gap in gaps:
        now += gap
        decision = take(state, rate=rate, capacity=capacity, now=now)
        state = decision.state
        assert 0 <= state.tokens <= capacity
        assert decision.retry_after >= 0
        assert (decision.retry_after == 0) == decision.allowed


@given(rate=rates, capacity=capacities, gaps=gaps)
def test_never_allows_more_than_the_burst_plus_the_refill(
    rate: float, capacity: float, gaps: list[float]
) -> None:
    """The guarantee a receiver relies on: over any period we send at most
    capacity + rate * elapsed deliveries."""
    state, now, allowed = None, 0.0, 0
    for gap in gaps:
        now += gap
        decision = take(state, rate=rate, capacity=capacity, now=now)
        state = decision.state
        allowed += decision.allowed

    assert allowed <= capacity + rate * now + 1e-6
