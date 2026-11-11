"""Every failure returns the same JSON shape: {code, message, details, request_id}."""

from fastapi import FastAPI
from httpx import AsyncClient

from relay.core.errors import AppError


def add_failing_routes(app: FastAPI) -> None:
    @app.get("/test/app-error")
    async def app_error() -> None:
        raise AppError(409, "endpoint_conflict", "That endpoint already exists.", {"id": "e1"})

    @app.get("/test/needs-int")
    async def needs_int(n: int) -> dict[str, int]:
        return {"n": n}

    @app.get("/test/crash")
    async def crash() -> None:
        raise RuntimeError("database password is hunter2")


def assert_error_shape(body: dict[str, object]) -> None:
    assert set(body) == {"code", "message", "details", "request_id"}


async def test_app_error_uses_its_status_code_and_details(
    app: FastAPI, client: AsyncClient
) -> None:
    add_failing_routes(app)
    response = await client.get("/test/app-error")

    assert response.status_code == 409
    body = response.json()
    assert_error_shape(body)
    assert body["code"] == "endpoint_conflict"
    assert body["message"] == "That endpoint already exists."
    assert body["details"] == {"id": "e1"}
    assert body["request_id"] == response.headers["X-Request-ID"]


async def test_validation_error_lists_fields_without_echoing_input(
    app: FastAPI, client: AsyncClient
) -> None:
    add_failing_routes(app)
    response = await client.get("/test/needs-int", params={"n": "not-a-number"})

    assert response.status_code == 422
    body = response.json()
    assert_error_shape(body)
    assert body["code"] == "validation_error"
    assert body["details"][0]["loc"] == ["query", "n"]
    assert "input" not in body["details"][0]
    assert "not-a-number" not in response.text


async def test_unknown_route_is_a_json_404(client: AsyncClient) -> None:
    response = await client.get("/does-not-exist")

    assert response.status_code == 404
    body = response.json()
    assert_error_shape(body)
    assert body["code"] == "not_found"
    assert body["request_id"] == response.headers["X-Request-ID"]


async def test_wrong_method_is_a_json_405(client: AsyncClient) -> None:
    response = await client.post("/healthz")

    assert response.status_code == 405
    assert response.json()["code"] == "method_not_allowed"
    assert "GET" in response.headers["Allow"]


async def test_unhandled_exception_is_a_generic_500_without_internals(
    app: FastAPI, client: AsyncClient
) -> None:
    add_failing_routes(app)
    response = await client.get("/test/crash", headers={"X-Request-ID": "trace-me-123"})

    assert response.status_code == 500
    body = response.json()
    assert_error_shape(body)
    assert body["code"] == "internal_error"
    assert body["request_id"] == "trace-me-123"
    assert response.headers["X-Request-ID"] == "trace-me-123"
    assert "hunter2" not in response.text
    assert "RuntimeError" not in response.text
