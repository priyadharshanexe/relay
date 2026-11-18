"""The demo seed (python -m relay.seed) and the public demo's daily reset."""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from relay.core.config import Settings
from relay.core.crypto import SecretBox
from relay.db.models import (
    ApiKey,
    Delivery,
    Endpoint,
    Event,
    Organization,
    ScheduledJob,
    TestReceiver,
    User,
)
from relay.seed import describe
from relay.services import demo
from relay.worker.maintenance import MaintenanceWorker
from tests.conftest import make_settings
from tests.integration.helpers import register

pytestmark = pytest.mark.integration

NOW = datetime(2026, 3, 10, 12, 0, tzinfo=UTC)
DEMO_PASSWORD = "a demo password for tests"  # noqa: S105 - test data


@pytest.fixture
def sessions(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
def demo_settings() -> Settings:
    return make_settings(demo_password=DEMO_PASSWORD)


@pytest.fixture
def box(demo_settings: Settings) -> SecretBox:
    return SecretBox(demo_settings.encryption_key.get_secret_value())


async def rows(session: AsyncSession, model: type) -> int:
    session.expire_all()
    count = int(await session.scalar(select(func.count()).select_from(model)) or 0)
    # End the read transaction: an open one would (rightly) make the next reset
    # wait for it.
    await session.rollback()
    return count


async def seed(
    sessions: async_sessionmaker[AsyncSession], settings: Settings, box: SecretBox
) -> demo.SeedSummary:
    return await demo.seed_demo(sessions, settings=settings, box=box, now=NOW)


# ------------------------------------------------------------------------ seed
async def test_the_seed_creates_a_complete_demo(
    client: AsyncClient,
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    demo_settings: Settings,
    box: SecretBox,
) -> None:
    summary = await seed(sessions, demo_settings, box)

    assert summary.created_account
    assert (summary.receivers_created, summary.endpoints_created) == (2, 2)
    assert summary.events_created == len(demo.SAMPLE_EVENTS)
    assert await rows(session, Organization) == 1
    assert await rows(session, ApiKey) == 1
    assert await rows(session, TestReceiver) == 2
    assert await rows(session, Endpoint) == 2
    assert await rows(session, Event) == len(demo.SAMPLE_EVENTS)
    # Each sample event is queued for both endpoints.
    assert await rows(session, Delivery) == 2 * len(demo.SAMPLE_EVENTS)

    # Each endpoint points at one of the demo's own test receivers.
    tokens = set(await session.scalars(select(TestReceiver.token)))
    urls = set(await session.scalars(select(Endpoint.url)))
    assert urls == {demo_settings.receiver_url_prefix + token for token in tokens}

    # The account works with the configured password.
    login = await client.post(
        "/v1/auth/login", json={"email": "demo@example.com", "password": DEMO_PASSWORD}
    )
    assert login.status_code == 200, login.text
    assert login.json()["organizations"][0] == {
        "id": str(summary.organization_id),
        "name": "Relay Demo",
        "role": "owner",
    }


async def test_seeding_twice_changes_nothing(
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    demo_settings: Settings,
    box: SecretBox,
) -> None:
    first = await seed(sessions, demo_settings, box)
    second = await seed(sessions, demo_settings, box)

    assert not second.changed_anything
    assert second.organization_id == first.organization_id
    assert second.api_key_prefix == first.api_key_prefix
    assert await rows(session, User) == 1
    assert await rows(session, Organization) == 1
    assert await rows(session, ApiKey) == 1
    assert await rows(session, Endpoint) == 2
    assert await rows(session, Event) == len(demo.SAMPLE_EVENTS)


async def test_two_seeds_at_once_create_one_demo(
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    demo_settings: Settings,
    box: SecretBox,
) -> None:
    results = await asyncio.gather(
        seed(sessions, demo_settings, box), seed(sessions, demo_settings, box)
    )

    assert sorted(result.created_account for result in results) == [False, True]
    assert await rows(session, User) == 1
    assert await rows(session, Endpoint) == 2
    assert await rows(session, Event) == len(demo.SAMPLE_EVENTS)


async def test_a_seed_fills_in_what_is_missing(
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    demo_settings: Settings,
    box: SecretBox,
) -> None:
    await seed(sessions, demo_settings, box)
    endpoint = (await session.scalars(select(Endpoint).limit(1))).one()
    await session.delete(endpoint)
    await session.commit()

    again = await seed(sessions, demo_settings, box)

    assert not again.created_account
    assert (again.receivers_created, again.endpoints_created, again.events_created) == (0, 1, 0)
    assert await rows(session, Endpoint) == 2


async def test_a_seed_from_another_address_recognises_the_demo_endpoints(
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    demo_settings: Settings,
    box: SecretBox,
) -> None:
    """Seeding inside Docker, then from the host, must not duplicate endpoints."""
    in_docker = make_settings(demo_password=DEMO_PASSWORD, receiver_base_url="http://api:8000")
    on_host = make_settings(demo_password=DEMO_PASSWORD, receiver_base_url="http://localhost:8000")
    await seed(sessions, in_docker, box)

    again = await seed(sessions, on_host, box)

    assert not again.changed_anything
    assert await rows(session, Endpoint) == 2


async def test_the_seed_output_contains_no_secret(
    sessions: async_sessionmaker[AsyncSession], demo_settings: Settings, box: SecretBox
) -> None:
    summary = await seed(sessions, demo_settings, box)

    text = describe(summary, demo_settings)

    assert "demo@example.com" in text
    assert summary.api_key_prefix in text
    assert DEMO_PASSWORD not in text
    assert "whsec_" not in text
    # The prefix is the only part of the key shown: it is what the dashboard
    # shows too, and cannot be used to authenticate.
    assert len(summary.api_key_prefix) < 20


def test_a_short_demo_password_is_refused() -> None:
    with pytest.raises(ValueError, match="RELAY_DEMO_PASSWORD"):
        make_settings(demo_password="short")  # noqa: S106 - test data


# ----------------------------------------------------------------- demo reset
async def visitor_org_exists(session: AsyncSession) -> bool:
    session.expire_all()
    name = await session.scalar(select(Organization.name).where(Organization.name == "Visitor"))
    await session.rollback()
    return name is not None


async def test_a_reset_wipes_everything_and_seeds_the_demo_again(
    client: AsyncClient,
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    demo_settings: Settings,
    box: SecretBox,
) -> None:
    await seed(sessions, demo_settings, box)
    await register(client, email="visitor@example.com", organization="Visitor")

    did_reset = await demo.reset_demo_if_due(sessions, settings=demo_settings, box=box, now=NOW)

    assert did_reset
    assert not await visitor_org_exists(session)
    assert await rows(session, User) == 1  # only the demo account
    assert await rows(session, Endpoint) == 2
    assert await rows(session, Event) == len(demo.SAMPLE_EVENTS)
    job = await session.get(ScheduledJob, demo.DEMO_RESET_JOB)
    assert job is not None
    assert job.last_run_at == NOW
    # The visitor's session is gone with their account.
    assert (await client.get("/v1/auth/me")).status_code == 401


async def test_the_reset_runs_once_per_day(
    client: AsyncClient,
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    demo_settings: Settings,
    box: SecretBox,
) -> None:
    assert await demo.reset_demo_if_due(sessions, settings=demo_settings, box=box, now=NOW)
    await register(client, email="visitor@example.com", organization="Visitor")

    later_today = NOW + timedelta(hours=10)  # 22:00, before tomorrow's 03:00 slot
    assert not await demo.reset_demo_if_due(
        sessions, settings=demo_settings, box=box, now=later_today
    )
    assert await visitor_org_exists(session)

    tomorrow = NOW.replace(hour=3) + timedelta(days=1)
    assert await demo.reset_demo_if_due(sessions, settings=demo_settings, box=box, now=tomorrow)
    assert not await visitor_org_exists(session)


async def test_two_workers_due_at_once_reset_once(
    sessions: async_sessionmaker[AsyncSession], demo_settings: Settings, box: SecretBox
) -> None:
    results = await asyncio.gather(
        *(
            demo.reset_demo_if_due(sessions, settings=demo_settings, box=box, now=NOW)
            for _ in range(3)
        )
    )

    assert sorted(results) == [False, False, True]


def worker(
    sessions: async_sessionmaker[AsyncSession], settings: Settings, box: SecretBox
) -> MaintenanceWorker:
    return MaintenanceWorker(sessions=sessions, settings=settings, box=box, clock=lambda: NOW)


async def test_without_demo_mode_the_worker_never_resets_or_seeds(
    client: AsyncClient,
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    box: SecretBox,
) -> None:
    await register(client, email="visitor@example.com", organization="Visitor")
    settings = make_settings(demo_password=DEMO_PASSWORD)
    assert settings.demo_mode is False  # off by default

    await worker(sessions, settings, box).tick()

    assert await visitor_org_exists(session)
    assert await rows(session, User) == 1
    assert await session.get(ScheduledJob, demo.DEMO_RESET_JOB) is None


async def test_in_demo_mode_the_worker_resets_when_due(
    client: AsyncClient,
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    box: SecretBox,
) -> None:
    await register(client, email="visitor@example.com", organization="Visitor")
    settings = make_settings(demo_password=DEMO_PASSWORD, demo_mode=True)

    await worker(sessions, settings, box).tick()  # never ran before: due

    assert not await visitor_org_exists(session)
    assert await rows(session, Endpoint) == 2


async def test_in_demo_mode_a_missing_demo_account_is_seeded_back(
    session: AsyncSession,
    sessions: async_sessionmaker[AsyncSession],
    box: SecretBox,
) -> None:
    settings = make_settings(demo_password=DEMO_PASSWORD, demo_mode=True)
    await worker(sessions, settings, box).tick()
    # Someone deletes everything between resets.
    for model in (Organization, User):
        for row in await session.scalars(select(model)):
            await session.delete(row)
    await session.commit()

    await worker(sessions, settings, box).tick()  # not due again today: seeds only

    assert await rows(session, User) == 1
    assert await rows(session, Endpoint) == 2
