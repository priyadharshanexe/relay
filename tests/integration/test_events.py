import asyncio
import uuid
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from relay.db.models import Delivery, Event
from relay.main import create_app
from relay.services import events as event_service
from tests.conftest import make_settings
from tests.integration.helpers import bearer, create_api_key, create_endpoint, register

pytestmark = pytest.mark.integration

ORDER_PAID = {"type": "order.paid", "payload": {"order_id": 42, "amount": 1999}}


async def send(
    client: AsyncClient,
    key: str,
    body: dict[str, Any] | None = None,
    *,
    idempotency_key: str | None = None,
) -> Any:
    headers = bearer(key)
    if idempotency_key is not None:
        headers["Idempotency-Key"] = idempotency_key
    return await client.post("/v1/events", json=body or ORDER_PAID, headers=headers)


async def count(session: AsyncSession, model: type[Event] | type[Delivery]) -> int:
    return int(await session.scalar(select(func.count()).select_from(model)) or 0)


# ----------------------------------------------------------------------- outbox
async def test_an_event_gets_exactly_one_delivery_per_subscribed_endpoint(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    matching = [
        await create_endpoint(client, event_types=["order.paid"]),
        await create_endpoint(client, event_types=["order.paid", "order.refunded"]),
        await create_endpoint(client),  # no filter: subscribed to everything
    ]
    await create_endpoint(client, event_types=["user.created"])  # different type

    response = await send(other_client, key)

    body = response.json()
    assert response.status_code == 201
    assert body["type"] == "order.paid"
    assert body["deliveries"] == 3
    deliveries = (await session.scalars(select(Delivery))).all()
    assert sorted(str(d.endpoint_id) for d in deliveries) == sorted(e["id"] for e in matching)
    assert {str(d.event_id) for d in deliveries} == {body["id"]}
    assert {d.status for d in deliveries} == {"pending"}
    assert {d.attempts for d in deliveries} == {0}
    stored = await session.scalar(select(Event))
    assert stored is not None
    assert stored.payload == ORDER_PAID["payload"]


async def test_an_event_nobody_subscribes_to_is_still_stored(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)

    response = await send(other_client, key)

    assert response.status_code == 201
    assert response.json()["deliveries"] == 0
    assert await count(session, Event) == 1


async def test_paused_endpoints_still_queue_but_disabled_ones_do_not(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    paused = await create_endpoint(client)
    await client.post(f"/v1/endpoints/{paused['id']}/pause")
    disabled = await create_endpoint(client)
    await session.execute(
        # there is no API to disable: the system does it
        text("UPDATE endpoints SET status = 'disabled' WHERE id = :id"),
        {"id": disabled["id"]},
    )
    await session.commit()

    response = await send(other_client, key)

    assert response.json()["deliveries"] == 1
    assert str(await session.scalar(select(Delivery.endpoint_id))) == paused["id"]


async def test_events_only_reach_the_senders_own_organisation(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client, "a@example.com", "Org A")
    key_a = await create_api_key(client)
    await create_endpoint(client)
    await register(other_client, "b@example.com", "Org B")
    endpoint_b = await create_endpoint(other_client)

    response = await send(client, key_a)

    assert response.json()["deliveries"] == 1
    endpoint_ids = [str(i) for i in (await session.scalars(select(Delivery.endpoint_id))).all()]
    assert endpoint_b["id"] not in endpoint_ids


async def test_outbox_is_atomic_if_queuing_fails_the_event_is_not_stored(
    client: AsyncClient, session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Simulate a crash between "insert event" and "insert deliveries"."""
    body = await register(client)
    await create_endpoint(client)

    def explode(*args: object, **kwargs: object) -> None:
        raise RuntimeError("crash while queuing deliveries")

    monkeypatch.setattr(event_service, "insert", explode)
    with pytest.raises(RuntimeError, match="crash"):
        await event_service.create_event(
            session,
            org_id=uuid.UUID(body["organizations"][0]["id"]),
            event_type="order.paid",
            payload={},
            idempotency_key=None,
        )
    await session.rollback()

    assert await count(session, Event) == 0
    assert await count(session, Delivery) == 0


# ------------------------------------------------------------------ idempotency
async def test_repeating_an_idempotency_key_returns_the_original_event(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client)

    first = await send(other_client, key, idempotency_key="order-42-paid")
    second = await send(other_client, key, idempotency_key="order-42-paid")

    assert first.status_code == 201
    assert second.status_code == 200
    assert second.headers["Idempotent-Replayed"] == "true"
    assert "Idempotent-Replayed" not in first.headers
    assert second.json() == first.json()
    assert await count(session, Event) == 1
    assert await count(session, Delivery) == 1


async def test_ten_simultaneous_requests_with_one_key_store_one_event(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    for _ in range(3):
        await create_endpoint(client)

    responses = await asyncio.gather(
        *(send(other_client, key, idempotency_key="race") for _ in range(10))
    )

    statuses = sorted(r.status_code for r in responses)
    assert statuses == [200] * 9 + [201]
    assert len({r.json()["id"] for r in responses}) == 1
    assert await count(session, Event) == 1
    assert await count(session, Delivery) == 3  # not 30


async def test_a_key_reused_for_a_different_event_is_a_conflict(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    first = await send(other_client, key, idempotency_key="k1")

    different_payload = await send(
        other_client,
        key,
        {"type": "order.paid", "payload": {"order_id": 43}},
        idempotency_key="k1",
    )
    different_type = await send(
        other_client,
        key,
        {"type": "order.refunded", "payload": ORDER_PAID["payload"]},
        idempotency_key="k1",
    )

    for response in (different_payload, different_type):
        assert response.status_code == 409
        assert response.json()["code"] == "idempotency_key_reused"
        assert response.json()["details"] == {"event_id": first.json()["id"]}
    assert await count(session, Event) == 1


async def test_the_same_key_in_two_organisations_does_not_collide(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client, "a@example.com", "Org A")
    key_a = await create_api_key(client)
    await register(other_client, "b@example.com", "Org B")
    key_b = await create_api_key(other_client)

    first = await send(client, key_a, idempotency_key="shared")
    second = await send(client, key_b, idempotency_key="shared")

    assert first.status_code == second.status_code == 201
    assert first.json()["id"] != second.json()["id"]


async def test_without_a_key_every_request_is_a_new_event(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)

    await send(other_client, key)
    await send(other_client, key)

    assert await count(session, Event) == 2


@pytest.mark.parametrize("bad_key", ["", "has space", "k" * 256, "café"])
async def test_malformed_idempotency_keys_are_rejected(
    client: AsyncClient, other_client: AsyncClient, bad_key: str
) -> None:
    await register(client)
    key = await create_api_key(client)

    response = await other_client.post(
        "/v1/events",
        json=ORDER_PAID,
        headers=[
            (b"authorization", f"Bearer {key}".encode()),
            (b"idempotency-key", bad_key.encode()),
        ],
    )

    assert response.status_code == 422


# ------------------------------------------------------------------- validation
@pytest.mark.parametrize(
    "body",
    [
        {},
        {"type": "order.paid"},
        {"payload": {}},
        {"type": "", "payload": {}},
        {"type": "has spaces", "payload": {}},
        {"type": "x" * 201, "payload": {}},
        {"type": "order.paid", "payload": [1, 2, 3]},
        {"type": "order.paid", "payload": "text"},
        {"type": "order.paid", "payload": {}, "extra": 1},
    ],
)
async def test_invalid_events_are_rejected_and_not_stored(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession, body: dict[str, Any]
) -> None:
    await register(client)
    key = await create_api_key(client)

    response = await other_client.post("/v1/events", json=body, headers=bearer(key))

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert await count(session, Event) == 0


async def test_a_body_that_is_not_json_is_rejected(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    key = await create_api_key(client)

    response = await other_client.post("/v1/events", content=b"{not json", headers=bearer(key))

    assert response.status_code == 422
    assert response.json()["details"][0]["type"] == "json_invalid"


async def test_oversized_events_get_413() -> None:
    app = create_app(make_settings(max_event_bytes=2048))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        await register(client)
        key = await create_api_key(client)
        headers = bearer(key)
        small = {"type": "order.paid", "payload": {"note": "x" * 1000}}
        large = {"type": "order.paid", "payload": {"note": "x" * 3000}}

        accepted = await client.post("/v1/events", json=small, headers=headers)
        declared = await client.post("/v1/events", json=large, headers=headers)

        async def chunks() -> Any:  # no Content-Length: the size is only known by reading
            for _ in range(30):
                yield b"x" * 100

        streamed = await client.post("/v1/events", content=chunks(), headers=headers)

    assert accepted.status_code == 201
    assert declared.status_code == 413
    assert declared.json()["code"] == "payload_too_large"
    assert declared.json()["details"] == {"limit": 2048}
    assert streamed.status_code == 413


# ---------------------------------------------------------------- authentication
async def test_ingestion_needs_an_api_key_not_a_dashboard_session(client: AsyncClient) -> None:
    await register(client)  # logged in with cookies

    with_session_only = await client.post("/v1/events", json=ORDER_PAID)
    with_bad_key = await client.post("/v1/events", json=ORDER_PAID, headers=bearer("rly_test_nope"))

    assert with_session_only.status_code == 401
    assert with_bad_key.status_code == 401
    assert with_bad_key.json()["code"] == "invalid_api_key"


async def test_a_revoked_key_can_no_longer_send(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    created = (await client.post("/v1/api-keys", json={"name": "old"})).json()
    await client.delete(f"/v1/api-keys/{created['id']}")

    response = await send(other_client, created["key"])

    assert response.status_code == 401
    assert await count(session, Event) == 0


# --------------------------------------------------------------------- browsing
async def test_events_are_listed_newest_first_with_cursor_pagination(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    key = await create_api_key(client)
    sent = [
        (await send(other_client, key, {"type": "n.event", "payload": {"n": n}})).json()["id"]
        for n in range(7)
    ]

    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params: dict[str, str | int] = {"limit": 3}
        if cursor:
            params["cursor"] = cursor
        page = (await client.get("/v1/events", params=params)).json()
        seen += [item["id"] for item in page["items"]]
        pages += 1
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert pages == 3
    assert seen == list(reversed(sent))  # every event once, newest first


async def test_events_can_be_filtered_by_type(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    key = await create_api_key(client)
    await send(other_client, key, {"type": "order.paid", "payload": {}})
    await send(other_client, key, {"type": "user.created", "payload": {}})

    page = (await client.get("/v1/events", params={"type": "user.created"})).json()

    assert [item["type"] for item in page["items"]] == ["user.created"]
    assert page["next_cursor"] is None


@pytest.mark.parametrize("cursor", ["garbage", "!!!", "bm90LWEtY3Vyc29y"])
async def test_a_bad_cursor_is_a_400(client: AsyncClient, cursor: str) -> None:
    await register(client)

    response = await client.get("/v1/events", params={"cursor": cursor})

    assert response.status_code == 400
    assert response.json()["code"] == "invalid_cursor"


@pytest.mark.parametrize("limit", [0, 201, -1])
async def test_page_size_is_bounded(client: AsyncClient, limit: int) -> None:
    await register(client)

    assert (await client.get("/v1/events", params={"limit": limit})).status_code == 422


async def test_one_organisation_cannot_read_anothers_events(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client, "a@example.com", "Org A")
    key_a = await create_api_key(client)
    event_id = (await send(client, key_a)).json()["id"]
    await register(other_client, "b@example.com", "Org B")

    own = await client.get(f"/v1/events/{event_id}")
    listed_by_b = await other_client.get("/v1/events")
    fetched_by_b = await other_client.get(f"/v1/events/{event_id}")

    assert own.status_code == 200
    assert own.json()["payload"] == ORDER_PAID["payload"]
    assert listed_by_b.json() == {"items": [], "next_cursor": None}
    assert fetched_by_b.status_code == 404
    assert fetched_by_b.json()["code"] == "event_not_found"


async def test_browsing_events_requires_a_session(client: AsyncClient) -> None:
    assert (await client.get("/v1/events")).status_code == 401
    assert (await client.get(f"/v1/events/{uuid.uuid4()}")).status_code == 401
