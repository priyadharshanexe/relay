"""Endpoints: the customer URLs that events are delivered to."""

import ipaddress
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core.config import Settings
from relay.core.crypto import SecretBox
from relay.core.errors import AppError
from relay.db.models import Endpoint, EndpointSecret
from relay.domain import signing
from relay.domain.enums import BreakerState, EndpointStatus
from relay.domain.ssrf import AddressPolicy, SsrfError, parse_target
from relay.services import audit
from relay.services.receivers import is_builtin_receiver_url


@dataclass(frozen=True, slots=True)
class Actor:
    org_id: uuid.UUID
    user_id: uuid.UUID


def validate_url(url: str, settings: Settings) -> None:
    """Reject URLs we would never deliver to, at the moment they are saved.

    This catches bad schemes, embedded credentials and literal internal IPs early,
    with a clear message. It is a courtesy, not the security boundary: hostnames
    are resolved and checked again by the worker on every delivery, because DNS
    can change after the endpoint is saved.
    """
    if is_builtin_receiver_url(url, settings.receiver_url_prefix):
        return  # our own test receiver: always allowed
    if settings.delivery_only_to_receiver:
        raise AppError(
            422,
            "invalid_endpoint_url",
            "This is a demo: endpoints can only point at a built-in test receiver.",
        )
    try:
        target = parse_target(url, require_https=settings.endpoints_must_use_https)
        try:
            literal_ip = ipaddress.ip_address(target.host)
        except ValueError:
            return  # a hostname: resolved and checked at delivery time
        AddressPolicy(allow_private_networks=settings.endpoints_allow_private_networks).check(
            literal_ip
        )
    except SsrfError as exc:
        raise AppError(422, "invalid_endpoint_url", str(exc)) from exc


def _not_found() -> AppError:
    return AppError(404, "endpoint_not_found", "No such endpoint.")


async def get_endpoint(
    session: AsyncSession, org_id: uuid.UUID, endpoint_id: uuid.UUID
) -> Endpoint:
    # Filtering by org_id here is the tenancy boundary for every endpoint route.
    endpoint = await session.scalar(
        select(Endpoint).where(Endpoint.id == endpoint_id, Endpoint.org_id == org_id)
    )
    if endpoint is None:
        raise _not_found()
    return endpoint


async def list_endpoints(session: AsyncSession, org_id: uuid.UUID) -> list[Endpoint]:
    result = await session.scalars(
        select(Endpoint)
        .where(Endpoint.org_id == org_id)
        .order_by(Endpoint.created_at.desc(), Endpoint.id)
    )
    return list(result)


def _new_secret(
    endpoint_id: uuid.UUID, box: SecretBox, *, active_from: datetime
) -> tuple[EndpointSecret, str]:
    secret = signing.generate_secret()
    row = EndpointSecret(
        endpoint_id=endpoint_id,
        secret_encrypted=box.encrypt(secret, context=str(endpoint_id)),
        active_from=active_from,
    )
    return row, secret


async def create_endpoint(
    session: AsyncSession,
    actor: Actor,
    *,
    url: str,
    description: str,
    event_types: list[str],
    rate_limit_per_sec: int | None,
    settings: Settings,
    box: SecretBox,
    now: datetime,
) -> tuple[Endpoint, str]:
    """Create an endpoint and its signing secret. The secret is returned once."""
    validate_url(url, settings)
    endpoint = Endpoint(
        id=uuid.uuid4(),  # needed up front: the secret's encryption is bound to it
        org_id=actor.org_id,
        url=url,
        description=description,
        event_types=sorted(set(event_types)),
        rate_limit_per_sec=rate_limit_per_sec,
    )
    secret_row, secret = _new_secret(endpoint.id, box, active_from=now)
    session.add(endpoint)
    await session.flush()
    session.add(secret_row)
    audit.record(
        session,
        org_id=actor.org_id,
        actor_user_id=actor.user_id,
        action="endpoint.created",
        target_type="endpoint",
        target_id=endpoint.id,
        details={"url": url},
    )
    await session.commit()
    await session.refresh(endpoint)
    return endpoint, secret


async def update_endpoint(
    session: AsyncSession,
    actor: Actor,
    endpoint_id: uuid.UUID,
    changes: dict[str, Any],
    *,
    settings: Settings,
) -> Endpoint:
    endpoint = await get_endpoint(session, actor.org_id, endpoint_id)
    if "url" in changes:
        validate_url(changes["url"], settings)
    if "event_types" in changes:
        changes["event_types"] = sorted(set(changes["event_types"]))
    for field, value in changes.items():
        setattr(endpoint, field, value)
    if changes:
        audit.record(
            session,
            org_id=actor.org_id,
            actor_user_id=actor.user_id,
            action="endpoint.updated",
            target_type="endpoint",
            target_id=endpoint.id,
            details={"fields": sorted(changes)},
        )
    await session.commit()
    await session.refresh(endpoint)
    return endpoint


async def delete_endpoint(session: AsyncSession, actor: Actor, endpoint_id: uuid.UUID) -> None:
    endpoint = await get_endpoint(session, actor.org_id, endpoint_id)
    await session.delete(endpoint)
    audit.record(
        session,
        org_id=actor.org_id,
        actor_user_id=actor.user_id,
        action="endpoint.deleted",
        target_type="endpoint",
        target_id=endpoint_id,
        details={"url": endpoint.url},
    )
    await session.commit()


async def set_status(
    session: AsyncSession, actor: Actor, endpoint_id: uuid.UUID, status: EndpointStatus
) -> Endpoint:
    """Pause or resume. Deliveries for a paused endpoint are kept and wait."""
    endpoint = await get_endpoint(session, actor.org_id, endpoint_id)
    if endpoint.status != status:
        endpoint.status = status
        if status is EndpointStatus.ACTIVE:
            # A deliberate resume is a fresh start for the circuit breaker too.
            endpoint.breaker_state = BreakerState.CLOSED
            endpoint.consecutive_failures = 0
            endpoint.breaker_opened_at = None
        audit.record(
            session,
            org_id=actor.org_id,
            actor_user_id=actor.user_id,
            action=f"endpoint.{'resumed' if status is EndpointStatus.ACTIVE else 'paused'}",
            target_type="endpoint",
            target_id=endpoint.id,
        )
    await session.commit()
    await session.refresh(endpoint)
    return endpoint


async def rotate_secret(
    session: AsyncSession,
    actor: Actor,
    endpoint_id: uuid.UUID,
    *,
    settings: Settings,
    box: SecretBox,
    now: datetime,
) -> tuple[str, datetime]:
    """Issue a new signing secret and give the current ones an expiry.

    Until that expiry every message is signed with both, so the customer can
    switch their receiver to the new secret at any point with no failed
    verifications. Returns the new secret (shown once) and when the old one stops.
    """
    endpoint = await get_endpoint(session, actor.org_id, endpoint_id)
    old_expires_at = now + timedelta(hours=settings.secret_rotation_overlap_hours)

    current = await session.scalars(
        select(EndpointSecret).where(
            EndpointSecret.endpoint_id == endpoint.id,
            or_(EndpointSecret.expires_at.is_(None), EndpointSecret.expires_at > old_expires_at),
        )
    )
    for row in current:
        row.expires_at = old_expires_at

    secret_row, secret = _new_secret(endpoint.id, box, active_from=now)
    session.add(secret_row)
    audit.record(
        session,
        org_id=actor.org_id,
        actor_user_id=actor.user_id,
        action="endpoint.secret_rotated",
        target_type="endpoint",
        target_id=endpoint.id,
    )
    await session.commit()
    return secret, old_expires_at


async def active_secrets(
    session: AsyncSession, endpoint_id: uuid.UUID, box: SecretBox, *, now: datetime
) -> list[str]:
    """The secrets to sign with right now, newest first."""
    rows = await session.scalars(
        select(EndpointSecret)
        .where(
            EndpointSecret.endpoint_id == endpoint_id,
            EndpointSecret.active_from <= now,
            or_(EndpointSecret.expires_at.is_(None), EndpointSecret.expires_at > now),
        )
        .order_by(EndpointSecret.active_from.desc(), EndpointSecret.id)
    )
    return [box.decrypt(row.secret_encrypted, context=str(endpoint_id)) for row in rows]


@dataclass(frozen=True, slots=True)
class EndpointHealth:
    endpoint_id: uuid.UUID
    attempts: int
    successes: int
    p95_ms: int | None

    @property
    def success_rate(self) -> float | None:
        return self.successes / self.attempts if self.attempts else None


_HEALTH = text(
    """
    SELECT d.endpoint_id,
           count(*) AS attempts,
           count(*) FILTER (WHERE a.error_kind IS NULL) AS successes,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY a.duration_ms) AS p95_ms
    FROM attempts a
    JOIN deliveries d ON d.id = a.delivery_id
    WHERE d.org_id = :org_id AND a.started_at >= :since
    GROUP BY d.endpoint_id
    """
)


async def endpoint_health(
    session: AsyncSession, org_id: uuid.UUID, *, since: datetime
) -> list[EndpointHealth]:
    """Success rate and 95th-percentile latency per endpoint since ``since``.

    p95 means "95% of attempts were at least this fast": unlike an average, it
    is not hidden by many quick responses when some are very slow.
    """
    rows = await session.execute(_HEALTH, {"org_id": org_id, "since": since})
    return [
        EndpointHealth(
            row.endpoint_id,
            row.attempts,
            row.successes,
            round(row.p95_ms) if row.p95_ms is not None else None,
        )
        for row in rows
    ]
