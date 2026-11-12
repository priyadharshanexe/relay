"""Entry point: ``python -m relay.worker``."""

import asyncio
from datetime import timedelta

from prometheus_client import start_http_server
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from relay.core.config import Settings, get_settings
from relay.core.crypto import SecretBox
from relay.core.live import LivePublisher
from relay.core.logging import configure_logging
from relay.core.redis import create_redis
from relay.core.redis_rate_limit import RedisRateLimiter
from relay.core.telemetry import configure_tracing, instrument_engine, instrument_http_client
from relay.db.session import create_engine, create_session_factory
from relay.domain.backoff import ScheduleBackoff
from relay.domain.circuit_breaker import BreakerConfig, CircuitBreaker
from relay.domain.rate_limit import RateLimiter
from relay.domain.ssrf import AddressPolicy
from relay.worker.deliver import DeliveryProcessor
from relay.worker.loop import DeliveryWorker, install_signal_handlers, new_worker_id
from relay.worker.sender import Sender, system_resolver


def build_processor(
    settings: Settings,
    *,
    sessions: async_sessionmaker[AsyncSession],
    sender: Sender,
    rate_limiter: RateLimiter,
    worker_id: str,
    publisher: LivePublisher | None = None,
) -> DeliveryProcessor:
    return DeliveryProcessor(
        sessions=sessions,
        sender=sender,
        resolver=system_resolver,
        address_policy=AddressPolicy(
            allow_private_networks=settings.endpoints_allow_private_networks
        ),
        require_https=settings.endpoints_must_use_https,
        secret_box=SecretBox(settings.encryption_key.get_secret_value()),
        backoff=ScheduleBackoff(settings.retry_schedule_seconds),
        breaker=CircuitBreaker(
            BreakerConfig(
                failure_threshold=settings.breaker_failure_threshold,
                cooldown=timedelta(seconds=settings.breaker_cooldown_seconds),
                probe_timeout=timedelta(seconds=settings.worker_lock_seconds),
            )
        ),
        rate_limiter=rate_limiter,
        worker_id=worker_id,
        trusted_url_prefix=settings.receiver_url_prefix,
        only_trusted=settings.delivery_only_to_receiver,
        publisher=publisher,
    )


async def _main(settings: Settings) -> None:
    tracer_provider = configure_tracing(settings, "relay-worker")
    engine = create_engine(settings, application_name="relay-worker")
    instrument_engine(engine)
    redis = create_redis(settings)
    sender = Sender(
        connect_timeout=settings.delivery_connect_timeout_seconds,
        total_timeout=settings.delivery_total_timeout_seconds,
        snippet_bytes=settings.delivery_response_snippet_bytes,
    )
    instrument_http_client(sender.client)
    sessions = create_session_factory(engine)
    worker_id = new_worker_id()
    processor = build_processor(
        settings,
        sessions=sessions,
        sender=sender,
        rate_limiter=RedisRateLimiter(redis),
        worker_id=worker_id,
        publisher=LivePublisher(redis),
    )
    worker = DeliveryWorker(
        sessions=sessions,
        process=processor.process,
        poll_interval=settings.worker_poll_interval_seconds,
        batch_size=settings.worker_batch_size,
        concurrency=settings.worker_concurrency,
        lock_seconds=settings.worker_lock_seconds,
        worker_id=worker_id,
    )
    if settings.worker_metrics_port:
        # A tiny HTTP server on its own thread, for Prometheus to scrape.
        start_http_server(settings.worker_metrics_port)
    install_signal_handlers(worker.request_stop)
    try:
        await worker.run()
    finally:
        await sender.aclose()
        await redis.aclose()
        await engine.dispose()
        if tracer_provider is not None:
            tracer_provider.shutdown()  # flush spans still in the buffer


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, json=settings.log_json)
    asyncio.run(_main(settings))


if __name__ == "__main__":
    main()
