"""Regression tests for bugs found by exploratory testing of the running app."""

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from relay.db.models import ApiKey, Event, Organization, User
from tests.integration.helpers import PASSWORD, bearer, create_api_key, create_endpoint, register

pytestmark = pytest.mark.integration


# ---------------------------------------------------- names made only of spaces
@pytest.mark.parametrize("name", ["   ", "\t", " \n "])
async def test_an_organisation_name_of_only_spaces_is_rejected(
    client: AsyncClient, session: AsyncSession, name: str
) -> None:
    response = await client.post(
        "/v1/auth/register",
        json={"email": "a@example.com", "password": PASSWORD, "organization_name": name},
    )

    assert response.status_code == 422
    assert response.json()["details"][0]["loc"] == ["body", "organization_name"]
    assert await session.scalar(select(func.count()).select_from(User)) == 0
    assert await session.scalar(select(func.count()).select_from(Organization)) == 0


async def test_organisation_names_are_stored_trimmed(
    client: AsyncClient, session: AsyncSession
) -> None:
    body = await register(client, organization="  Acme Inc  ")

    assert body["organizations"][0]["name"] == "Acme Inc"


@pytest.mark.parametrize("name", ["   ", "\t\t"])
async def test_an_api_key_name_of_only_spaces_is_rejected(
    client: AsyncClient, session: AsyncSession, name: str
) -> None:
    await register(client)

    response = await client.post("/v1/api-keys", json={"name": name})

    assert response.status_code == 422
    assert await session.scalar(select(func.count()).select_from(ApiKey)) == 0


# ------------------------------------------- payloads the database cannot store
@pytest.mark.parametrize(
    ("raw_body", "error_type"),
    [
        (b'{"type":"order.paid","payload":{"x":"a\\u0000b"}}', "payload_nul_character"),
        (
            b'{"type":"order.paid","payload":{"deep":{"list":["ok","\\u0000"]}}}',
            "payload_nul_character",
        ),
        (b'{"type":"order.paid","payload":{"\\u0000key":1}}', "payload_nul_character"),
        (b'{"type":"order.paid","payload":{"n":1e999}}', "payload_not_finite"),
        (b'{"type":"order.paid","payload":{"n":-1e999}}', "payload_not_finite"),
    ],
)
async def test_unstorable_payloads_are_a_422_not_a_500(
    client: AsyncClient, session: AsyncSession, raw_body: bytes, error_type: str
) -> None:
    await register(client)
    key = await create_api_key(client)

    response = await client.post(
        "/v1/events", content=raw_body, headers=bearer(key) | {"Content-Type": "application/json"}
    )

    assert response.status_code == 422, response.text
    assert response.json()["details"][0]["type"] == error_type
    assert response.json()["details"][0]["loc"] == ["body", "payload"]
    assert await session.scalar(select(func.count()).select_from(Event)) == 0


async def test_ordinary_unicode_and_large_numbers_are_still_accepted(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    payload = {
        "name": "Priya \u0baa\u0bbf\u0bb0\u0bbf\u0baf\u0bbe \U0001f600",
        "big": 12345678901234567890,
        "price": 1999.99,
        "zero": "0",
    }

    response = await client.post(
        "/v1/events", json={"type": "order.paid", "payload": payload}, headers=bearer(key)
    )

    assert response.status_code == 201
    assert await session.scalar(select(Event.payload)) == payload


# ------------------------------------------------------ why a delivery is waiting
async def test_delivery_detail_says_when_its_endpoint_is_paused_or_failing(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    endpoint = await create_endpoint(client)
    await client.post("/v1/events", json={"type": "order.paid", "payload": {}}, headers=bearer(key))
    delivery_id = (await client.get("/v1/deliveries")).json()["items"][0]["id"]

    healthy = (await client.get(f"/v1/deliveries/{delivery_id}")).json()
    assert (healthy["endpoint_status"], healthy["endpoint_breaker_state"]) == ("active", "closed")

    await client.post(f"/v1/endpoints/{endpoint['id']}/pause")
    await session.execute(text("UPDATE endpoints SET breaker_state = 'open'"))
    await session.commit()

    held = (await client.get(f"/v1/deliveries/{delivery_id}")).json()
    assert (held["endpoint_status"], held["endpoint_breaker_state"]) == ("paused", "open")


# ------------------------------------------------------------------ health checks
@pytest.mark.parametrize("path", ["/healthz", "/readyz"])
async def test_health_checks_answer_head_requests(client: AsyncClient, path: str) -> None:
    """Some load balancers probe with HEAD rather than GET."""
    response = await client.head(path)

    assert response.status_code == 200
    assert response.content == b""
