"""Live delivery feed over Server-Sent Events (SSE).

SSE is a plain HTTP response that never ends: the server keeps writing
``data: {...}`` lines and the browser's ``EventSource`` hands each one to the
page. It is one-directional (server to browser), which is all a feed needs, and
unlike WebSockets it works through ordinary proxies and reconnects by itself.
"""

import json
import uuid
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from relay.api.deps import CurrentUser, RedisDep, SessionDep, SettingsDep, resolve_membership
from relay.core.live import live_updates

router = APIRouter(prefix="/stream", tags=["live feed"])

HEARTBEAT_SECONDS = 15.0


def format_sse(update: dict[str, Any] | None) -> str:
    if update is None:
        return ": keep-alive\n\n"  # a comment line: ignored by the browser
    return f"event: {update.get('type', 'message')}\ndata: {json.dumps(update)}\n\n"


async def sse_stream(updates: AsyncIterator[dict[str, Any] | None]) -> AsyncIterator[str]:
    yield ": connected\n\n"  # flushes the headers so the browser's onopen fires
    async for update in updates:
        yield format_sse(update)


@router.get("/deliveries", response_class=StreamingResponse)
async def stream_deliveries(
    user: CurrentUser,
    session: SessionDep,
    redis: RedisDep,
    settings: SettingsDep,
    # EventSource cannot set headers, so the organisation comes as a query parameter.
    org_id: Annotated[uuid.UUID | None, Query()] = None,
) -> StreamingResponse:
    """A stream of delivery attempts for your organisation, as they happen."""
    membership = await resolve_membership(session, user, org_id)
    # This response can stay open for hours. Give the database connection back
    # now, or every open dashboard would pin one from the pool.
    await session.close()
    return StreamingResponse(
        sse_stream(
            live_updates(
                redis,
                membership.org_id,
                heartbeat_seconds=HEARTBEAT_SECONDS,
                # No stream outlives the access token that opened it.
                max_seconds=settings.access_token_ttl_seconds,
            )
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
