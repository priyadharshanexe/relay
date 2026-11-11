"""Audit trail: who did what, to which object."""

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from relay.db.models import AuditLog


def record(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    actor_user_id: uuid.UUID | None,
    action: str,
    target_type: str,
    target_id: uuid.UUID | str,
    details: dict[str, Any] | None = None,
) -> None:
    """Add an audit entry to the current transaction, so it commits (or rolls
    back) together with the change it describes."""
    session.add(
        AuditLog(
            org_id=org_id,
            actor_user_id=actor_user_id,
            action=action,
            target_type=target_type,
            target_id=str(target_id),
            details=details or {},
        )
    )
