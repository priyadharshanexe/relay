"""Deliver one claimed delivery: decide, send, record.

The work is split into three steps so that no database connection is ever held
while waiting on a customer's server:

1. **Prepare** (short transaction): load the delivery, ask the circuit breaker and
   the rate limiter whether we may send, fetch the signing secrets. If we may not
   send, the delivery is *postponed*: put back in the queue for later **without
   using up an attempt**. A broken or throttled endpoint must not burn retries.
2. **Send** (no transaction): SSRF check, sign, HTTP POST.
3. **Record** (short transaction): store the attempt, then move the delivery to
   succeeded, retrying (with backoff) or dead, and update the circuit breaker.
"""

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from redis.exceptions import RedisError
from sqlalchemy import CursorResult, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from relay import __version__
from relay.core.crypto import DecryptionError, SecretBox
from relay.core.logging import get_logger
from relay.db.models import Attempt, Delivery, Endpoint, Event
from relay.domain.backoff import BackoffPolicy, parse_retry_after
from relay.domain.circuit_breaker import BreakerSnapshot, CircuitBreaker, PermissionKind
from relay.domain.enums import BreakerState, DeliveryStatus, ErrorKind
from relay.domain.rate_limit import RateLimiter
from relay.domain.signing import Signer
from relay.domain.ssrf import (
    AddressPolicy,
    Resolver,
    SsrfError,
    UnresolvableHostError,
    resolve_and_check,
)
from relay.services.endpoints import active_secrets
from relay.worker.sender import Sender, SendResult, clean_text, mask_headers

log = get_logger("relay.worker.deliver")

USER_AGENT = f"Relay/{__version__} (+webhook delivery)"

# If another worker already started the probe, look again shortly.
_PROBE_RACE_DELAY = timedelta(seconds=5)

_POSTPONE = text(
    """
    UPDATE deliveries
    SET status = CASE WHEN attempts > 0 THEN 'retrying' ELSE 'pending' END,
        next_attempt_at = :next_attempt_at,
        locked_until = NULL,
        locked_by = NULL,
        updated_at = now()
    WHERE id = :id AND status = 'in_flight' AND locked_by = :worker_id
    """
)


def utc_now() -> datetime:
    return datetime.now(UTC)


def build_body(event_id: uuid.UUID, event_type: str, created_at: datetime, payload: Any) -> bytes:
    """The exact bytes that are signed and sent. Built once, so what we sign is
    what we send."""
    envelope = {
        "id": str(event_id),
        "type": event_type,
        "timestamp": created_at.astimezone(UTC).isoformat(),
        "data": payload,
    }
    return json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode()


@dataclass(frozen=True, slots=True)
class _Job:
    """Everything needed to send, copied out of the database before the
    connection is released."""

    delivery_id: uuid.UUID
    endpoint_id: uuid.UUID
    attempt_number: int
    url: str
    body: bytes
    message_id: str
    secrets: list[str]


class DeliveryProcessor:
    def __init__(
        self,
        *,
        sessions: async_sessionmaker[AsyncSession],
        sender: Sender,
        resolver: Resolver,
        address_policy: AddressPolicy,
        require_https: bool,
        secret_box: SecretBox,
        backoff: BackoffPolicy,
        breaker: CircuitBreaker,
        rate_limiter: RateLimiter,
        worker_id: str,
        clock: Callable[[], datetime] = utc_now,
    ) -> None:
        self._sessions = sessions
        self._sender = sender
        self._resolver = resolver
        self._address_policy = address_policy
        self._require_https = require_https
        self._box = secret_box
        self._backoff = backoff
        self._breaker = breaker
        self._rate_limiter = rate_limiter
        self._worker_id = worker_id
        self._clock = clock

    async def process(self, delivery_id: uuid.UUID) -> None:
        job = await self._prepare(delivery_id)
        if job is None:
            return
        started_at = self._clock()
        request_headers, result = await self._send(job, started_at)
        await self._record(job, started_at, request_headers, result)

    # ------------------------------------------------------------------ prepare
    async def _prepare(self, delivery_id: uuid.UUID) -> _Job | None:
        async with self._sessions() as session:
            row = (
                await session.execute(
                    select(Delivery, Event, Endpoint)
                    .join(Event, Event.id == Delivery.event_id)
                    .join(Endpoint, Endpoint.id == Delivery.endpoint_id)
                    .where(Delivery.id == delivery_id)
                )
            ).first()
            if row is None:
                return None  # deleted after it was claimed
            delivery, event, endpoint = row
            if delivery.status != DeliveryStatus.IN_FLIGHT or delivery.locked_by != self._worker_id:
                # Our lease expired and the delivery was handed to someone else
                # (or already finished). Sending now would be a needless duplicate.
                log.warning("deliver.lease_lost", delivery_id=str(delivery_id))
                return None
            now = self._clock()

            snapshot = BreakerSnapshot(
                BreakerState(endpoint.breaker_state),
                endpoint.consecutive_failures,
                endpoint.breaker_opened_at,
            )
            permission = self._breaker.permission(snapshot, now)
            if permission.kind is PermissionKind.WAIT:
                await self._postpone(session, delivery_id, permission.retry_at or now)
                return None

            if endpoint.rate_limit_per_sec is not None:
                wait = await self._rate_limit_wait(endpoint.id, endpoint.rate_limit_per_sec)
                if wait > 0:
                    await self._postpone(session, delivery_id, now + timedelta(seconds=wait))
                    return None

            if permission.kind is PermissionKind.PROBE:
                # Only one delivery may be the probe. The WHERE clause makes this
                # a compare-and-swap: if another worker changed the breaker since
                # we read it, zero rows match and we step aside.
                probe = self._breaker.begin_probe(snapshot, now)
                started = cast(
                    CursorResult[Any],
                    await session.execute(
                        update(Endpoint)
                        .where(
                            Endpoint.id == endpoint.id,
                            Endpoint.breaker_state == snapshot.state,
                            Endpoint.breaker_opened_at.is_not_distinct_from(snapshot.changed_at),
                        )
                        .values(breaker_state=probe.state, breaker_opened_at=probe.changed_at)
                    ),
                )
                if started.rowcount == 0:
                    await session.rollback()
                    await self._postpone(session, delivery_id, now + _PROBE_RACE_DELAY)
                    return None
                await session.commit()

            try:
                secrets = await active_secrets(session, endpoint.id, self._box, now=now)
            except DecryptionError:
                log.error("deliver.secret_undecryptable", endpoint_id=str(endpoint.id))
                secrets = []

            return _Job(
                delivery_id=delivery.id,
                endpoint_id=endpoint.id,
                attempt_number=delivery.attempts + 1,
                url=endpoint.url,
                body=build_body(event.id, event.type, event.created_at, event.payload),
                message_id=str(event.id),
                secrets=secrets,
            )

    async def _rate_limit_wait(self, endpoint_id: uuid.UUID, rate: int) -> float:
        """Seconds to wait before this endpoint may be sent to (0 = go now)."""
        try:
            decision = await self._rate_limiter.acquire(
                f"endpoint:{endpoint_id}", rate=float(rate), capacity=float(rate)
            )
        except RedisError as exc:
            # Fail open: without Redis we deliver unthrottled rather than not at all.
            log.warning("deliver.rate_limiter_unavailable", error=type(exc).__name__)
            return 0.0
        return 0.0 if decision.allowed else max(decision.retry_after, 0.05)

    async def _postpone(
        self, session: AsyncSession, delivery_id: uuid.UUID, next_attempt_at: datetime
    ) -> None:
        """Back to the queue for later. ``attempts`` is deliberately untouched."""
        await session.execute(
            _POSTPONE,
            {"id": delivery_id, "worker_id": self._worker_id, "next_attempt_at": next_attempt_at},
        )
        await session.commit()

    # --------------------------------------------------------------------- send
    async def _send(self, job: _Job, started_at: datetime) -> tuple[dict[str, str], SendResult]:
        headers = {"content-type": "application/json", "user-agent": USER_AGENT}
        if not job.secrets:
            return headers, SendResult(
                0,
                error_kind=ErrorKind.OTHER,
                error_message="the endpoint has no usable signing secret",
            )
        headers |= Signer(job.secrets).sign(job.message_id, started_at, job.body).as_dict()

        try:
            target = await resolve_and_check(
                job.url, self._address_policy, self._resolver, require_https=self._require_https
            )
        except UnresolvableHostError as exc:
            return headers, SendResult(0, error_kind=ErrorKind.DNS, error_message=str(exc))
        except SsrfError as exc:
            # Refused before any connection was made.
            return headers, SendResult(0, error_kind=ErrorKind.SSRF_BLOCKED, error_message=str(exc))

        return headers, await self._sender.send(job.url, target, headers, job.body)

    # ------------------------------------------------------------------- record
    async def _record(
        self, job: _Job, started_at: datetime, request_headers: dict[str, str], result: SendResult
    ) -> None:
        async with self._sessions() as session:
            # Lock order is always endpoint, then delivery. Locking the endpoint
            # serialises breaker updates from deliveries that finish together.
            endpoint = await session.scalar(
                select(Endpoint).where(Endpoint.id == job.endpoint_id).with_for_update()
            )
            delivery = await session.scalar(
                select(Delivery).where(Delivery.id == job.delivery_id).with_for_update()
            )
            if endpoint is None or delivery is None:
                return  # deleted while we were sending

            now = self._clock()
            session.add(
                Attempt(
                    delivery_id=delivery.id,
                    attempt_number=job.attempt_number,
                    started_at=started_at,
                    duration_ms=result.duration_ms,
                    status_code=result.status_code,
                    error_kind=result.error_kind,
                    response_snippet=result.response_snippet,
                    request_headers=mask_headers(request_headers),
                    response_headers=result.response_headers,
                )
            )

            # If our lease expired and the sweeper handed the delivery to another
            # worker, the attempt is still logged, but its state is theirs now.
            still_ours = (
                delivery.status == DeliveryStatus.IN_FLIGHT
                and delivery.locked_by == self._worker_id
            )
            if still_ours:
                self._apply_outcome(delivery, result, now)

            snapshot = BreakerSnapshot(
                BreakerState(endpoint.breaker_state),
                endpoint.consecutive_failures,
                endpoint.breaker_opened_at,
            )
            updated = (
                self._breaker.on_success(snapshot)
                if result.succeeded
                else self._breaker.on_failure(snapshot, now)
            )
            endpoint.breaker_state = updated.state
            endpoint.consecutive_failures = updated.consecutive_failures
            endpoint.breaker_opened_at = updated.changed_at
            if updated.state is BreakerState.OPEN and snapshot.state is not BreakerState.OPEN:
                log.warning(
                    "breaker.opened",
                    endpoint_id=str(endpoint.id),
                    org_id=str(endpoint.org_id),
                    consecutive_failures=updated.consecutive_failures,
                )

            await session.commit()

        log.info(
            "deliver.attempt",
            delivery_id=str(job.delivery_id),
            endpoint_id=str(job.endpoint_id),
            attempt=job.attempt_number,
            status_code=result.status_code,
            error_kind=result.error_kind,
            duration_ms=result.duration_ms,
            outcome=delivery.status,
        )

    def _apply_outcome(self, delivery: Delivery, result: SendResult, now: datetime) -> None:
        delivery.attempts = job_attempts = delivery.attempts + 1
        delivery.locked_until = None
        delivery.locked_by = None

        if result.succeeded:
            delivery.status = DeliveryStatus.SUCCEEDED
            delivery.last_error = None
            return

        delivery.last_error = clean_text(
            f"{result.error_kind}: {result.error_message or 'delivery failed'}", 1000
        )
        delay = self._backoff.next_delay(
            job_attempts, parse_retry_after(result.retry_after, now=now)
        )
        if delay is None:
            delivery.status = DeliveryStatus.DEAD  # out of attempts: dead-letter queue
        else:
            delivery.status = DeliveryStatus.RETRYING
            delivery.next_attempt_at = now + delay
