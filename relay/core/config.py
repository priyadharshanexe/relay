"""Application settings, read from environment variables prefixed with ``RELAY_``."""

import base64
import hashlib
from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["development", "test", "production"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR"]

# Only for local development and tests. Production refuses to start with it.
DEV_JWT_SECRET = "dev-only-jwt-secret-change-me-in-production"  # noqa: S105
# Derived from a public phrase rather than written out, so nobody mistakes it for
# a real key (and secret scanners don't either). Also refused in production.
DEV_ENCRYPTION_KEY = base64.b64encode(
    hashlib.sha256(b"relay development-only encryption key").digest()
).decode()


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
    allowed_origins: list[str] = [
        "http://localhost:5173",  # Vite dev server
        "http://localhost:8080",  # dashboard container
        "http://localhost:8000",
    ]

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

    # Built-in test receiver
    # The API's address as the *workers* reach it. Endpoint URLs that start with
    # "<this>/receiver/" are our own receiver and are always deliverable.
    receiver_base_url: str = "http://localhost:8000"
    # Public demo safety: when on, deliveries go ONLY to the built-in receiver, so
    # nobody can use a public demo to send requests to arbitrary servers.
    delivery_only_to_receiver: bool = False
    # How long a "timeout" receiver holds the connection. None = just past the
    # delivery timeout.
    receiver_hold_seconds: float | None = Field(default=None, gt=0, le=120)

    # Abuse limits, per client IP
    login_attempts_per_minute: int = Field(default=10, ge=1)
    registrations_per_hour: int = Field(default=10, ge=1)

    # Worker
    worker_poll_interval_seconds: float = Field(default=1.0, gt=0, le=60)
    worker_batch_size: int = Field(default=50, ge=1, le=500)
    # How many deliveries one worker sends at the same time.
    worker_concurrency: int = Field(default=20, ge=1, le=200)
    # A claim is a lease. It must comfortably exceed the delivery timeout, so a
    # healthy worker always finishes before its lease runs out.
    worker_lock_seconds: int = Field(default=60, ge=5, le=600)

    # Outbound delivery
    delivery_connect_timeout_seconds: float = Field(default=5.0, gt=0, le=60)
    delivery_total_timeout_seconds: float = Field(default=15.0, gt=0, le=120)
    delivery_response_snippet_bytes: int = Field(default=2048, ge=0, le=65536)
    # Seconds to wait before each attempt (JSON list in the env var). The first
    # is the delay before attempt 1; when the list runs out the delivery is dead.
    # Shorten it for demos, e.g. [0, 2, 2].
    retry_schedule_seconds: list[float] = Field(
        default=[0, 30, 120, 600, 3600, 21600, 86400], min_length=1, max_length=20
    )
    breaker_failure_threshold: int = Field(default=5, ge=1)
    breaker_cooldown_seconds: int = Field(default=60, ge=1)

    @property
    def cookies_are_secure(self) -> bool:
        if self.cookie_secure is not None:
            return self.cookie_secure
        return self.environment == "production"

    @property
    def receiver_url_prefix(self) -> str:
        return self.receiver_base_url.rstrip("/") + "/receiver/"

    @property
    def receiver_hold(self) -> float:
        if self.receiver_hold_seconds is not None:
            return self.receiver_hold_seconds
        return self.delivery_total_timeout_seconds + 5

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
        if any(delay < 0 for delay in self.retry_schedule_seconds):
            raise ValueError("RELAY_RETRY_SCHEDULE_SECONDS cannot contain negative delays")
        if self.worker_lock_seconds <= self.delivery_total_timeout_seconds * 2:
            raise ValueError(
                "RELAY_WORKER_LOCK_SECONDS must be more than twice the delivery timeout, "
                "or a slow delivery could be claimed by a second worker"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
