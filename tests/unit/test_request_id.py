import re

import pytest
from httpx import AsyncClient


async def test_generates_a_request_id_when_none_is_sent(client: AsyncClient) -> None:
    response = await client.get("/healthz")

    assert re.fullmatch(r"[0-9a-f]{32}", response.headers["X-Request-ID"])


async def test_echoes_a_well_formed_request_id(client: AsyncClient) -> None:
    response = await client.get("/healthz", headers={"X-Request-ID": "abc-123_DEF.9"})

    assert response.headers["X-Request-ID"] == "abc-123_DEF.9"


@pytest.mark.parametrize(
    "bad_id",
    [
        "has spaces",
        "x" * 129,  # too long to safely put in logs
        "inject\\nnewline",
        "",
    ],
)
async def test_replaces_a_malformed_request_id(client: AsyncClient, bad_id: str) -> None:
    response = await client.get("/healthz", headers={"X-Request-ID": bad_id})

    returned = response.headers["X-Request-ID"]
    assert returned != bad_id
    assert re.fullmatch(r"[0-9a-f]{32}", returned)


async def test_each_request_gets_its_own_id(client: AsyncClient) -> None:
    first = await client.get("/healthz")
    second = await client.get("/healthz")

    assert first.headers["X-Request-ID"] != second.headers["X-Request-ID"]
