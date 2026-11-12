import pytest
from pydantic import ValidationError

from relay.core.config import Settings


def test_reads_prefixed_environment_variables(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RELAY_LOG_LEVEL", "DEBUG")
    monkeypatch.setenv("RELAY_DATABASE_POOL_SIZE", "25")

    settings = Settings(_env_file=None)

    assert settings.log_level == "DEBUG"
    assert settings.database_pool_size == 25


def test_rejects_out_of_range_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RELAY_DATABASE_POOL_SIZE", "0")

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_rejects_unknown_environment_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RELAY_ENVIRONMENT", "prod")  # must be "production"

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_retry_schedule_defaults_to_the_documented_one_and_can_be_overridden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert Settings(_env_file=None).retry_schedule_seconds == [0, 30, 120, 600, 3600, 21600, 86400]

    monkeypatch.setenv("RELAY_RETRY_SCHEDULE_SECONDS", "[0, 2, 2]")
    assert Settings(_env_file=None).retry_schedule_seconds == [0, 2, 2]


@pytest.mark.parametrize("value", ["[]", "[0, -1]", "not json"])
def test_invalid_retry_schedules_are_rejected(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("RELAY_RETRY_SCHEDULE_SECONDS", value)

    with pytest.raises(ValueError):  # noqa: PT011 - pydantic and settings errors both derive from it
        Settings(_env_file=None)


def test_the_lease_must_outlast_the_delivery_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Otherwise a slow but healthy delivery could be handed to a second worker."""
    monkeypatch.setenv("RELAY_WORKER_LOCK_SECONDS", "20")
    monkeypatch.setenv("RELAY_DELIVERY_TOTAL_TIMEOUT_SECONDS", "15")

    with pytest.raises(ValidationError, match="RELAY_WORKER_LOCK_SECONDS"):
        Settings(_env_file=None)
