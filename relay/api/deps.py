"""Request dependencies: shared resources, and "who is calling?".

Two kinds of caller exist:

* a **person** using the dashboard, identified by the session cookie (or a Bearer
  JWT), acting inside one organisation with a role;
* a **machine** sending events, identified by an API key that belongs to exactly
  one organisation.

Every tenant-scoped route depends on ``OrgContext`` or ``ApiKeyContext``, so a
handler never sees a request without knowing which organisation it is for.
"""

import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, cast

from fastapi import Depends, Header, Request
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from relay.core import security
from relay.core.config import Settings
from relay.core.crypto import SecretBox
from relay.core.errors import AppError
from relay.db.models import Membership, User
from relay.domain.enums import Role
from relay.services import api_keys as api_key_service

ACCESS_COOKIE = "relay_access"
REFRESH_COOKIE = "relay_refresh"
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


# -------------------------------------------------------------------- resources
def get_engine(request: Request) -> AsyncEngine:
    return cast(AsyncEngine, request.app.state.engine)


def get_redis(request: Request) -> Redis:
    return cast(Redis, request.app.state.redis)


def get_settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    factory = cast(async_sessionmaker[AsyncSession], request.app.state.session_factory)
    async with factory() as session:
        yield session


def get_secret_box(request: Request) -> SecretBox:
    return cast(SecretBox, request.app.state.secret_box)


def utc_now() -> datetime:
    return datetime.now(UTC)


SessionDep = Annotated[AsyncSession, Depends(get_session)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
RedisDep = Annotated[Redis, Depends(get_redis)]
SecretBoxDep = Annotated[SecretBox, Depends(get_secret_box)]


# ------------------------------------------------------------------------- CSRF
def verify_origin(request: Request, settings: SettingsDep) -> None:
    """Refuse state-changing requests that a browser sent from another website.

    Cookies are attached automatically, so a malicious page could otherwise make
    a logged-in user's browser call our API. Browsers always send ``Origin`` on
    cross-site writes; non-browser clients don't send it and don't carry cookies.
    """
    if request.method in _SAFE_METHODS:
        return
    origin = request.headers.get("origin")
    if origin is not None and origin not in settings.allowed_origins:
        raise AppError(403, "origin_not_allowed", "This origin may not call the API.")


# ---------------------------------------------------------------------- people
def _unauthenticated() -> AppError:
    return AppError(
        401, "not_authenticated", "Log in to continue.", headers={"WWW-Authenticate": "Bearer"}
    )


def _bearer_token(request: Request) -> str | None:
    scheme, _, value = request.headers.get("authorization", "").partition(" ")
    return value.strip() if scheme.lower() == "bearer" and value.strip() else None


async def current_user(request: Request, session: SessionDep, settings: SettingsDep) -> User:
    token = _bearer_token(request)
    if token is None:
        token = request.cookies.get(ACCESS_COOKIE)
        if token is not None:
            verify_origin(request, settings)  # only cookie auth is open to CSRF
    if token is None:
        raise _unauthenticated()

    try:
        user_id = security.decode_access_token(token, secret=settings.jwt_secret.get_secret_value())
    except security.InvalidTokenError as exc:
        raise _unauthenticated() from exc

    user = await session.get(User, user_id)
    if user is None:
        raise _unauthenticated()
    return user


CurrentUser = Annotated[User, Depends(current_user)]


@dataclass(frozen=True, slots=True)
class OrgContext:
    """A person acting inside one organisation."""

    user: User
    org_id: uuid.UUID
    role: Role


async def org_context(
    user: CurrentUser,
    session: SessionDep,
    x_org_id: Annotated[uuid.UUID | None, Header()] = None,
) -> OrgContext:
    """Pick the organisation for this request: the ``X-Org-ID`` header if given,
    otherwise the user's first organisation. Membership is always checked."""
    query = select(Membership).where(Membership.user_id == user.id)
    if x_org_id is not None:
        query = query.where(Membership.org_id == x_org_id)
    membership = await session.scalar(
        query.order_by(Membership.created_at, Membership.org_id).limit(1)
    )
    if membership is None:
        # Same answer whether the organisation doesn't exist or you aren't in it.
        raise AppError(404, "organization_not_found", "No such organisation.")
    return OrgContext(user, membership.org_id, Role(membership.role))


OrgDep = Annotated[OrgContext, Depends(org_context)]


def require_role(*allowed: Role) -> Callable[[OrgContext], Awaitable[OrgContext]]:
    """Dependency factory: the caller must hold one of ``allowed`` in this organisation."""

    async def dependency(context: OrgDep) -> OrgContext:
        if context.role not in allowed:
            raise AppError(403, "forbidden", "Your role does not allow this action.")
        return context

    return dependency


# Owners and developers can change things; viewers can only look.
EditorDep = Annotated[OrgContext, Depends(require_role(Role.OWNER, Role.DEVELOPER))]


# --------------------------------------------------------------------- machines
@dataclass(frozen=True, slots=True)
class ApiKeyContext:
    org_id: uuid.UUID
    api_key_id: uuid.UUID


async def api_key_context(request: Request, session: SessionDep) -> ApiKeyContext:
    key = _bearer_token(request)
    api_key = (
        await api_key_service.authenticate_api_key(session, key, now=utc_now()) if key else None
    )
    if api_key is None:
        raise AppError(
            401,
            "invalid_api_key",
            "Send a valid API key as 'Authorization: Bearer <key>'.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return ApiKeyContext(api_key.org_id, api_key.id)


ApiKeyDep = Annotated[ApiKeyContext, Depends(api_key_context)]
