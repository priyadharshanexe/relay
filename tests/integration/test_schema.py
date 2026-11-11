"""The database itself enforces the rules the design depends on.

Application code can have bugs and races; these constraints are the last line of
defence, so each one gets a test.
"""

import asyncio
import uuid
from typing import Any

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from relay.db.models import (
    ApiKey,
    Attempt,
    AuditLog,
    Base,
    Delivery,
    Endpoint,
    EndpointSecret,
    Event,
    Membership,
    Organization,
    User,
)

pytestmark = pytest.mark.integration


# ------------------------------------------------------------------- builders
async def make_org(session: AsyncSession, name: str = "Acme") -> Organization:
    org = Organization(name=name)
    session.add(org)
    await session.flush()
    return org


async def make_user(session: AsyncSession, email: str = "dev@example.com") -> User:
    user = User(email=email, password_hash="not-a-real-hash")  # noqa: S106
    session.add(user)
    await session.flush()
    return user


async def make_endpoint(session: AsyncSession, org: Organization, **fields: Any) -> Endpoint:
    endpoint = Endpoint(org_id=org.id, url="https://example.com/hooks", **fields)
    session.add(endpoint)
    await session.flush()
    return endpoint


async def make_event(session: AsyncSession, org: Organization, **fields: Any) -> Event:
    event = Event(org_id=org.id, type="order.paid", payload={"order": 1}, **fields)
    session.add(event)
    await session.flush()
    return event


async def make_delivery(
    session: AsyncSession, org: Organization, event: Event, endpoint: Endpoint, **fields: Any
) -> Delivery:
    delivery = Delivery(org_id=org.id, event_id=event.id, endpoint_id=endpoint.id, **fields)
    session.add(delivery)
    await session.flush()
    return delivery


async def count(session: AsyncSession, model: type[Base]) -> int:
    result = await session.execute(select(func.count()).select_from(model))
    return int(result.scalar_one())


def violated(error: pytest.ExceptionInfo[IntegrityError]) -> str:
    return str(error.value.orig)


# ---------------------------------------------------------------- idempotency
async def test_same_idempotency_key_in_one_org_is_rejected(session: AsyncSession) -> None:
    org = await make_org(session)
    await make_event(session, org, idempotency_key="key-1")

    with pytest.raises(IntegrityError) as error:
        await make_event(session, org, idempotency_key="key-1")

    assert "uq_events_org_id_idempotency_key" in violated(error)


async def test_same_idempotency_key_in_different_orgs_is_allowed(session: AsyncSession) -> None:
    first = await make_org(session, "First")
    second = await make_org(session, "Second")

    await make_event(session, first, idempotency_key="key-1")
    await make_event(session, second, idempotency_key="key-1")

    assert await count(session, Event) == 2


async def test_events_without_an_idempotency_key_never_conflict(session: AsyncSession) -> None:
    org = await make_org(session)

    await make_event(session, org)
    await make_event(session, org)

    assert await count(session, Event) == 2


async def test_concurrent_inserts_with_one_key_store_exactly_one_event(
    engine: AsyncEngine, session: AsyncSession
) -> None:
    """The race a check-then-insert would lose: ten requests at the same moment."""
    org = await make_org(session)
    await session.commit()

    async def insert() -> bool:
        async with AsyncSession(engine) as own_session:
            own_session.add(
                Event(org_id=org.id, type="order.paid", payload={}, idempotency_key="race")
            )
            try:
                await own_session.commit()
            except IntegrityError:
                return False
            return True

    results = await asyncio.gather(*(insert() for _ in range(10)))

    assert results.count(True) == 1
    assert await count(session, Event) == 1


# ----------------------------------------------------------------- deliveries
async def test_a_new_delivery_starts_pending_and_due_now(session: AsyncSession) -> None:
    org = await make_org(session)
    delivery = await make_delivery(
        session, org, await make_event(session, org), await make_endpoint(session, org)
    )
    await session.refresh(delivery)

    assert delivery.status == "pending"
    assert delivery.attempts == 0
    assert delivery.next_attempt_at is not None
    assert delivery.locked_until is None


async def test_an_event_has_at_most_one_delivery_per_endpoint(session: AsyncSession) -> None:
    org = await make_org(session)
    event = await make_event(session, org)
    endpoint = await make_endpoint(session, org)
    await make_delivery(session, org, event, endpoint)

    with pytest.raises(IntegrityError) as error:
        await make_delivery(session, org, event, endpoint)

    assert "uq_deliveries_event_id_endpoint_id" in violated(error)


async def test_one_event_can_go_to_several_endpoints(session: AsyncSession) -> None:
    org = await make_org(session)
    event = await make_event(session, org)

    for _ in range(3):
        await make_delivery(session, org, event, await make_endpoint(session, org))

    assert await count(session, Delivery) == 3


# ---------------------------------------------------------- check constraints
async def test_unknown_delivery_status_is_rejected(session: AsyncSession) -> None:
    org = await make_org(session)
    event = await make_event(session, org)
    endpoint = await make_endpoint(session, org)

    with pytest.raises(IntegrityError) as error:
        await make_delivery(session, org, event, endpoint, status="lost")

    assert "ck_deliveries_status_valid" in violated(error)


async def test_unknown_role_is_rejected(session: AsyncSession) -> None:
    org = await make_org(session)
    user = await make_user(session)
    session.add(Membership(user_id=user.id, org_id=org.id, role="admin"))

    with pytest.raises(IntegrityError) as error:
        await session.flush()

    assert "ck_memberships_role_valid" in violated(error)


async def test_unknown_endpoint_status_is_rejected(session: AsyncSession) -> None:
    org = await make_org(session)

    with pytest.raises(IntegrityError) as error:
        await make_endpoint(session, org, status="broken")

    assert "ck_endpoints_status_valid" in violated(error)


async def test_unknown_breaker_state_is_rejected(session: AsyncSession) -> None:
    org = await make_org(session)

    with pytest.raises(IntegrityError) as error:
        await make_endpoint(session, org, breaker_state="ajar")

    assert "ck_endpoints_breaker_state_valid" in violated(error)


async def test_zero_rate_limit_is_rejected(session: AsyncSession) -> None:
    org = await make_org(session)

    with pytest.raises(IntegrityError) as error:
        await make_endpoint(session, org, rate_limit_per_sec=0)

    assert "ck_endpoints_rate_limit_positive" in violated(error)


async def test_unknown_error_kind_is_rejected_but_null_is_fine(session: AsyncSession) -> None:
    org = await make_org(session)
    delivery = await make_delivery(
        session, org, await make_event(session, org), await make_endpoint(session, org)
    )
    session.add(Attempt(delivery_id=delivery.id, attempt_number=1, duration_ms=12, status_code=200))
    await session.flush()  # a successful attempt has no error_kind

    session.add(
        Attempt(delivery_id=delivery.id, attempt_number=2, duration_ms=12, error_kind="gremlins")
    )
    with pytest.raises(IntegrityError) as error:
        await session.flush()

    assert "ck_attempts_error_kind_valid" in violated(error)


async def test_email_must_be_lowercase_so_uniqueness_ignores_case(session: AsyncSession) -> None:
    with pytest.raises(IntegrityError) as error:
        await make_user(session, "Dev@Example.com")

    assert "ck_users_email_lowercase" in violated(error)


async def test_duplicate_email_is_rejected(session: AsyncSession) -> None:
    await make_user(session, "dev@example.com")

    with pytest.raises(IntegrityError) as error:
        await make_user(session, "dev@example.com")

    assert "uq_users_email" in violated(error)


async def test_api_key_prefix_and_hash_are_unique(session: AsyncSession) -> None:
    org = await make_org(session)
    session.add(ApiKey(org_id=org.id, name="one", prefix="rly_test_aaaa", key_hash="a" * 64))
    await session.flush()

    session.add(ApiKey(org_id=org.id, name="two", prefix="rly_test_bbbb", key_hash="a" * 64))
    with pytest.raises(IntegrityError) as error:
        await session.flush()

    assert "uq_api_keys_key_hash" in violated(error)


# -------------------------------------------------------------------- cascades
async def test_deleting_an_event_removes_its_deliveries_and_attempts(
    session: AsyncSession,
) -> None:
    org = await make_org(session)
    event = await make_event(session, org)
    delivery = await make_delivery(session, org, event, await make_endpoint(session, org))
    session.add(Attempt(delivery_id=delivery.id, attempt_number=1, duration_ms=5, status_code=500))
    await session.flush()

    await session.execute(text("DELETE FROM events WHERE id = :id"), {"id": event.id})

    assert await count(session, Delivery) == 0
    assert await count(session, Attempt) == 0
    assert await count(session, Endpoint) == 1  # the endpoint itself stays


async def test_deleting_an_organisation_removes_all_its_data(session: AsyncSession) -> None:
    org = await make_org(session)
    other = await make_org(session, "Other")
    user = await make_user(session)
    session.add(Membership(user_id=user.id, org_id=org.id, role="owner"))
    session.add(ApiKey(org_id=org.id, name="k", prefix="rly_test_cccc", key_hash="c" * 64))
    endpoint = await make_endpoint(session, org)
    session.add(EndpointSecret(endpoint_id=endpoint.id, secret_encrypted="ciphertext"))  # noqa: S106
    await make_delivery(session, org, await make_event(session, org), endpoint)
    session.add(AuditLog(org_id=org.id, action="x", target_type="endpoint", target_id="1"))
    await make_event(session, other)
    await session.flush()

    await session.execute(text("DELETE FROM organizations WHERE id = :id"), {"id": org.id})

    for model in (Membership, ApiKey, Endpoint, EndpointSecret, Delivery, AuditLog):
        assert await count(session, model) == 0, model.__name__
    assert await count(session, Event) == 1  # the other organisation's event
    assert await count(session, User) == 1  # users outlive an organisation


async def test_deleting_a_user_keeps_the_audit_trail(session: AsyncSession) -> None:
    org = await make_org(session)
    user = await make_user(session)
    entry = AuditLog(
        org_id=org.id,
        actor_user_id=user.id,
        action="endpoint.created",
        target_type="endpoint",
        target_id=str(uuid.uuid4()),
    )
    session.add(entry)
    await session.flush()

    await session.execute(text("DELETE FROM users WHERE id = :id"), {"id": user.id})
    await session.refresh(entry)

    assert entry.actor_user_id is None
    assert entry.action == "endpoint.created"


# --------------------------------------------------------------------- indexes
async def _index_definition(session: AsyncSession, name: str) -> str:
    result = await session.execute(
        text("SELECT indexdef FROM pg_indexes WHERE indexname = :name"), {"name": name}
    )
    return str(result.scalar_one())


async def test_due_index_is_partial_over_waiting_deliveries_only(session: AsyncSession) -> None:
    definition = await _index_definition(session, "deliveries_due")

    assert "(next_attempt_at)" in definition
    assert "WHERE" in definition
    assert "'pending'" in definition
    assert "'retrying'" in definition
    assert "succeeded" not in definition


async def test_expired_lock_index_covers_in_flight_deliveries_only(session: AsyncSession) -> None:
    definition = await _index_definition(session, "deliveries_expired_locks")

    assert "(locked_until)" in definition
    assert "'in_flight'" in definition


async def test_explorer_indexes_are_newest_first(session: AsyncSession) -> None:
    for name in ("ix_deliveries_org_id_created_at", "ix_deliveries_endpoint_id_created_at"):
        assert "created_at DESC" in await _index_definition(session, name)
