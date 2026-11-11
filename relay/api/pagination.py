"""Cursor ("keyset") pagination for newest-first lists.

Instead of ``OFFSET 5000`` (which makes the database walk and throw away 5000
rows, and shows duplicates when new rows arrive mid-scroll), the client sends back
an opaque cursor naming the last row it saw. The next page is "rows older than
that one", which an index answers directly however deep the page is.

The cursor is ``(created_at, id)``; the id breaks ties between rows created in the
same microsecond, so no row is ever skipped or repeated.
"""

import base64
import binascii
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel
from sqlalchemy import Select, tuple_
from sqlalchemy.orm import InstrumentedAttribute

from relay.core.errors import AppError

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


class Page[T](BaseModel):
    items: list[T]
    # Pass this back as ?cursor=... to get the next page; null on the last page.
    next_cursor: str | None


def encode_cursor(created_at: datetime, row_id: uuid.UUID) -> str:
    raw = f"{created_at.isoformat()}|{row_id}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        created_at, _, row_id = base64.urlsafe_b64decode(padded).decode().partition("|")
        parsed = datetime.fromisoformat(created_at)
        if parsed.tzinfo is None:
            raise ValueError("cursor timestamp has no timezone")
        return parsed, uuid.UUID(row_id)
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise AppError(400, "invalid_cursor", "The cursor is not valid.") from exc


def newest_first[S: Select[*tuple[Any, ...]]](
    query: S,
    created_at: InstrumentedAttribute[datetime],
    row_id: InstrumentedAttribute[uuid.UUID],
    *,
    cursor: str | None,
    limit: int,
) -> S:
    """Order ``query`` newest first, start after ``cursor``, and fetch one extra
    row so the caller can tell whether another page exists."""
    if cursor is not None:
        query = query.where(tuple_(created_at, row_id) < decode_cursor(cursor))
    return query.order_by(created_at.desc(), row_id.desc()).limit(limit + 1)
