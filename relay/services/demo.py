"""Demo data: a ready-made organisation to look at, and the daily demo reset.

``seed_demo`` is made of "make sure this exists" steps (the account, the API key,
the test receivers, the endpoints, the sample events), each skipped when its
result is already there. So it is safe to run twice, and a run that was cut off
half-way is completed by the next one instead of leaving a broken demo.

It never prints a secret. The API key and the endpoints' signing secrets are
created like any other (shown once, stored hashed or encrypted) and then thrown
away: whoever needs one creates a fresh one in the dashboard.

``reset_demo`` is for the public demo only. It deletes ALL data, every visitor's
organisation included, then seeds the demo again.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from relay.core import metrics
from relay.core.config import Settings
from relay.core.crypto import SecretBox
from relay.core.logging import get_logger
from relay.db.models import ApiKey, Base, Endpoint, Membership, ScheduledJob, TestReceiver, User
from relay.domain.enums import ReceiverMode, Role
from relay.domain.schedule import daily_run_due
from relay.services import api_keys, auth, endpoints, events, receivers

log = get_logger("relay.demo")

API_KEY_NAME = "demo-backend"

# (name, how it answers). One that works and one that fails, so the demo shows
# both a clean delivery and retries.
RECEIVERS: tuple[tuple[str, ReceiverMode], ...] = (
    ("Healthy customer", ReceiverMode.OK),
    ("Flaky customer", ReceiverMode.ERROR),
)

# (idempotency key, event type, payload). The keys make re-seeding a no-op.
SAMPLE_EVENTS: tuple[tuple[str, str, dict[str, Any]], ...] = (
    ("seed-order-1001-created", "order.created", {"order_id": 1001, "total": "49.00"}),
    ("seed-order-1001-paid", "order.paid", {"order_id": 1001, "total": "49.00"}),
    ("seed-order-1002-created", "order.created", {"order_id": 1002, "total": "120.50"}),
    ("seed-order-1002-refunded", "order.refunded", {"order_id": 1002, "amount": "120.50"}),
    ("seed-invoice-77-finalized", "invoice.finalized", {"invoice_id": 77, "currency": "EUR"}),
)

# Only one seed may run at a time (two workers, or a worker and a person).
_SEED_LOCK_KEY = 0x5EED_DE30

DEMO_RESET_JOB = "demo_reset"


@dataclass(frozen=True, slots=True)
class SeedSummary:
    organization_id: uuid.UUID
    email: str
    created_account: bool
    api_key_prefix: str
    receivers_created: int
    endpoints_created: int
    events_created: int

    @property
    def changed_anything(self) -> bool:
        return (
            self.created_account
            or self.receivers_created > 0
            or self.endpoints_created > 0
            or self.events_created > 0
        )


async def _ensure_account(
    session: AsyncSession, settings: Settings
) -> tuple[User, uuid.UUID, bool]:
    email = auth.normalize_email(settings.demo_email)
    user = await session.scalar(select(User).where(User.email == email))
    if user is None:
        user = await auth.register(
            session,
            email=email,
            password=settings.demo_password.get_secret_value(),
            organization_name=settings.demo_organization_name,
        )
        created = True
    else:
        created = False
    org_id = await session.scalar(
        select(Membership.org_id)
        .where(Membership.user_id == user.id, Membership.role == Role.OWNER)
        .order_by(Membership.created_at)
        .limit(1)
    )
    if org_id is None:
        # The account exists but owns nothing (an owner removed it, or it left).
        # Guessing which organisation to fill would be wrong: say so instead.
        raise RuntimeError(
            f"{email} exists but owns no organisation; delete the account or pick "
            "another RELAY_DEMO_EMAIL"
        )
    return user, org_id, created


async def _ensure_api_key(session: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID) -> str:
    existing = await session.scalar(
        select(ApiKey.prefix).where(
            ApiKey.org_id == org_id, ApiKey.name == API_KEY_NAME, ApiKey.revoked_at.is_(None)
        )
    )
    if existing is not None:
        return existing
    # The full key is returned once, here, and deliberately dropped.
    key, _full_key = await api_keys.create_api_key(
        session, org_id=org_id, name=API_KEY_NAME, actor_user_id=user_id, live=False
    )
    return key.prefix


async def seed_demo(
    sessions: async_sessionmaker[AsyncSession],
    *,
    settings: Settings,
    box: SecretBox,
    now: datetime,
) -> SeedSummary:
    """Create the demo organisation and its contents, or fill in what is missing."""
    engine = sessions.kw["bind"]
    assert isinstance(engine, AsyncEngine)  # noqa: S101 - how the factory is built
    # One connection for the whole seed. The lock below belongs to a connection,
    # and the steps commit as they go; a pooled session could hand back its
    # connection after a commit and carry on with another, leaking the lock.
    async with engine.connect() as connection:
        session = AsyncSession(bind=connection, expire_on_commit=False)
        try:
            # A second seed waits here, then finds everything already there.
            await session.execute(text("SELECT pg_advisory_lock(:key)"), {"key": _SEED_LOCK_KEY})
            await session.commit()
            try:
                return await _seed(session, settings=settings, box=box, now=now)
            finally:
                await session.rollback()
                await session.execute(
                    text("SELECT pg_advisory_unlock(:key)"), {"key": _SEED_LOCK_KEY}
                )
                await session.commit()
        finally:
            await session.close()


async def _seed(
    session: AsyncSession, *, settings: Settings, box: SecretBox, now: datetime
) -> SeedSummary:
    user, org_id, created_account = await _ensure_account(session, settings)
    # Plain values from here on: a step that rolls back (an event that already
    # exists does) expires every loaded row, and reading one again would need IO.
    user_id, email = user.id, user.email
    actor = endpoints.Actor(org_id=org_id, user_id=user_id)
    prefix = await _ensure_api_key(session, org_id, user_id)

    receivers_created = endpoints_created = 0
    for name, mode in RECEIVERS:
        receiver = await session.scalar(
            select(TestReceiver).where(TestReceiver.org_id == org_id, TestReceiver.name == name)
        )
        if receiver is None:
            receiver = await receivers.create_receiver(
                session, org_id=org_id, fields={"name": name, "mode": mode}
            )
            receivers_created += 1
        url = settings.receiver_url_prefix + receiver.token
        # Matched on the receiver's token, not the whole URL: the address of the
        # API differs between a container (http://api:8000) and the host
        # (http://localhost:8000), and a seed run from either must recognise the
        # endpoints the other one made.
        has_endpoint = await session.scalar(
            select(Endpoint.id)
            .where(Endpoint.org_id == org_id, Endpoint.url.endswith(f"/receiver/{receiver.token}"))
            .limit(1)
        )
        if has_endpoint is None:
            # The signing secret is returned once and dropped: the built-in
            # receiver does not check signatures.
            await endpoints.create_endpoint(
                session,
                actor,
                url=url,
                description=f"Demo: {name}",
                event_types=[],
                rate_limit_per_sec=None,
                settings=settings,
                box=box,
                now=now,
            )
            endpoints_created += 1

    events_created = 0
    for key, event_type, payload in SAMPLE_EVENTS:
        result = await events.create_event(
            session,
            org_id=org_id,
            event_type=event_type,
            payload=payload,
            idempotency_key=key,
        )
        if not result.replayed:
            events_created += 1

    summary = SeedSummary(
        organization_id=org_id,
        email=email,
        created_account=created_account,
        api_key_prefix=prefix,
        receivers_created=receivers_created,
        endpoints_created=endpoints_created,
        events_created=events_created,
    )
    if summary.changed_anything:
        log.info(
            "demo.seeded",
            org_id=str(org_id),
            created_account=created_account,
            receivers_created=receivers_created,
            endpoints_created=endpoints_created,
            events_created=events_created,
        )
    return summary


async def demo_account_exists(session: AsyncSession, settings: Settings) -> bool:
    email = auth.normalize_email(settings.demo_email)
    return await session.scalar(select(User.id).where(User.email == email)) is not None


def _tenant_tables() -> str:
    # Everything except the scheduler's own bookkeeping.
    return ", ".join(
        table.name
        for table in Base.metadata.sorted_tables
        if table.name != ScheduledJob.__tablename__
    )


async def wipe_all_data(session: AsyncSession) -> None:
    """Delete every organisation, user and everything they own. No commit."""
    # Waiting for a lock is fine for a few seconds, not forever: if the
    # workers are busy, give up and try on the next round.
    await session.execute(text("SET LOCAL lock_timeout = '10s'"))
    await session.execute(text(f"TRUNCATE {_tenant_tables()} CASCADE"))


async def reset_demo_if_due(
    sessions: async_sessionmaker[AsyncSession],
    *,
    settings: Settings,
    box: SecretBox,
    now: datetime,
    due: bool | None = None,
) -> bool:
    """Wipe everything and seed again, at most once per daily slot.

    Returns True when this call did the reset. ``due`` overrides the schedule
    check (for tests); normally it is worked out from the last run.
    """
    async with sessions() as session:
        await session.execute(
            text("INSERT INTO scheduled_jobs (name) VALUES (:name) ON CONFLICT (name) DO NOTHING"),
            {"name": DEMO_RESET_JOB},
        )
        await session.commit()

        # Whoever holds this row is the one resetting; the others skip.
        job = await session.scalar(
            select(ScheduledJob)
            .where(ScheduledJob.name == DEMO_RESET_JOB)
            .with_for_update(skip_locked=True)
        )
        if job is None:
            await session.rollback()
            return False
        is_due = (
            due
            if due is not None
            else daily_run_due(
                now=now, last_run=job.last_run_at, hour_utc=settings.demo_reset_hour_utc
            )
        )
        if not is_due:
            await session.rollback()
            return False

        await wipe_all_data(session)
        job.last_run_at = now
        await session.commit()

    metrics.DEMO_RESETS.inc()
    log.warning("demo.reset", at=now.isoformat())
    # Seeded after the wipe is committed. If this fails, the next round sees no
    # demo account and seeds then.
    await seed_demo(sessions, settings=settings, box=box, now=now)
    return True
