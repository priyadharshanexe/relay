"""Shared helpers for API tests."""

import uuid
from typing import Any

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from relay.db.models import Membership

PASSWORD = "correct horse battery staple"  # noqa: S105 - test data


async def register(
    client: AsyncClient,
    email: str = "owner@example.com",
    organization: str = "Acme",
    password: str = PASSWORD,
) -> dict[str, Any]:
    """Register (which also logs the client in) and return the response body."""
    response = await client.post(
        "/v1/auth/register",
        json={"email": email, "password": password, "organization_name": organization},
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def login(client: AsyncClient, email: str, password: str = PASSWORD) -> dict[str, Any]:
    response = await client.post("/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def add_member(session: AsyncSession, *, user_id: str, org_id: str, role: str) -> None:
    """Put an existing user into an organisation (there is no invitation API yet)."""
    session.add(Membership(user_id=uuid.UUID(user_id), org_id=uuid.UUID(org_id), role=role))
    await session.commit()


def set_cookie_headers(response: Any) -> list[str]:
    return list(response.headers.get_list("set-cookie"))
