import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core import security
from relay.core.config import DEV_JWT_SECRET
from relay.db.models import AuditLog, Membership, Organization, RefreshToken, User
from relay.main import create_app
from tests.conftest import make_settings
from tests.integration.helpers import PASSWORD, login, register, set_cookie_headers

pytestmark = pytest.mark.integration


@pytest.fixture
async def other_client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """A second browser talking to the same app (the first is ``client``)."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


# --------------------------------------------------------------------- register
async def test_register_creates_user_organisation_and_owner_membership(
    client: AsyncClient, session: AsyncSession
) -> None:
    body = await register(client, "Owner@Example.com", "Acme Inc")

    assert body["user"]["email"] == "owner@example.com"  # normalised
    assert body["organizations"] == [
        {"id": body["organizations"][0]["id"], "name": "Acme Inc", "role": "owner"}
    ]
    user = await session.scalar(select(User))
    assert user is not None
    membership = await session.scalar(select(Membership))
    assert membership is not None
    assert membership.role == "owner"
    assert await session.scalar(select(Organization.name)) == "Acme Inc"
    assert await session.scalar(select(AuditLog.action)) == "organization.created"


async def test_password_is_stored_only_as_an_argon2id_hash(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client)

    password_hash = await session.scalar(select(User.password_hash))

    assert password_hash is not None
    assert password_hash.startswith("$argon2id$")
    assert PASSWORD not in password_hash


async def test_session_cookies_are_httponly_and_refresh_is_scoped(client: AsyncClient) -> None:
    response = await client.post(
        "/v1/auth/register",
        json={"email": "a@example.com", "password": PASSWORD, "organization_name": "A"},
    )

    cookies = {header.split("=", 1)[0]: header for header in set_cookie_headers(response)}
    assert set(cookies) == {"relay_access", "relay_refresh"}
    for header in cookies.values():
        assert "HttpOnly" in header
        assert "SameSite=lax" in header
    assert "Path=/v1/auth" in cookies["relay_refresh"]
    assert "Path=/;" in cookies["relay_access"] or cookies["relay_access"].endswith("Path=/")
    assert "relay_access" not in response.text  # tokens never appear in the body
    assert "password" not in response.text


async def test_cookies_are_marked_secure_in_production() -> None:
    app = create_app(make_settings(environment="production", jwt_secret="x" * 40))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="https://test") as client,
    ):
        response = await client.post(
            "/v1/auth/register",
            json={"email": "a@example.com", "password": PASSWORD, "organization_name": "A"},
        )

    assert response.status_code == 201
    assert all("Secure" in header for header in set_cookie_headers(response))


async def test_duplicate_email_is_rejected_whatever_the_case(client: AsyncClient) -> None:
    await register(client, "dev@example.com")

    response = await client.post(
        "/v1/auth/register",
        json={"email": "DEV@example.com", "password": PASSWORD, "organization_name": "Other"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "email_taken"


async def test_a_failed_registration_leaves_nothing_behind(
    client: AsyncClient, session: AsyncSession
) -> None:
    await register(client, "dev@example.com", "First")

    await client.post(
        "/v1/auth/register",
        json={"email": "dev@example.com", "password": PASSWORD, "organization_name": "Orphan"},
    )

    names = (await session.scalars(select(Organization.name))).all()
    assert names == ["First"]


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "not-an-email", "password": PASSWORD, "organization_name": "A"},
        {"email": "a@example.com", "password": "tiny-pw1", "organization_name": "A"},
        {"email": "a@example.com", "password": "x" * 129, "organization_name": "A"},
        {"email": "a@example.com", "password": PASSWORD, "organization_name": ""},
        {"email": "a@example.com", "password": PASSWORD},
    ],
)
async def test_invalid_registration_is_a_422_that_never_echoes_the_password(
    client: AsyncClient, payload: dict[str, str]
) -> None:
    response = await client.post("/v1/auth/register", json=payload)

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    if "password" in payload:
        assert payload["password"] not in response.text


# ------------------------------------------------------------------------ login
async def test_login_with_the_right_password_starts_a_session(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client, "dev@example.com")

    body = await login(other_client, "DEV@example.com")

    assert body["user"]["email"] == "dev@example.com"
    assert (await other_client.get("/v1/auth/me")).status_code == 200


async def test_wrong_password_and_unknown_email_look_identical(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client, "dev@example.com")

    wrong_password = await other_client.post(
        "/v1/auth/login", json={"email": "dev@example.com", "password": "not the password"}
    )
    unknown_email = await other_client.post(
        "/v1/auth/login", json={"email": "nobody@example.com", "password": "not the password"}
    )

    assert wrong_password.status_code == unknown_email.status_code == 401
    first, second = wrong_password.json(), unknown_email.json()
    first.pop("request_id")
    second.pop("request_id")
    assert first == second
    assert first["code"] == "invalid_credentials"
    assert set_cookie_headers(wrong_password) == []


async def test_repeated_login_attempts_are_rate_limited() -> None:
    app = create_app(make_settings(login_attempts_per_minute=3))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        statuses = [
            (
                await client.post(
                    "/v1/auth/login", json={"email": "dev@example.com", "password": "guess"}
                )
            ).status_code
            for _ in range(4)
        ]
        blocked = await client.post(
            "/v1/auth/login", json={"email": "dev@example.com", "password": "guess"}
        )
        other_account = await client.post(
            "/v1/auth/login", json={"email": "someone-else@example.com", "password": "guess"}
        )

    assert statuses == [401, 401, 401, 429]
    assert blocked.json()["code"] == "rate_limited"
    assert int(blocked.headers["Retry-After"]) >= 1
    assert other_account.status_code == 401  # a different account is not locked out


async def test_registrations_are_rate_limited_per_ip() -> None:
    app = create_app(make_settings(registrations_per_hour=2))
    async with (
        app.router.lifespan_context(app),
        AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client,
    ):
        statuses = []
        for number in range(3):
            response = await client.post(
                "/v1/auth/register",
                json={
                    "email": f"user{number}@example.com",
                    "password": PASSWORD,
                    "organization_name": "Org",
                },
            )
            statuses.append(response.status_code)

    assert statuses == [201, 201, 429]


# --------------------------------------------------------------- access tokens
async def test_me_requires_a_session(client: AsyncClient) -> None:
    response = await client.get("/v1/auth/me")

    assert response.status_code == 401
    assert response.json()["code"] == "not_authenticated"


def forged_token(**overrides: object) -> str:
    now = datetime.now(UTC)
    claims: dict[str, object] = {
        "sub": str(uuid.uuid4()),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=5)).timestamp()),
        "iss": "relay",
        "typ": "access",
    }
    claims.update(overrides)
    secret = str(claims.pop("secret", DEV_JWT_SECRET))
    return jwt.encode(claims, secret, algorithm="HS256")


async def test_a_bearer_access_token_also_works(client: AsyncClient) -> None:
    body = await register(client)
    token = client.cookies["relay_access"]
    client.cookies.clear()

    response = await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json()["user"]["id"] == body["user"]["id"]


async def test_tampered_expired_and_foreign_tokens_are_rejected(client: AsyncClient) -> None:
    body = await register(client)
    user_id = body["user"]["id"]
    client.cookies.clear()
    past = int((datetime.now(UTC) - timedelta(minutes=1)).timestamp())
    bad_tokens = {
        "garbage": "not.a.jwt",
        "expired": forged_token(sub=user_id, exp=past),
        "signed with another secret": forged_token(sub=user_id, secret="attacker-secret-" * 3),
        "wrong issuer": forged_token(sub=user_id, iss="someone-else"),
        "wrong type": forged_token(sub=user_id, typ="refresh"),
        "unknown user": forged_token(),
        "subject is not a uuid": forged_token(sub="admin"),
        "unsigned (alg none)": jwt.encode(
            {"sub": user_id, "exp": past + 600, "iat": past, "iss": "relay", "typ": "access"},
            key="",
            algorithm="none",
        ),
    }

    for label, token in bad_tokens.items():
        response = await client.get("/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 401, label

    # ...and the same token built correctly is accepted, so the test is meaningful.
    good = await client.get(
        "/v1/auth/me", headers={"Authorization": f"Bearer {forged_token(sub=user_id)}"}
    )
    assert good.status_code == 200


def test_access_token_round_trip_and_expiry() -> None:
    user_id = uuid.uuid4()
    now = datetime.now(UTC)
    token = security.create_access_token(
        user_id,
        secret="s" * 32,
        ttl=timedelta(minutes=15),
        now=now,
    )

    assert security.decode_access_token(token, secret="s" * 32) == user_id
    expired = security.create_access_token(
        user_id,
        secret="s" * 32,
        ttl=timedelta(minutes=15),
        now=now - timedelta(hours=1),
    )
    with pytest.raises(security.InvalidTokenError):
        security.decode_access_token(expired, secret="s" * 32)


# --------------------------------------------------------------------- refresh
def refresh_cookie(token: str) -> dict[str, str]:
    """Send a specific refresh token, as someone holding a copy of the cookie would."""
    return {"Cookie": f"relay_refresh={token}"}


async def test_a_copied_refresh_token_works_until_it_has_been_used(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    """Baseline for the theft tests below: the copied cookie really is sent and accepted."""
    await register(client)

    response = await other_client.post(
        "/v1/auth/refresh", headers=refresh_cookie(client.cookies["relay_refresh"])
    )

    assert response.status_code == 200


async def test_refresh_issues_new_tokens_and_keeps_the_session_alive(
    client: AsyncClient,
) -> None:
    await register(client)
    old_refresh = client.cookies["relay_refresh"]

    response = await client.post("/v1/auth/refresh")

    assert response.status_code == 200
    assert client.cookies["relay_refresh"] != old_refresh
    assert (await client.get("/v1/auth/me")).status_code == 200


async def test_refresh_tokens_are_stored_hashed(client: AsyncClient, session: AsyncSession) -> None:
    await register(client)
    token = client.cookies["relay_refresh"]

    stored = await session.scalar(select(RefreshToken.token_hash))

    assert stored == security.hash_token(token)
    assert stored != token


async def test_reusing_a_refresh_token_revokes_the_whole_session(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    """A thief who copied the refresh cookie uses it after the real user did."""
    await register(client)
    stolen = client.cookies["relay_refresh"]
    assert (await client.post("/v1/auth/refresh")).status_code == 200  # the real user

    replay = await other_client.post("/v1/auth/refresh", headers=refresh_cookie(stolen))

    assert replay.status_code == 401
    assert replay.json()["code"] == "invalid_session"
    # The real user's newer token is revoked too: they must log in again.
    assert (await client.post("/v1/auth/refresh")).status_code == 401


async def test_refresh_without_or_with_an_unknown_token_fails(client: AsyncClient) -> None:
    assert (await client.post("/v1/auth/refresh")).status_code == 401

    response = await client.post("/v1/auth/refresh", headers=refresh_cookie("made-up-token"))
    assert response.status_code == 401


async def test_an_expired_refresh_token_fails(client: AsyncClient, session: AsyncSession) -> None:
    await register(client)
    token = await session.scalar(select(RefreshToken))
    assert token is not None
    token.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await session.commit()

    assert (await client.post("/v1/auth/refresh")).status_code == 401


# ---------------------------------------------------------------------- logout
async def test_logout_ends_the_session_on_the_server(
    client: AsyncClient, other_client: AsyncClient
) -> None:
    await register(client)
    refresh_token = client.cookies["relay_refresh"]

    response = await client.post("/v1/auth/logout")

    assert response.status_code == 204
    assert "relay_access" not in client.cookies
    assert (await client.get("/v1/auth/me")).status_code == 401
    # Even someone who kept a copy of the refresh token can't use it now.
    replay = await other_client.post("/v1/auth/refresh", headers=refresh_cookie(refresh_token))
    assert replay.status_code == 401


async def test_logout_without_a_session_is_harmless(client: AsyncClient) -> None:
    assert (await client.post("/v1/auth/logout")).status_code == 204


# ------------------------------------------------------------------------- CSRF
async def test_cross_site_writes_with_cookies_are_refused(client: AsyncClient) -> None:
    await register(client)

    evil = await client.post(
        "/v1/api-keys", json={"name": "x"}, headers={"Origin": "https://evil.example"}
    )
    evil_logout = await client.post("/v1/auth/logout", headers={"Origin": "https://evil.example"})
    trusted = await client.post(
        "/v1/api-keys", json={"name": "x"}, headers={"Origin": "http://localhost:5173"}
    )

    assert evil.status_code == 403
    assert evil.json()["code"] == "origin_not_allowed"
    assert evil_logout.status_code == 403
    assert trusted.status_code == 201


async def test_cross_site_reads_are_not_blocked_by_the_origin_check(client: AsyncClient) -> None:
    await register(client)

    response = await client.get("/v1/auth/me", headers={"Origin": "https://evil.example"})

    assert response.status_code == 200  # reads change nothing; CORS keeps the answer private


# ---------------------------------------------------------------- configuration
def test_production_refuses_the_development_jwt_secret() -> None:
    with pytest.raises(ValueError, match="RELAY_JWT_SECRET"):
        make_settings(environment="production")
    with pytest.raises(ValueError, match="RELAY_JWT_SECRET"):
        make_settings(environment="production", jwt_secret="too-short")  # noqa: S106
