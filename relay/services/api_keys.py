"""API keys: how a customer's backend authenticates when it sends events."""

import uuid
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core import security
from relay.core.errors import AppError
from relay.db.models import ApiKey
from relay.services import audit

# last_used_at is informational; updating it at most once a minute avoids a
# database write on every single event.
_LAST_USED_RESOLUTION = timedelta(minutes=1)


async def create_api_key(
    session: AsyncSession, *, org_id: uuid.UUID, name: str, actor_user_id: uuid.UUID, live: bool
) -> tuple[ApiKey, str]:
    """Create a key. The second value is the full key: it is returned exactly
    once, here, and cannot be recovered afterwards."""
    key, prefix, key_hash = security.new_api_key(live=live)
    api_key = ApiKey(org_id=org_id, name=name.strip(), prefix=prefix, key_hash=key_hash)
    session.add(api_key)
    await session.flush()
    audit.record(
        session,
        org_id=org_id,
        actor_user_id=actor_user_id,
        action="api_key.created",
        target_type="api_key",
        target_id=api_key.id,
        details={"name": api_key.name, "prefix": prefix},
    )
    await session.commit()
    return api_key, key


async def list_api_keys(session: AsyncSession, org_id: uuid.UUID) -> list[ApiKey]:
    result = await session.scalars(
        select(ApiKey).where(ApiKey.org_id == org_id).order_by(ApiKey.created_at.desc(), ApiKey.id)
    )
    return list(result)


async def revoke_api_key(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    key_id: uuid.UUID,
    actor_user_id: uuid.UUID,
    now: datetime,
) -> None:
    # The org_id filter is the tenancy boundary: another organisation's key id
    # behaves exactly like one that doesn't exist.
    api_key = await session.scalar(
        select(ApiKey).where(ApiKey.id == key_id, ApiKey.org_id == org_id)
    )
    if api_key is None:
        raise AppError(404, "api_key_not_found", "No such API key.")
    if api_key.revoked_at is None:
        api_key.revoked_at = now
        audit.record(
            session,
            org_id=org_id,
            actor_user_id=actor_user_id,
            action="api_key.revoked",
            target_type="api_key",
            target_id=api_key.id,
        )
    await session.commit()


async def authenticate_api_key(session: AsyncSession, key: str, *, now: datetime) -> ApiKey | None:
    """Return the active key matching ``key``, or ``None``."""
    if not key.startswith(security.API_KEY_MARKER):
        return None
    api_key = await session.scalar(
        select(ApiKey).where(
            ApiKey.key_hash == security.hash_token(key), ApiKey.revoked_at.is_(None)
        )
    )
    if api_key is None:
        return None
    if api_key.last_used_at is None or now - api_key.last_used_at > _LAST_USED_RESOLUTION:
        await session.execute(
            update(ApiKey).where(ApiKey.id == api_key.id).values(last_used_at=now)
        )
        await session.commit()
    return api_key
