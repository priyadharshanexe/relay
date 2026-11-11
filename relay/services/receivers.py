"""Built-in test receivers: fake customer servers you can script.

They exist so that every failure mode can be shown on demand (a 500, a 429 with
Retry-After, a slow response, a timeout) without needing a real server somewhere,
and so that a public demo never has to send requests to arbitrary addresses.
"""

import secrets
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from relay.core.errors import AppError
from relay.db.models import TestReceiver


def is_builtin_receiver_url(url: str, receiver_url_prefix: str) -> bool:
    """Is ``url`` one of our own receivers?

    The prefix ends with ``/receiver/``, so a lookalike host such as
    ``http://api:8000.evil.example/receiver/x`` can never match.
    """
    return url.startswith(receiver_url_prefix)


def _not_found() -> AppError:
    return AppError(404, "receiver_not_found", "No such test receiver.")


async def create_receiver(
    session: AsyncSession, *, org_id: uuid.UUID, fields: dict[str, Any]
) -> TestReceiver:
    receiver = TestReceiver(org_id=org_id, token=secrets.token_urlsafe(24), **fields)
    session.add(receiver)
    await session.commit()
    await session.refresh(receiver)
    return receiver


async def list_receivers(session: AsyncSession, org_id: uuid.UUID) -> list[TestReceiver]:
    result = await session.scalars(
        select(TestReceiver)
        .where(TestReceiver.org_id == org_id)
        .order_by(TestReceiver.created_at.desc(), TestReceiver.id)
    )
    return list(result)


async def get_receiver(
    session: AsyncSession, org_id: uuid.UUID, receiver_id: uuid.UUID
) -> TestReceiver:
    receiver = await session.scalar(
        select(TestReceiver).where(TestReceiver.id == receiver_id, TestReceiver.org_id == org_id)
    )
    if receiver is None:
        raise _not_found()
    return receiver


async def update_receiver(
    session: AsyncSession, org_id: uuid.UUID, receiver_id: uuid.UUID, changes: dict[str, Any]
) -> TestReceiver:
    receiver = await get_receiver(session, org_id, receiver_id)
    for field, value in changes.items():
        setattr(receiver, field, value)
    await session.commit()
    await session.refresh(receiver)
    return receiver


async def delete_receiver(session: AsyncSession, org_id: uuid.UUID, receiver_id: uuid.UUID) -> None:
    receiver = await get_receiver(session, org_id, receiver_id)
    await session.delete(receiver)
    await session.commit()


async def record_request(
    session: AsyncSession, token: str, *, now: datetime
) -> TestReceiver | None:
    """Count one incoming request and return the receiver's settings, or ``None``
    if the token is unknown."""
    receiver = (
        await session.execute(
            update(TestReceiver)
            .where(TestReceiver.token == token)
            .values(requests_received=TestReceiver.requests_received + 1, last_received_at=now)
            .returning(TestReceiver)
        )
    ).scalar_one_or_none()
    await session.commit()
    return receiver
