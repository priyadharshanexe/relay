import time
import uuid
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from relay.db.models import TestReceiver
from relay.main import create_app
from tests.conftest import make_settings
from tests.integration.helpers import add_member, register

pytestmark = pytest.mark.integration


async def create_receiver(client: AsyncClient, **fields: Any) -> dict[str, Any]:
    response = await client.post("/v1/receivers", json={"name": "demo", **fields})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def path_of(receiver: dict[str, Any]) -> str:
    return "/receiver/" + str(receiver["url"]).rsplit("/receiver/", 1)[1]


# ------------------------------------------------------------------- management
async def test_a_new_receiver_has_a_url_and_answers_200_by_default(client: AsyncClient) -> None:
    await register(client)

    receiver = await create_receiver(client)

    assert receiver["url"].startswith("http://localhost:8000/receiver/")
    assert len(receiver["url"].rsplit("/", 1)[1]) >= 30  # unguessable token
    assert receiver["mode"] == "ok"
    assert receiver["requests_received"] == 0
    assert receiver["last_received_at"] is None
    response = await client.post(path_of(receiver), json={"hello": "world"})
    assert response.status_code == 200
    assert response.json() == {"received": True, "mode": "ok"}


async def test_every_receiver_gets_its_own_token(client: AsyncClient) -> None:
    await register(client)

    urls = {(await create_receiver(client))["url"] for _ in range(5)}

    assert len(urls) == 5


async def test_requests_are_counted(client: AsyncClient) -> None:
    await register(client)
    receiver = await create_receiver(client)

    for _ in range(3):
        await client.post(path_of(receiver), content=b"anything at all")

    (listed,) = (await client.get("/v1/receivers")).json()
    assert listed["requests_received"] == 3
    assert listed["last_received_at"] is not None


async def test_update_changes_only_what_is_sent_and_delete_removes_it(client: AsyncClient) -> None:
    await register(client)
    receiver = await create_receiver(client, mode="error", status_code=503)

    updated = await client.patch(f"/v1/receivers/{receiver['id']}", json={"mode": "ok"})

    assert updated.json()["mode"] == "ok"
    assert updated.json()["status_code"] == 503
    assert updated.json()["url"] == receiver["url"]  # the URL never changes
    assert (await client.delete(f"/v1/receivers/{receiver['id']}")).status_code == 204
    assert (await client.post(path_of(receiver))).status_code == 404


@pytest.mark.parametrize(
    "fields",
    [
        {"name": ""},
        {"mode": "explode"},
        {"status_code": 200},  # an "error" receiver must answer with an error
        {"status_code": 600},
        {"delay_ms": -1},
        {"delay_ms": 30_001},
        {"retry_after_seconds": -5},
    ],
)
async def test_invalid_settings_are_rejected(client: AsyncClient, fields: dict[str, Any]) -> None:
    await register(client)

    assert (await client.post("/v1/receivers", json={"name": "x", **fields})).status_code == 422


# -------------------------------------------------------------------- behaviour
async def test_error_mode_answers_with_the_configured_status(client: AsyncClient) -> None:
    await register(client)
    default = await create_receiver(client, mode="error")
    custom = await create_receiver(client, mode="error", status_code=503)

    assert (await client.post(path_of(default))).status_code == 500
    assert (await client.post(path_of(custom))).status_code == 503


async def test_rate_limit_mode_answers_429_with_retry_after(client: AsyncClient) -> None:
    await register(client)
    receiver = await create_receiver(client, mode="rate_limit", retry_after_seconds=120)

    response = await client.post(path_of(receiver))

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "120"


async def test_slow_mode_waits_before_answering(client: AsyncClient) -> None:
    await register(client)
    receiver = await create_receiver(client, mode="slow", delay_ms=300)

    started = time.perf_counter()
    response = await client.post(path_of(receiver))
    elapsed = time.perf_counter() - started

    assert response.status_code == 200
    assert elapsed >= 0.3


async def test_timeout_mode_holds_the_connection_past_the_delivery_timeout() -> None:
    app = create_app(make_settings(receiver_hold_seconds=0.4))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        await register(client)
        receiver = await create_receiver(client, mode="timeout")

        started = time.perf_counter()
        await client.post(path_of(receiver))
        elapsed = time.perf_counter() - started

    assert elapsed >= 0.4


def test_by_default_a_timeout_receiver_outlasts_the_sender() -> None:
    settings = make_settings()

    assert settings.receiver_hold > settings.delivery_total_timeout_seconds


async def test_switching_mode_takes_effect_on_the_next_request(client: AsyncClient) -> None:
    """The demo flow: fail on purpose, then "fix the server"."""
    await register(client)
    receiver = await create_receiver(client, mode="error")
    assert (await client.post(path_of(receiver))).status_code == 500

    await client.patch(f"/v1/receivers/{receiver['id']}", json={"mode": "ok"})

    assert (await client.post(path_of(receiver))).status_code == 200


async def test_an_unknown_token_is_a_404_and_other_methods_are_refused(client: AsyncClient) -> None:
    await register(client)
    receiver = await create_receiver(client)

    assert (await client.post("/receiver/not-a-real-token")).status_code == 404
    assert (await client.get(path_of(receiver))).status_code == 405


async def test_posting_to_a_receiver_needs_no_login(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    receiver = await create_receiver(client)

    assert (await other_client.post(path_of(receiver))).status_code == 200


# ------------------------------------------------------------- roles and tenancy
async def test_viewers_can_list_but_not_change_receivers(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    owner = await register(client, "owner@example.com", "Acme")
    acme = {"X-Org-ID": owner["organizations"][0]["id"]}
    receiver = await create_receiver(client)
    viewer = await register(other_client, "viewer@example.com", "Own Org")
    await add_member(session, user_id=viewer["user"]["id"], org_id=acme["X-Org-ID"], role="viewer")
    path = f"/v1/receivers/{receiver['id']}"

    assert (await other_client.get("/v1/receivers", headers=acme)).status_code == 200
    create = await other_client.post("/v1/receivers", json={"name": "x"}, headers=acme)
    patch = await other_client.patch(path, json={"mode": "error"}, headers=acme)
    delete = await other_client.delete(path, headers=acme)
    assert create.status_code == patch.status_code == delete.status_code == 403


async def test_another_organisation_cannot_see_or_change_a_receiver(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client, "a@example.com", "Org A")
    receiver = await create_receiver(client)
    await register(other_client, "b@example.com", "Org B")
    path = f"/v1/receivers/{receiver['id']}"

    assert (await other_client.get("/v1/receivers")).json() == []
    assert (await other_client.patch(path, json={"mode": "error"})).status_code == 404
    assert (await other_client.delete(path)).status_code == 404
    assert await session.scalar(select(TestReceiver.mode)) == "ok"


async def test_receiver_management_requires_a_session(client: AsyncClient) -> None:
    path = f"/v1/receivers/{uuid.uuid4()}"

    assert (await client.get("/v1/receivers")).status_code == 401
    assert (await client.post("/v1/receivers", json={"name": "x"})).status_code == 401
    assert (await client.patch(path, json={"mode": "ok"})).status_code == 401
    assert (await client.delete(path)).status_code == 401


# ----------------------------------------------------- endpoints and demo mode
async def test_a_receiver_url_is_always_accepted_as_an_endpoint(client: AsyncClient) -> None:
    await register(client)
    receiver = await create_receiver(client)

    # http and localhost: refused for any other URL under the default settings.
    response = await client.post("/v1/endpoints", json={"url": receiver["url"]})

    assert response.status_code == 201
    assert response.json()["url"] == receiver["url"]


async def test_demo_mode_only_accepts_receiver_urls_as_endpoints() -> None:
    app = create_app(make_settings(delivery_only_to_receiver=True))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        await register(client)
        receiver = await create_receiver(client)

        builtin = await client.post("/v1/endpoints", json={"url": receiver["url"]})
        external = await client.post("/v1/endpoints", json={"url": "https://example.com/hook"})
        lookalike = await client.post(
            "/v1/endpoints", json={"url": "http://localhost:8000.evil.example/receiver/x"}
        )

    assert builtin.status_code == 201
    assert external.status_code == 422
    assert "demo" in external.json()["message"]
    assert lookalike.status_code == 422
