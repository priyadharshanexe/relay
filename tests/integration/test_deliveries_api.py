import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from relay.db.models import Attempt, AuditLog, Delivery
from tests.integration.helpers import (
    add_member,
    bearer,
    create_api_key,
    create_endpoint,
    register,
)

pytestmark = pytest.mark.integration


async def emit(client: AsyncClient, key: str, event_type: str = "order.paid") -> str:
    response = await client.post(
        "/v1/events", json={"type": event_type, "payload": {"n": 1}}, headers=bearer(key)
    )
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


async def set_status(
    session: AsyncSession, status: str, where: str = "true", **params: Any
) -> None:
    await session.execute(
        text(
            "UPDATE deliveries SET status = :status, attempts = 7, "  # noqa: S608 - test-only SQL
            f"last_error = 'http_status: boom' WHERE {where}"
        ),
        {"status": status, **params},
    )
    await session.commit()


async def listed(client: AsyncClient, **params: Any) -> list[dict[str, Any]]:
    response = await client.get("/v1/deliveries", params=params)
    assert response.status_code == 200, response.text
    items: list[dict[str, Any]] = response.json()["items"]
    return items


# ---------------------------------------------------------------------- listing
async def test_deliveries_show_their_event_type_and_endpoint(client: AsyncClient) -> None:
    await register(client)
    key = await create_api_key(client)
    endpoint = await create_endpoint(client, url="https://hooks.example.com/orders")
    event_id = await emit(client, key)

    (item,) = await listed(client)

    assert item["event_id"] == event_id
    assert item["event_type"] == "order.paid"
    assert item["endpoint_id"] == endpoint["id"]
    assert item["endpoint_url"] == "https://hooks.example.com/orders"
    assert item["status"] == "pending"
    assert item["attempts"] == 0
    assert item["last_error"] is None


async def test_filters_narrow_the_list(client: AsyncClient, session: AsyncSession) -> None:
    await register(client)
    key = await create_api_key(client)
    orders = await create_endpoint(
        client, url="https://a.example.com/h", event_types=["order.paid"]
    )
    users = await create_endpoint(
        client, url="https://b.example.com/h", event_types=["user.created"]
    )
    await emit(client, key, "order.paid")
    await emit(client, key, "order.paid")
    await emit(client, key, "user.created")
    await set_status(session, "dead", "endpoint_id = :id", id=users["id"])

    assert len(await listed(client)) == 3
    assert [d["endpoint_id"] for d in await listed(client, status="dead")] == [users["id"]]
    assert len(await listed(client, status="pending")) == 2
    assert len(await listed(client, endpoint_id=orders["id"])) == 2
    assert len(await listed(client, event_type="user.created")) == 1
    assert len(await listed(client, event_type="order.paid", status="dead")) == 0
    assert await listed(client, event_type="nothing.like.this") == []


async def test_time_range_filter(client: AsyncClient, session: AsyncSession) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client)
    await emit(client, key)
    await session.execute(text("UPDATE deliveries SET created_at = now() - interval '2 days'"))
    await session.commit()
    await emit(client, key)
    yesterday = (datetime.now(UTC) - timedelta(days=1)).isoformat()

    recent = await client.get("/v1/deliveries", params={"from": yesterday})
    older = await client.get("/v1/deliveries", params={"to": yesterday})

    assert len(recent.json()["items"]) == 1
    assert len(older.json()["items"]) == 1
    assert recent.json()["items"][0]["id"] != older.json()["items"][0]["id"]


async def test_pagination_returns_every_delivery_once_newest_first(client: AsyncClient) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client)
    events = [await emit(client, key) for _ in range(5)]

    seen: list[str] = []
    cursor = None
    while True:
        params: dict[str, Any] = {"limit": 2} | ({"cursor": cursor} if cursor else {})
        page = (await client.get("/v1/deliveries", params=params)).json()
        seen += [item["event_id"] for item in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert seen == list(reversed(events))


@pytest.mark.parametrize(
    "params",
    [{"status": "lost"}, {"endpoint_id": "nope"}, {"limit": 0}, {"from": "yesterday"}],
)
async def test_invalid_filters_are_rejected(client: AsyncClient, params: dict[str, str]) -> None:
    await register(client)

    assert (await client.get("/v1/deliveries", params=params)).status_code == 422


# ----------------------------------------------------------------------- detail
async def test_detail_includes_the_payload_and_the_attempt_log(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client)
    await emit(client, key)
    delivery_id = await session.scalar(select(Delivery.id))
    session.add_all(
        [
            Attempt(
                delivery_id=delivery_id,
                attempt_number=1,
                duration_ms=120,
                status_code=500,
                error_kind="http_status",
                response_snippet="boom",
                request_headers={"webhook-id": "x", "webhook-signature": "v1,abcd****"},
                response_headers={"content-type": "text/plain"},
            ),
            Attempt(
                delivery_id=delivery_id,
                attempt_number=2,
                duration_ms=35,
                status_code=200,
                request_headers={},
            ),
        ]
    )
    await session.commit()

    detail = (await client.get(f"/v1/deliveries/{delivery_id}")).json()

    assert detail["payload"] == {"n": 1}
    assert [a["attempt_number"] for a in detail["attempt_log"]] == [1, 2]
    first = detail["attempt_log"][0]
    assert first["status_code"] == 500
    assert first["error_kind"] == "http_status"
    assert first["duration_ms"] == 120
    assert first["response_snippet"] == "boom"
    assert first["request_headers"]["webhook-signature"] == "v1,abcd****"
    assert detail["attempt_log"][1]["error_kind"] is None


# ----------------------------------------------------------------------- replay
async def test_replaying_a_dead_delivery_requeues_it_with_a_fresh_schedule(
    client: AsyncClient, session: AsyncSession
) -> None:
    body = await register(client)
    key = await create_api_key(client)
    await create_endpoint(client)
    await emit(client, key)
    await set_status(session, "dead")
    delivery_id = await session.scalar(select(Delivery.id))

    response = await client.post(f"/v1/deliveries/{delivery_id}/replay")

    replayed = response.json()
    assert response.status_code == 200
    assert replayed["status"] == "pending"
    assert replayed["attempts"] == 0
    assert replayed["last_error"] is None
    assert datetime.fromisoformat(replayed["next_attempt_at"]) <= datetime.now(UTC)
    audit = (
        await session.execute(
            select(AuditLog.target_id, AuditLog.actor_user_id).where(
                AuditLog.action == "delivery.replayed"
            )
        )
    ).one()
    assert audit.target_id == str(delivery_id)
    assert str(audit.actor_user_id) == body["user"]["id"]


async def test_a_succeeded_delivery_can_be_replayed_too(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client)
    await emit(client, key)
    await set_status(session, "succeeded")
    delivery_id = await session.scalar(select(Delivery.id))

    response = await client.post(f"/v1/deliveries/{delivery_id}/replay")

    assert response.json()["status"] == "pending"


@pytest.mark.parametrize("status", ["pending", "retrying", "in_flight"])
async def test_a_delivery_still_on_its_way_cannot_be_replayed(
    client: AsyncClient, session: AsyncSession, status: str
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client)
    await emit(client, key)
    await set_status(session, status)
    delivery_id = await session.scalar(select(Delivery.id))

    response = await client.post(f"/v1/deliveries/{delivery_id}/replay")

    assert response.status_code == 409
    assert response.json()["code"] == "delivery_not_replayable"
    session.expire_all()
    assert await session.scalar(select(Delivery.attempts)) == 7  # untouched


async def test_bulk_replay_touches_only_dead_deliveries_matching_the_filter(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    broken = await create_endpoint(client, url="https://broken.example.com/h")
    healthy = await create_endpoint(client, url="https://healthy.example.com/h")
    for _ in range(3):
        await emit(client, key)
    await set_status(session, "dead", "endpoint_id = :id", id=broken["id"])
    await set_status(session, "succeeded", "endpoint_id = :id", id=healthy["id"])

    response = await client.post("/v1/deliveries/replay", json={"endpoint_id": broken["id"]})

    assert response.status_code == 200
    assert response.json() == {"replayed": 3}
    assert {d["status"] for d in await listed(client, endpoint_id=broken["id"])} == {"pending"}
    assert {d["attempts"] for d in await listed(client, endpoint_id=broken["id"])} == {0}
    assert {d["status"] for d in await listed(client, endpoint_id=healthy["id"])} == {"succeeded"}
    details = await session.scalar(
        select(AuditLog.details).where(AuditLog.action == "delivery.bulk_replayed")
    )
    assert details is not None
    assert details["count"] == 3


async def test_bulk_replay_by_event_type_and_with_nothing_to_do(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)
    key = await create_api_key(client)
    await create_endpoint(client)
    await emit(client, key, "order.paid")
    await emit(client, key, "user.created")
    await set_status(session, "dead")

    by_type = await client.post("/v1/deliveries/replay", json={"event_type": "user.created"})
    nothing = await client.post("/v1/deliveries/replay", json={"event_type": "user.created"})

    assert by_type.json() == {"replayed": 1}
    assert nothing.json() == {"replayed": 0}
    assert len(await listed(client, status="dead")) == 1


@pytest.mark.parametrize(
    "body",
    [{"status": "pending"}, {"status": "in_flight"}, {"status": "nope"}, {"unknown": 1}],
)
async def test_bulk_replay_rejects_unsafe_or_unknown_filters(
    client: AsyncClient, body: dict[str, Any]
) -> None:
    await register(client)

    assert (await client.post("/v1/deliveries/replay", json=body)).status_code == 422


# ------------------------------------------------------------- roles and tenancy
async def test_viewers_can_browse_but_not_replay(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    owner = await register(client, "owner@example.com", "Acme")
    acme = {"X-Org-ID": owner["organizations"][0]["id"]}
    key = await create_api_key(client)
    await create_endpoint(client)
    await emit(client, key)
    await set_status(session, "dead")
    delivery_id = await session.scalar(select(Delivery.id))
    viewer = await register(other_client, "viewer@example.com", "Own Org")
    await add_member(session, user_id=viewer["user"]["id"], org_id=acme["X-Org-ID"], role="viewer")

    assert (await other_client.get("/v1/deliveries", headers=acme)).status_code == 200
    assert (
        await other_client.get(f"/v1/deliveries/{delivery_id}", headers=acme)
    ).status_code == 200
    one = await other_client.post(f"/v1/deliveries/{delivery_id}/replay", headers=acme)
    bulk = await other_client.post("/v1/deliveries/replay", json={}, headers=acme)
    assert one.status_code == bulk.status_code == 403
    assert (await listed(client))[0]["status"] == "dead"


async def test_another_organisation_cannot_see_or_replay_deliveries_by_id(
    client: AsyncClient, other_client: AsyncClient, session: AsyncSession
) -> None:
    await register(client, "a@example.com", "Org A")
    key = await create_api_key(client)
    endpoint_a = await create_endpoint(client)
    await emit(client, key)
    await set_status(session, "dead")
    delivery_id = await session.scalar(select(Delivery.id))
    await register(other_client, "b@example.com", "Org B")

    assert await listed(other_client) == []
    assert await listed(other_client, endpoint_id=endpoint_a["id"]) == []
    get = await other_client.get(f"/v1/deliveries/{delivery_id}")
    replay = await other_client.post(f"/v1/deliveries/{delivery_id}/replay")
    bulk = await other_client.post("/v1/deliveries/replay", json={})
    targeted = await other_client.post(
        "/v1/deliveries/replay", json={"endpoint_id": endpoint_a["id"]}
    )

    assert get.status_code == replay.status_code == 404
    assert get.json()["code"] == "delivery_not_found"
    assert bulk.json() == targeted.json() == {"replayed": 0}
    assert (await listed(client))[0]["status"] == "dead"  # Org A's delivery is untouched


async def test_delivery_routes_require_a_session(client: AsyncClient) -> None:
    delivery_id = uuid.uuid4()

    assert (await client.get("/v1/deliveries")).status_code == 401
    assert (await client.get(f"/v1/deliveries/{delivery_id}")).status_code == 401
    assert (await client.post(f"/v1/deliveries/{delivery_id}/replay")).status_code == 401
    assert (await client.post("/v1/deliveries/replay", json={})).status_code == 401


async def test_unknown_delivery_is_a_404(client: AsyncClient) -> None:
    await register(client)

    assert (await client.get(f"/v1/deliveries/{uuid.uuid4()}")).status_code == 404
    assert (await client.post(f"/v1/deliveries/{uuid.uuid4()}/replay")).status_code == 404
