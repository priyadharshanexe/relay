"""Application settings, read from environment variables prefixed with ``RELAY_``."""

from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "production"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]

# Only for local development and tests. Production refuses to start with it.
DEV_JWT_SECRET = "dev-only-jwt-secret-change-me-in-production"  # noqa: S105
# base64 of 32 bytes ("relay-dev-encryption-key-32bytes"). Also refused in production.
DEV_ENCRYPTION_KEY = "cmVsYXktZGV2LWVuY3J5cHRpb24ta2V5LTMyYnl0ZXM="


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

    # Endpoints and events
    # Encrypts endpoint signing secrets at rest: base64 of 32 random bytes.
    encryption_key: SecretStr = SecretStr(DEV_ENCRYPTION_KEY)
    # None means "https only in production, http allowed in development and tests".
    endpoints_require_https: bool | None = None
    # Only for local development, where the receiver runs on a private address.
    endpoints_allow_private_networks: bool = False
    max_event_bytes: int = Field(default=256 * 1024, ge=1024)
    # How long the old signing secret keeps working after a rotation.
    secret_rotation_overlap_hours: int = Field(default=24, ge=0, le=168)

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

    @property
    def endpoints_must_use_https(self) -> bool:
        if self.endpoints_require_https is not None:
            return self.endpoints_require_https
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
            if self.encryption_key.get_secret_value() == DEV_ENCRYPTION_KEY:
                raise ValueError(
                    "RELAY_ENCRYPTION_KEY must be set to base64 of 32 random bytes in production"
                )
            if self.endpoints_allow_private_networks:
                raise ValueError("RELAY_ENDPOINTS_ALLOW_PRIVATE_NETWORKS must be off in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
