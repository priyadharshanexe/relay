import base64
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core.config import DEV_ENCRYPTION_KEY
from relay.core.crypto import SecretBox
from relay.db.models import AuditLog, Delivery, EndpointSecret, Event
from relay.domain.signing import Signer, Verifier
from relay.main import create_app
from relay.services import endpoints as endpoint_service
from tests.conftest import make_settings
from tests.integration.helpers import add_member, create_endpoint, register

pytestmark = pytest.mark.integration

box = SecretBox(DEV_ENCRYPTION_KEY)
PRODUCTION_LIKE_KEY = base64.b64encode(b"p" * 32).decode()


# ----------------------------------------------------------------------- create
async def test_create_returns_the_endpoint_and_its_secret_once(client: AsyncClient) -> None:
    await register(client)

    created = await create_endpoint(
        client, description="Orders", event_types=["order.paid", "order.refunded"]
    )

    assert created["secret"].startswith("whsec_")
    assert created["status"] == "active"
    assert created["breaker_state"] == "closed"
    assert created["event_types"] == ["order.paid", "order.refunded"]
    fetched = (await client.get(f"/v1/endpoints/{created['id']}")).json()
    assert "secret" not in fetched
    assert created["secret"] not in str((await client.get("/v1/endpoints")).json())


async def test_the_secret_is_encrypted_at_rest_and_usable_for_signing(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    created = await create_endpoint(client)

    stored = await session.scalar(select(EndpointSecret.secret_encrypted))
    assert stored is not None
    assert created["secret"] not in stored
    assert stored.startswith("v1:")

    now = datetime.now(UTC)
    secrets = await endpoint_service.active_secrets(session, uuid.UUID(created["id"]), box, now=now)
    assert secrets == [created["secret"]]
    headers = Signer(secrets).sign("msg_1", now, b"{}").as_dict()
    Verifier(created["secret"]).verify(headers, b"{}", now=now)


async def test_duplicate_event_types_are_collapsed(client: AsyncClient) -> None:
    await register(client)

    created = await create_endpoint(client, event_types=["b.event", "a.event", "b.event"])

    assert created["event_types"] == ["a.event", "b.event"]


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/hook",
        "not a url",
        "https://user:pass@example.com/hook",
        "http://127.0.0.1/hook",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]:8080/hook",
        "http://[::ffff:10.0.0.1]/hook",
        "https://example.com:0/hook",
    ],
)
async def test_dangerous_or_malformed_urls_are_refused(client: AsyncClient, url: str) -> None:
    await register(client)

    response = await client.post("/v1/endpoints", json={"url": url})

    assert response.status_code == 422
    assert response.json()["code"] == "invalid_endpoint_url"
    assert (await client.get("/v1/endpoints")).json() == []


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"url": ""},
        {"url": "https://example.com/" + "a" * 2050},
        {"url": "https://example.com/h", "event_types": ["has spaces"]},
        {"url": "https://example.com/h", "event_types": ["x"] * 101},
        {"url": "https://example.com/h", "rate_limit_per_sec": 0},
        {"url": "https://example.com/h", "description": "d" * 501},
    ],
)
async def test_invalid_endpoint_fields_are_rejected(
    client: AsyncClient, payload: dict[str, object]
) -> None:
    await register(client)

    assert (await client.post("/v1/endpoints", json=payload)).status_code == 422


async def test_production_requires_https_endpoints() -> None:
    app = create_app(
        make_settings(
            environment="production",
            jwt_secret="x" * 40,
            encryption_key=PRODUCTION_LIKE_KEY,
        )
    )
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="https://test") as client,
    ):
        await register(client)
        plain = await client.post("/v1/endpoints", json={"url": "http://example.com/hook"})
        secure = await client.post("/v1/endpoints", json={"url": "https://example.com/hook"})

    assert plain.status_code == 422
    assert "https" in plain.json()["message"]
    assert secure.status_code == 201


def test_production_refuses_development_keys_and_private_networks() -> None:
    with pytest.raises(ValueError, match="RELAY_ENCRYPTION_KEY"):
        make_settings(environment="production", jwt_secret="x" * 40)
    with pytest.raises(ValueError, match="PRIVATE_NETWORKS"):
        make_settings(
            environment="production",
            jwt_secret="x" * 40,
            encryption_key=PRODUCTION_LIKE_KEY,
            endpoints_allow_private_networks=True,
        )


# ----------------------------------------------------------------------- update
async def test_patch_changes_only_the_fields_sent(client: AsyncClient) -> None:
    await register(client)
    created = await create_endpoint(
        client, description="before", event_types=["a.event"], rate_limit_per_sec=5
    )

    response = await client.patch(f"/v1/endpoints/{created['id']}", json={"description": "after"})

    updated = response.json()
    assert response.status_code == 200
    assert updated["description"] == "after"
    assert updated["url"] == created["url"]
    assert updated["event_types"] == ["a.event"]
    assert updated["rate_limit_per_sec"] == 5


async def test_patch_can_clear_the_rate_limit_with_null(client: AsyncClient) -> None:
    await register(client)
    created = await create_endpoint(client, rate_limit_per_sec=5)

    response = await client.patch(
        f"/v1/endpoints/{created['id']}", json={"rate_limit_per_sec": None}
    )

    assert response.json()["rate_limit_per_sec"] is None


async def test_patch_validates_the_new_url_and_rejects_unknown_fields(
    client: AsyncClient,
) -> None:
    await register(client)
    created = await create_endpoint(client)
    path = f"/v1/endpoints/{created['id']}"

    bad_url = await client.patch(path, json={"url": "http://10.0.0.1/hook"})
    unknown = await client.patch(path, json={"status": "disabled"})
    secret = await client.patch(path, json={"secret": "whsec_mine"})

    assert bad_url.status_code == 422
    assert bad_url.json()["code"] == "invalid_endpoint_url"
    assert unknown.status_code == 422  # status changes only through pause/resume
    assert secret.status_code == 422
    assert (await client.get(path)).json()["url"] == created["url"]


# ----------------------------------------------------------------- pause/resume
async def test_pause_and_resume(client: AsyncClient) -> None:
    await register(client)
    created = await create_endpoint(client)
    path = f"/v1/endpoints/{created['id']}"

    paused = await client.post(f"{path}/pause")
    paused_again = await client.post(f"{path}/pause")
    resumed = await client.post(f"{path}/resume")

    assert paused.json()["status"] == "paused"
    assert paused_again.status_code == 200
    assert resumed.json()["status"] == "active"


async def test_resume_resets_the_circuit_breaker(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    created = await create_endpoint(client)
    endpoint = await endpoint_service.get_endpoint(
        session,
        uuid.UUID((await client.get("/v1/auth/me")).json()["organizations"][0]["id"]),
        uuid.UUID(created["id"]),
    )
    endpoint.status = "disabled"
    endpoint.breaker_state = "open"
    endpoint.consecutive_failures = 9
    endpoint.breaker_opened_at = datetime.now(UTC)
    await session.commit()

    resumed = (await client.post(f"/v1/endpoints/{created['id']}/resume")).json()

    assert resumed["status"] == "active"
    assert resumed["breaker_state"] == "closed"
    await session.refresh(endpoint)
    assert endpoint.consecutive_failures == 0
    assert endpoint.breaker_opened_at is None


# --------------------------------------------------------------------- rotation
async def test_rotation_keeps_the_old_secret_valid_during_the_overlap(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    created = await create_endpoint(client)
    endpoint_id = uuid.UUID(created["id"])
    old_secret = created["secret"]

    response = await client.post(f"/v1/endpoints/{endpoint_id}/rotate-secret")

    rotated = response.json()
    new_secret = rotated["secret"]
    expires_at = datetime.fromisoformat(rotated["previous_secret_expires_at"])
    assert response.status_code == 200
    assert new_secret != old_secret
    assert timedelta(hours=23) < expires_at - datetime.now(UTC) <= timedelta(hours=24)

    # During the overlap: signed with both, so either secret verifies.
    now = datetime.now(UTC)
    during = await endpoint_service.active_secrets(session, endpoint_id, box, now=now)
    assert during == [new_secret, old_secret]
    headers = Signer(during).sign("msg_1", now, b"{}").as_dict()
    Verifier(old_secret).verify(headers, b"{}", now=now)
    Verifier(new_secret).verify(headers, b"{}", now=now)

    # After the overlap: only the new secret is used.
    after = await endpoint_service.active_secrets(
        session, endpoint_id, box, now=expires_at + timedelta(seconds=1)
    )
    assert after == [new_secret]


async def test_rotating_twice_never_extends_an_older_secret(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    created = await create_endpoint(client)
    path = f"/v1/endpoints/{created['id']}/rotate-secret"

    first = (await client.post(path)).json()
    second = (await client.post(path)).json()

    now = datetime.now(UTC)
    active = await endpoint_service.active_secrets(session, uuid.UUID(created["id"]), box, now=now)
    assert active[0] == second["secret"]
    assert set(active) == {second["secret"], first["secret"], created["secret"]}
    expiries = (
        await session.scalars(
            select(EndpointSecret.expires_at).where(EndpointSecret.expires_at.is_not(None))
        )
    ).all()
    first_expiry = datetime.fromisoformat(first["previous_secret_expires_at"])
    assert min(e for e in expiries if e is not None) == first_expiry  # not pushed later


# ------------------------------------------------------------------- test event
async def test_send_test_event_queues_one_delivery_for_that_endpoint_only(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    target = await create_endpoint(client, event_types=["order.paid"])  # not subscribed to tests
    await create_endpoint(client)  # subscribed to everything, must not get it

    response = await client.post(f"/v1/endpoints/{target['id']}/test")

    assert response.status_code == 202
    event = await session.scalar(select(Event))
    assert event is not None
    assert str(event.id) == response.json()["event_id"]
    assert event.type == "relay.test"
    deliveries = (await session.scalars(select(Delivery))).all()
    assert [str(d.endpoint_id) for d in deliveries] == [target["id"]]
    assert deliveries[0].status == "pending"


# ----------------------------------------------------------------------- delete
async def test_delete_removes_the_endpoint_and_its_secrets(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    created = await create_endpoint(client)

    response = await client.delete(f"/v1/endpoints/{created['id']}")

    assert response.status_code == 204
    assert (await client.get(f"/v1/endpoints/{created['id']}")).status_code == 404
    assert (await session.scalars(select(EndpointSecret))).all() == []


async def test_changes_are_audited_without_recording_secrets(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    created = await create_endpoint(client)
    path = f"/v1/endpoints/{created['id']}"
    await client.patch(path, json={"description": "x"})
    await client.post(f"{path}/pause")
    await client.post(f"{path}/resume")
    rotated = (await client.post(f"{path}/rotate-secret")).json()
    await client.delete(path)

    rows = (
        await session.execute(
            select(AuditLog.action, AuditLog.details)
            .where(AuditLog.target_type == "endpoint")
            .order_by(AuditLog.at)
        )
    ).all()

    assert [action for action, _ in rows] == [
        "endpoint.created",
        "endpoint.updated",
        "endpoint.paused",
        "endpoint.resumed",
        "endpoint.secret_rotated",
        "endpoint.deleted",
    ]
    recorded = str([details for _, details in rows])
    assert created["secret"] not in recorded
    assert rotated["secret"] not in recorded


# ------------------------------------------------------------- roles and tenancy
ENDPOINT_WRITES = [
    ("patch", "", {"description": "x"}),
    ("delete", "", None),
    ("post", "/pause", None),
    ("post", "/resume", None),
    ("post", "/rotate-secret", None),
    ("post", "/test", None),
]


async def test_viewers_can_read_but_not_change_endpoints(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    owner = await register(client, "owner@example.com", "Acme")
    acme = {"X-Org-ID": owner["organizations"][0]["id"]}
    created = await create_endpoint(client)
    viewer = await register(other_client, "viewer@example.com", "Own Org")
    await add_member(session, user_id=viewer["user"]["id"], org_id=acme["X-Org-ID"], role="viewer")
    path = f"/v1/endpoints/{created['id']}"

    assert (await other_client.get("/v1/endpoints", headers=acme)).status_code == 200
    assert (await other_client.get(path, headers=acme)).status_code == 200
    create = await other_client.post(
        "/v1/endpoints", json={"url": "https://example.com/h"}, headers=acme
    )
    assert create.status_code == 403
    for method, suffix, body in ENDPOINT_WRITES:
        response = await other_client.request(method, path + suffix, json=body, headers=acme)
        assert response.status_code == 403, f"{method} {suffix}"


async def test_another_organisation_cannot_touch_an_endpoint_by_id(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client, "a@example.com", "Org A")
    created = await create_endpoint(client)
    await register(other_client, "b@example.com", "Org B")
    path = f"/v1/endpoints/{created['id']}"

    assert (await other_client.get("/v1/endpoints")).json() == []
    assert (await other_client.get(path)).status_code == 404
    for method, suffix, body in ENDPOINT_WRITES:
        response = await other_client.request(method, path + suffix, json=body)
        assert response.status_code == 404, f"{method} {suffix}"
        assert response.json()["code"] == "endpoint_not_found"

    untouched = (await client.get(path)).json()
    assert untouched["status"] == "active"
    assert untouched["description"] == ""


async def test_endpoint_routes_require_a_session(client: AsyncClient) -> None:
    path = f"/v1/endpoints/{uuid.uuid4()}"

    assert (await client.get("/v1/endpoints")).status_code == 401
    assert (await client.post("/v1/endpoints", json={"url": "https://e.com"})).status_code == 401
    assert (await client.get(path)).status_code == 401
    for method, suffix, body in ENDPOINT_WRITES:
        assert (await client.request(method, path + suffix, json=body)).status_code == 401
