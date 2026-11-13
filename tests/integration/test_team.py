"""Team management: renaming the organisation, roles, removal and invitations."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from relay.db.models import AuditLog, Invitation, Membership
from tests.integration.helpers import PASSWORD, add_member, login, register

pytestmark = pytest.mark.integration


async def invite(
    client: AsyncClient, email: str = "dev@example.com", role: str = "developer"
) -> dict[str, Any]:
    response = await client.post(
        "/v1/orgs/current/invitations", json={"email": email, "role": role}
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def join(client: AsyncClient, token: str, email: str = "dev@example.com") -> dict[str, Any]:
    """Sign up through an invitation link."""
    response = await client.post(
        "/v1/auth/register",
        json={"email": email, "password": PASSWORD, "invitation_token": token},
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def members(client: AsyncClient) -> dict[str, str]:
    response = await client.get("/v1/orgs/current/members")
    assert response.status_code == 200, response.text
    return {member["email"]: member["role"] for member in response.json()}


async def audit_actions(session: AsyncSession) -> list[str]:
    return list(await session.scalars(select(AuditLog.action)))


# ----------------------------------------------------------------------- rename
async def test_an_owner_can_rename_the_organisation(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)

    response = await client.patch("/v1/orgs/current", json={"name": "  Acme Payments  "})

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Acme Payments"
    me = await client.get("/v1/auth/me")
    assert me.json()["organizations"][0]["name"] == "Acme Payments"
    assert "organization.renamed" in await audit_actions(session)


@pytest.mark.parametrize("name", ["", "   ", "x" * 201])
async def test_a_bad_organisation_name_is_refused(client: AsyncClient, name: str) -> None:
    await register(client)
    response = await client.patch("/v1/orgs/current", json={"name": name})
    assert response.status_code == 422


@pytest.mark.parametrize("role", ["developer", "viewer"])
async def test_only_owners_manage_the_team(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession, role: str
) -> None:
    owner = await register(client)
    other = await register(other_client, email="other@example.com", organization="Other")
    org_id = owner["organizations"][0]["id"]
    await add_member(session, user_id=other["user"]["id"], org_id=org_id, role=role)
    headers = {"X-Org-ID": org_id}
    owner_id = owner["user"]["id"]

    attempts = [
        await other_client.patch("/v1/orgs/current", json={"name": "Mine"}, headers=headers),
        await other_client.get("/v1/orgs/current/invitations", headers=headers),
        await other_client.post(
            "/v1/orgs/current/invitations", json={"email": "x@example.com"}, headers=headers
        ),
        await other_client.delete(f"/v1/orgs/current/invitations/{uuid.uuid4()}", headers=headers),
        await other_client.patch(
            f"/v1/orgs/current/members/{owner_id}", json={"role": "viewer"}, headers=headers
        ),
        await other_client.delete(f"/v1/orgs/current/members/{owner_id}", headers=headers),
    ]

    assert [response.status_code for response in attempts] == [403] * 6
    assert all(response.json()["code"] == "forbidden" for response in attempts)
    # They can still see who is in the team.
    assert (await other_client.get("/v1/orgs/current/members", headers=headers)).status_code == 200


# ------------------------------------------------------------------------ roles
async def test_an_owner_can_change_a_members_role(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    joined = await join(other_client, (await invite(client))["token"])
    member_id = joined["user"]["id"]

    response = await client.patch(f"/v1/orgs/current/members/{member_id}", json={"role": "viewer"})

    assert response.status_code == 200, response.text
    assert response.json()["role"] == "viewer"
    assert (await members(client))["dev@example.com"] == "viewer"
    # It takes effect on the member's very next request.
    refused = await other_client.post("/v1/api-keys", json={"name": "k"})
    assert refused.status_code == 403
    assert "member.role_changed" in await audit_actions(session)


async def test_the_last_owner_cannot_be_demoted_or_removed(client: AsyncClient) -> None:
    owner = await register(client)
    owner_id = owner["user"]["id"]

    demote = await client.patch(f"/v1/orgs/current/members/{owner_id}", json={"role": "developer"})
    remove = await client.delete(f"/v1/orgs/current/members/{owner_id}")

    assert demote.status_code == 409
    assert demote.json()["code"] == "last_owner"
    assert remove.status_code == 409
    assert remove.json()["code"] == "last_owner"
    assert await members(client) == {"owner@example.com": "owner"}


async def test_an_owner_can_step_down_once_there_is_another_owner(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    owner = await register(client)
    await join(other_client, (await invite(client, role="owner"))["token"])

    response = await client.patch(
        f"/v1/orgs/current/members/{owner['user']['id']}", json={"role": "viewer"}
    )

    assert response.status_code == 200, response.text
    assert await members(other_client) == {
        "owner@example.com": "viewer",
        "dev@example.com": "owner",
    }


async def test_removing_a_member_ends_their_access_at_once(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    joined = await join(other_client, (await invite(client))["token"])
    assert (await other_client.get("/v1/endpoints")).status_code == 200

    response = await client.delete(f"/v1/orgs/current/members/{joined['user']['id']}")

    assert response.status_code == 204
    assert await members(client) == {"owner@example.com": "owner"}
    assert (await other_client.get("/v1/endpoints")).status_code in {403, 404}
    assert (await other_client.get("/v1/auth/me")).json()["organizations"] == []
    assert "member.removed" in await audit_actions(session)


async def test_changing_or_removing_someone_who_is_not_a_member_is_404(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    stranger = await register(other_client, email="other@example.com", organization="Other")
    stranger_id = stranger["user"]["id"]

    change = await client.patch(f"/v1/orgs/current/members/{stranger_id}", json={"role": "viewer"})
    remove = await client.delete(f"/v1/orgs/current/members/{stranger_id}")

    assert change.status_code == 404
    assert change.json()["code"] == "member_not_found"
    assert remove.status_code == 404
    # The stranger's own organisation is untouched.
    assert await members(other_client) == {"other@example.com": "owner"}


# ------------------------------------------------------------------ invitations
async def test_an_invitation_token_is_shown_once_and_stored_only_as_a_hash(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)

    created = await invite(client, email="Dev@Example.com", role="viewer")

    assert created["email"] == "dev@example.com"
    assert created["role"] == "viewer"
    listed = (await client.get("/v1/orgs/current/invitations")).json()
    assert [item["id"] for item in listed] == [created["id"]]
    assert "token" not in listed[0]
    stored = (await session.scalars(select(Invitation))).one()
    assert created["token"] not in (stored.token_hash, stored.email)
    assert len(stored.token_hash) == 64
    assert "invitation.created" in await audit_actions(session)


async def test_anyone_with_the_link_can_see_what_the_invitation_is_for(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client, organization="Acme")
    created = await invite(client)

    response = await other_client.get(f"/v1/invitations/{created['token']}")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "organization_name": "Acme",
        "email": "dev@example.com",
        "role": "developer",
        "expires_at": created["expires_at"],
    }


async def test_signing_up_with_an_invitation_joins_that_organisation(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    owner = await register(client)
    created = await invite(client, role="viewer")

    joined = await join(other_client, created["token"])

    # One organisation only: no personal organisation was created on the side.
    assert joined["organizations"] == [
        {"id": owner["organizations"][0]["id"], "name": "Acme", "role": "viewer"}
    ]
    assert (await members(client))["dev@example.com"] == "viewer"
    assert (await client.get("/v1/orgs/current/invitations")).json() == []
    assert "invitation.accepted" in await audit_actions(session)


async def test_an_invitation_works_only_once(
    client: AsyncClient, other_client: AsyncClient, app: Any
) -> None:
    await register(client)
    token = (await invite(client))["token"]
    await join(other_client, token)

    assert (await other_client.get(f"/v1/invitations/{token}")).status_code == 404
    again = await other_client.post(f"/v1/invitations/{token}/accept")
    assert again.status_code == 404
    assert again.json()["code"] == "invitation_not_found"


async def test_an_existing_user_accepts_while_logged_in(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    owner = await register(client)
    await register(other_client, email="dev@example.com", organization="Side Project")
    token = (await invite(client))["token"]

    response = await other_client.post(f"/v1/invitations/{token}/accept")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "id": owner["organizations"][0]["id"],
        "name": "Acme",
        "role": "developer",
    }
    names = {org["name"] for org in (await other_client.get("/v1/orgs")).json()}
    assert names == {"Side Project", "Acme"}


async def test_accepting_needs_a_login(client: AsyncClient, other_client: AsyncClient) -> None:
    await register(client)
    token = (await invite(client))["token"]

    response = await other_client.post(f"/v1/invitations/{token}/accept")

    assert response.status_code == 401


async def test_an_invitation_only_works_for_the_address_it_was_sent_to(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    token = (await invite(client, email="dev@example.com"))["token"]

    signup = await other_client.post(
        "/v1/auth/register",
        json={"email": "thief@example.com", "password": PASSWORD, "invitation_token": token},
    )
    assert signup.status_code == 403
    assert signup.json()["code"] == "invitation_email_mismatch"

    await register(other_client, email="thief@example.com", organization="Thieves")
    accept = await other_client.post(f"/v1/invitations/{token}/accept")
    assert accept.status_code == 403
    assert accept.json()["code"] == "invitation_email_mismatch"

    assert await members(client) == {"owner@example.com": "owner"}
    # The link still works for the right person.
    assert (await other_client.get(f"/v1/invitations/{token}")).status_code == 200


async def test_signing_up_with_an_invitation_when_the_account_exists_says_to_log_in(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    await register(other_client, email="dev@example.com", organization="Side Project")
    await other_client.post("/v1/auth/logout")
    token = (await invite(client))["token"]

    response = await other_client.post(
        "/v1/auth/register",
        json={"email": "dev@example.com", "password": PASSWORD, "invitation_token": token},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "email_taken"
    # Nothing was used up: they can log in and accept.
    await login(other_client, "dev@example.com")
    assert (await other_client.post(f"/v1/invitations/{token}/accept")).status_code == 200


async def test_a_revoked_invitation_stops_working(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    created = await invite(client)

    response = await client.delete(f"/v1/orgs/current/invitations/{created['id']}")

    assert response.status_code == 204
    assert (await client.get("/v1/orgs/current/invitations")).json() == []
    assert (await other_client.get(f"/v1/invitations/{created['token']}")).status_code == 404
    signup = await other_client.post(
        "/v1/auth/register",
        json={
            "email": "dev@example.com",
            "password": PASSWORD,
            "invitation_token": created["token"],
        },
    )
    assert signup.status_code == 404
    assert "invitation.revoked" in await audit_actions(session)


async def test_an_expired_invitation_stops_working(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    created = await invite(client)
    await session.execute(
        update(Invitation).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
    )
    await session.commit()

    assert (await other_client.get(f"/v1/invitations/{created['token']}")).status_code == 404
    assert (await client.get("/v1/orgs/current/invitations")).json() == []


async def test_inviting_the_same_address_again_replaces_the_old_link(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    first = await invite(client, role="viewer")
    second = await invite(client, role="developer")

    assert (await other_client.get(f"/v1/invitations/{first['token']}")).status_code == 404
    assert (await other_client.get(f"/v1/invitations/{second['token']}")).status_code == 200
    listed = (await client.get("/v1/orgs/current/invitations")).json()
    assert [item["id"] for item in listed] == [second["id"]]


async def test_someone_already_in_the_team_cannot_be_invited(client: AsyncClient) -> None:
    await register(client)

    response = await client.post(
        "/v1/orgs/current/invitations", json={"email": "OWNER@example.com", "role": "viewer"}
    )

    assert response.status_code == 409
    assert response.json()["code"] == "already_member"


async def test_one_organisation_cannot_revoke_anothers_invitation(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    await register(other_client, email="other@example.com", organization="Other")
    created = await invite(client)

    response = await other_client.delete(f"/v1/orgs/current/invitations/{created['id']}")

    assert response.status_code == 404
    assert len((await client.get("/v1/orgs/current/invitations")).json()) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"email": "not-an-email", "role": "developer"},
        {"email": "dev@example.com", "role": "admin"},
        {"role": "developer"},
    ],
)
async def test_a_bad_invitation_is_refused(client: AsyncClient, body: dict[str, str]) -> None:
    await register(client)
    response = await client.post("/v1/orgs/current/invitations", json=body)
    assert response.status_code == 422


@pytest.mark.parametrize(
    "extra",
    [{}, {"organization_name": "Acme", "invitation_token": "abc"}],
)
async def test_sign_up_needs_an_organisation_or_an_invitation_not_both(
    client: AsyncClient, extra: dict[str, str]
) -> None:
    response = await client.post(
        "/v1/auth/register", json={"email": "a@example.com", "password": PASSWORD, **extra}
    )
    assert response.status_code == 422


async def test_an_unknown_invitation_link_is_404(client: AsyncClient) -> None:
    response = await client.get("/v1/invitations/no-such-token")
    assert response.status_code == 404
    assert response.json()["code"] == "invitation_not_found"


async def test_joining_twice_through_two_links_keeps_one_membership(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    """Accepting while already a member (added another way) does not fail or duplicate."""
    owner = await register(client)
    other = await register(other_client, email="dev@example.com", organization="Side")
    org_id = owner["organizations"][0]["id"]
    token = (await invite(client, role="viewer"))["token"]
    await add_member(session, user_id=other["user"]["id"], org_id=org_id, role="developer")

    response = await other_client.post(f"/v1/invitations/{token}/accept")

    assert response.status_code == 200, response.text
    rows = list(
        await session.scalars(select(Membership.role).where(Membership.org_id == uuid.UUID(org_id)))
    )
    assert sorted(rows) == ["developer", "owner"]
