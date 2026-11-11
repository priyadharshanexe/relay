import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from relay.api.deps import ApiKeyDep
from relay.core import security
from relay.db.models import ApiKey, AuditLog
from tests.integration.helpers import add_member, register

pytestmark = pytest.mark.integration


@pytest.fixture
async def other_client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


@pytest.fixture
def machine_route(app: FastAPI) -> None:
    """A route protected the way event ingestion will be: by API key."""

    @app.get("/test/machine")
    async def machine(context: ApiKeyDep) -> dict[str, str]:
        return {"org_id": str(context.org_id)}


async def create_key(client: AsyncClient, name: str = "backend") -> dict[str, str]:
    response = await client.post("/v1/api-keys", json={"name": name})
    assert response.status_code == 201, response.text
    body: dict[str, str] = response.json()
    return body


# ------------------------------------------------------------------- lifecycle
async def test_a_new_key_is_shown_once_and_stored_only_as_a_hash(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)

    created = await create_key(client)

    key = created["key"]
    assert key.startswith("rly_test_")
    assert created["prefix"] == key[:17]
    stored = await session.scalar(select(ApiKey))
    assert stored is not None
    assert stored.key_hash == security.hash_token(key)
    assert key not in (stored.key_hash, stored.prefix, stored.name)

    listed = (await client.get("/v1/api-keys")).json()
    assert [item["id"] for item in listed] == [created["id"]]
    assert "key" not in listed[0]
    assert "key_hash" not in listed[0]
    assert key not in str(listed)


async def test_every_key_is_different(client: AsyncClient) -> None:
    await register(client)

    keys = {(await create_key(client, f"key {n}"))["key"] for n in range(5)}

    assert len(keys) == 5


async def test_keys_are_listed_newest_first(client: AsyncClient) -> None:
    await register(client)
    for name in ("first", "second", "third"):
        await create_key(client, name)

    names = [item["name"] for item in (await client.get("/v1/api-keys")).json()]

    assert names == ["third", "second", "first"]


async def test_revoking_marks_the_key_and_is_safe_to_repeat(client: AsyncClient) -> None:
    await register(client)
    created = await create_key(client)

    first = await client.delete(f"/v1/api-keys/{created['id']}")
    second = await client.delete(f"/v1/api-keys/{created['id']}")

    assert first.status_code == second.status_code == 204
    listed = (await client.get("/v1/api-keys")).json()
    assert listed[0]["revoked_at"] is not None


async def test_creating_and_revoking_are_audited(
    client: AsyncClient, session: AsyncSession
) -> None:
    body = await register(client)
    created = await create_key(client)
    await client.delete(f"/v1/api-keys/{created['id']}")

    entries = (
        await session.execute(
            select(AuditLog.action, AuditLog.target_id, AuditLog.actor_user_id).where(
                AuditLog.target_type == "api_key"
            )
        )
    ).all()

    assert sorted(action for action, _, _ in entries) == ["api_key.created", "api_key.revoked"]
    assert {target for _, target, _ in entries} == {created["id"]}
    assert {str(actor) for _, _, actor in entries} == {body["user"]["id"]}
    assert created["key"] not in str((await session.scalars(select(AuditLog.details))).all())


@pytest.mark.parametrize("payload", [{}, {"name": ""}, {"name": "x" * 201}])
async def test_invalid_key_names_are_rejected(client: AsyncClient, payload: dict[str, str]) -> None:
    await register(client)

    assert (await client.post("/v1/api-keys", json=payload)).status_code == 422


async def test_managing_keys_requires_a_session(client: AsyncClient) -> None:
    assert (await client.get("/v1/api-keys")).status_code == 401
    assert (await client.post("/v1/api-keys", json={"name": "x"})).status_code == 401
    assert (await client.delete(f"/v1/api-keys/{uuid.uuid4()}")).status_code == 401


# ------------------------------------------------------------------------ roles
@pytest.mark.parametrize(
    ("role", "can_edit"), [("owner", True), ("developer", True), ("viewer", False)]
)
async def test_only_owners_and_developers_can_create_and_revoke(
    client: AsyncClient,
    other_client: AsyncClient,
    session: AsyncSession,
    role: str,
    can_edit: bool,
) -> None:
    owner = await register(client, "owner@example.com", "Acme")
    acme_id = owner["organizations"][0]["id"]
    existing = await create_key(client)
    member = await register(other_client, "member@example.com", "Their Own Org")
    await add_member(session, user_id=member["user"]["id"], org_id=acme_id, role=role)
    in_acme = {"X-Org-ID": acme_id}

    listing = await other_client.get("/v1/api-keys", headers=in_acme)
    create = await other_client.post("/v1/api-keys", json={"name": "mine"}, headers=in_acme)
    revoke = await other_client.delete(f"/v1/api-keys/{existing['id']}", headers=in_acme)

    assert listing.status_code == 200  # everyone in the organisation can look
    assert create.status_code == (201 if can_edit else 403)
    assert revoke.status_code == (204 if can_edit else 403)
    if not can_edit:
        assert create.json()["code"] == "forbidden"


# ---------------------------------------------------------------------- tenancy
async def test_one_organisation_cannot_see_or_revoke_anothers_keys(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client, "a@example.com", "Org A")
    key_a = await create_key(client)
    await register(other_client, "b@example.com", "Org B")

    listed_by_b = await other_client.get("/v1/api-keys")
    revoke_by_b = await other_client.delete(f"/v1/api-keys/{key_a['id']}")

    assert listed_by_b.json() == []
    assert revoke_by_b.status_code == 404  # indistinguishable from "does not exist"
    assert (await client.get("/v1/api-keys")).json()[0]["revoked_at"] is None


async def test_naming_an_organisation_you_are_not_in_is_a_404(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    org_a = (await register(client, "a@example.com", "Org A"))["organizations"][0]["id"]
    await register(other_client, "b@example.com", "Org B")

    as_outsider = await other_client.get("/v1/api-keys", headers={"X-Org-ID": org_a})
    nonexistent = await other_client.get("/v1/api-keys", headers={"X-Org-ID": str(uuid.uuid4())})
    malformed = await other_client.get("/v1/api-keys", headers={"X-Org-ID": "not-a-uuid"})

    assert as_outsider.status_code == nonexistent.status_code == 404
    assert as_outsider.json()["code"] == nonexistent.json()["code"] == "organization_not_found"
    assert malformed.status_code == 422


async def test_a_user_in_two_organisations_switches_with_the_header(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    alice = await register(client, "alice@example.com", "Alice Org")
    bob = await register(other_client, "bob@example.com", "Bob Org")
    bob_org = bob["organizations"][0]["id"]
    await add_member(session, user_id=alice["user"]["id"], org_id=bob_org, role="developer")
    await create_key(client, "in alice org")
    await client.post("/v1/api-keys", json={"name": "in bob org"}, headers={"X-Org-ID": bob_org})

    default = (await client.get("/v1/api-keys")).json()
    switched = (await client.get("/v1/api-keys", headers={"X-Org-ID": bob_org})).json()
    organizations = (await client.get("/v1/orgs")).json()

    assert [key["name"] for key in default] == ["in alice org"]
    assert [key["name"] for key in switched] == ["in bob org"]
    assert [(org["name"], org["role"]) for org in organizations] == [
        ("Alice Org", "owner"),
        ("Bob Org", "developer"),
    ]


async def test_members_are_listed_for_the_current_organisation_only(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    alice = await register(client, "alice@example.com", "Alice Org")
    bob = await register(other_client, "bob@example.com", "Bob Org")
    await add_member(
        session,
        user_id=bob["user"]["id"],
        org_id=alice["organizations"][0]["id"],
        role="viewer",
    )

    alice_org = (await client.get("/v1/orgs/current/members")).json()
    bob_org = (await other_client.get("/v1/orgs/current/members")).json()

    assert [(m["email"], m["role"]) for m in alice_org] == [
        ("alice@example.com", "owner"),
        ("bob@example.com", "viewer"),
    ]
    assert [(m["email"], m["role"]) for m in bob_org] == [("bob@example.com", "owner")]


# ------------------------------------------------------- authenticating with a key
@pytest.mark.usefixtures("machine_route")
async def test_a_valid_key_authenticates_as_its_organisation(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    org_id = (await register(client))["organizations"][0]["id"]
    key = (await create_key(client))["key"]

    response = await other_client.get("/test/machine", headers={"Authorization": f"Bearer {key}"})

    assert response.status_code == 200
    assert response.json() == {"org_id": org_id}


@pytest.mark.usefixtures("machine_route")
async def test_missing_malformed_and_revoked_keys_are_refused(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    created = await create_key(client)
    key = created["key"]
    session_token = client.cookies["relay_access"]

    attempts = {
        "no header": {},
        "not bearer": {"Authorization": f"Basic {key}"},
        "empty bearer": {"Authorization": "Bearer "},
        "made-up key": {"Authorization": "Bearer rly_test_" + "a" * 43},
        "truncated key": {"Authorization": f"Bearer {key[:-1]}"},
        "prefix only": {"Authorization": f"Bearer {created['prefix']}"},
        "a dashboard session token is not an API key": {"Authorization": f"Bearer {session_token}"},
    }
    for label, headers in attempts.items():
        response = await other_client.get("/test/machine", headers=headers)
        assert response.status_code == 401, label
        assert response.json()["code"] == "invalid_api_key"

    await client.delete(f"/v1/api-keys/{created['id']}")
    revoked = await other_client.get("/test/machine", headers={"Authorization": f"Bearer {key}"})
    assert revoked.status_code == 401


@pytest.mark.usefixtures("machine_route")
async def test_an_api_key_cannot_be_used_as_a_dashboard_session(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    key = (await create_key(client))["key"]

    response = await other_client.get("/v1/api-keys", headers={"Authorization": f"Bearer {key}"})

    assert response.status_code == 401


@pytest.mark.usefixtures("machine_route")
async def test_last_used_is_recorded_but_not_rewritten_on_every_request(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = (await create_key(client))["key"]
    headers = {"Authorization": f"Bearer {key}"}
    assert (await client.get("/v1/api-keys")).json()[0]["last_used_at"] is None

    await other_client.get("/test/machine", headers=headers)
    first_use = await session.scalar(select(ApiKey.last_used_at))
    await other_client.get("/test/machine", headers=headers)
    session.expire_all()
    second_use = await session.scalar(select(ApiKey.last_used_at))

    assert first_use is not None
    assert datetime.now(UTC) - first_use < timedelta(seconds=30)
    assert second_use == first_use  # within the same minute: no extra write
