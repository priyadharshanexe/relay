"""Application settings, read from environment variables prefixed with ``RELAY_``."""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "production"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="RELAY_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Environment = "development"

    # Host port 5433 (not 5432) so it never clashes with a locally installed Postgres.
    database_url: str = "postgresql+asyncpg://relay:relay@localhost:5433/relay"
    database_pool_size: int = Field(default=10, ge=1, le=100)

    redis_url: str = "redis://localhost:6379/0"

    log_level: LogLevel = "INFO"
    log_json: bool = True

    # Worker
    worker_poll_interval_seconds: float = Field(default=1.0, gt=0, le=60)


@lru_cache
def get_settings() -> Settings:
    return Settings()
