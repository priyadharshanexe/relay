"""Dashboard sign-up, login and session routes.

Tokens travel in ``HttpOnly`` cookies, so JavaScript (and therefore any XSS bug)
can never read them. The refresh cookie is only sent to ``/v1/auth``.
"""

import hashlib
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr, Field, StringConstraints
from sqlalchemy.ext.asyncio import AsyncSession

from relay.api.deps import (
    ACCESS_COOKIE,
    REFRESH_COOKIE,
    CurrentUser,
    RedisDep,
    SessionDep,
    SettingsDep,
    utc_now,
    verify_origin,
)
from relay.core.config import Settings
from relay.core.errors import AppError
from relay.core.throttle import throttle
from relay.db.models import User
from relay.domain.enums import Role
from relay.services import auth as auth_service
from relay.services.auth import SessionTokens

router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(verify_origin)])

_REFRESH_COOKIE_PATH = "/v1/auth"

# Long enough to resist guessing; capped because Argon2 cost grows with length.
Password = Annotated[str, Field(min_length=10, max_length=128)]


class RegisterRequest(BaseModel):
    email: EmailStr
    password: Password
    # Stripped first, so a name made only of spaces counts as empty.
    organization_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)
    ]


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    id: uuid.UUID
    email: str


class OrganizationOut(BaseModel):
    id: uuid.UUID
    name: str
    role: Role


class SessionOut(BaseModel):
    user: UserOut
    organizations: list[OrganizationOut]


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _set_session_cookies(response: Response, tokens: SessionTokens, settings: Settings) -> None:
    secure = settings.cookies_are_secure
    response.set_cookie(
        ACCESS_COOKIE,
        tokens.access_token,
        max_age=settings.access_token_ttl_seconds,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        REFRESH_COOKIE,
        tokens.refresh_token,
        max_age=settings.refresh_token_ttl_days * 86400,
        httponly=True,
        secure=secure,
        samesite="lax",
        path=_REFRESH_COOKIE_PATH,
    )


def _clear_session_cookies(response: Response, settings: Settings) -> None:
    secure = settings.cookies_are_secure
    response.delete_cookie(ACCESS_COOKIE, path="/", httponly=True, secure=secure, samesite="lax")
    response.delete_cookie(
        REFRESH_COOKIE, path=_REFRESH_COOKIE_PATH, httponly=True, secure=secure, samesite="lax"
    )


async def _session_out(session: AsyncSession, user: User) -> SessionOut:
    memberships = await auth_service.list_memberships(session, user.id)
    return SessionOut(
        user=UserOut(id=user.id, email=user.email),
        organizations=[
            OrganizationOut(id=organization.id, name=organization.name, role=role)
            for organization, role in memberships
        ],
    )


@router.post("/register", status_code=201)
async def register(
    body: RegisterRequest,
    request: Request,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    redis: RedisDep,
) -> SessionOut:
    """Create an account and its first organisation, and log in."""
    await throttle(
        redis,
        f"register:{_client_ip(request)}",
        limit=settings.registrations_per_hour,
        window_seconds=3600,
    )
    user = await auth_service.register(
        session,
        email=body.email,
        password=body.password,
        organization_name=body.organization_name,
    )
    tokens = await auth_service.start_session(session, user, settings, now=utc_now())
    _set_session_cookies(response, tokens, settings)
    return await _session_out(session, user)


@router.post("/login")
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    redis: RedisDep,
) -> SessionOut:
    # Per IP and per account, so one attacker can't lock everyone out and can't
    # hammer one account from a single address.
    email_digest = hashlib.sha256(auth_service.normalize_email(body.email).encode()).hexdigest()
    await throttle(
        redis,
        f"login:{_client_ip(request)}:{email_digest[:16]}",
        limit=settings.login_attempts_per_minute,
        window_seconds=60,
    )
    user = await auth_service.authenticate(session, email=body.email, password=body.password)
    tokens = await auth_service.start_session(session, user, settings, now=utc_now())
    _set_session_cookies(response, tokens, settings)
    return await _session_out(session, user)


@router.post("/refresh")
async def refresh(
    request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> SessionOut:
    """Swap the refresh cookie for a fresh pair of tokens."""
    refresh_token = request.cookies.get(REFRESH_COOKIE)
    if not refresh_token:
        raise AppError(401, "invalid_session", "Your session has ended. Please log in again.")
    user, tokens = await auth_service.rotate_session(
        session, refresh_token, settings, now=utc_now()
    )
    _set_session_cookies(response, tokens, settings)
    return await _session_out(session, user)


@router.post("/logout", status_code=204)
async def logout(
    request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> None:
    await auth_service.end_session(session, request.cookies.get(REFRESH_COOKIE), now=utc_now())
    _clear_session_cookies(response, settings)


@router.get("/me")
async def me(user: CurrentUser, session: SessionDep) -> SessionOut:
    """Who am I, and which organisations can I act in?"""
    return await _session_out(session, user)
