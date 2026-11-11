"""Application settings, read from environment variables prefixed with ``RELAY_``."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "production"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]

# Only for local development and tests. Production refuses to start with it.
DEV_JWT_SECRET = "dev-only-jwt-secret-change-me-in-production"  # noqa: S105


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

    # Dashboard sessions
    jwt_secret: SecretStr = SecretStr(DEV_JWT_SECRET)
    access_token_ttl_seconds: int = Field(default=900, ge=60, le=3600)
    refresh_token_ttl_days: int = Field(default=30, ge=1, le=90)
    # None means "secure cookies in production, plain in development and tests".
    cookie_secure: bool | None = None
    # Browser origins allowed to call the API with cookies (JSON list in the env var).
    allowed_origins: list[str] = ["http://localhost:5173", "http://localhost:8000"]

    # Abuse limits, per client IP
    login_attempts_per_minute: int = Field(default=10, ge=1)
    registrations_per_hour: int = Field(default=10, ge=1)

    # Worker
    worker_poll_interval_seconds: float = Field(default=1.0, gt=0, le=60)

    @property
    def cookies_are_secure(self) -> bool:
        if self.cookie_secure is not None:
            return self.cookie_secure
        return self.environment == "production"

    @model_validator(mode="after")
    def _production_needs_real_secrets(self) -> "Settings":
        if self.environment == "production":
            secret = self.jwt_secret.get_secret_value()
            if secret == DEV_JWT_SECRET or len(secret) < 32:
                raise ValueError(
                    "RELAY_JWT_SECRET must be set to a random value of at least "
                    "32 characters in production"
                )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
