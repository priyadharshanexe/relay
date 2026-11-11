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
