"""Request context middleware.

For every HTTP request it:

1. takes the caller's ``X-Request-ID`` (if well-formed) or generates one,
2. binds it to the logging context so every log line for this request carries it,
3. echoes it back in the response header,
4. writes one access-log line with status and duration,
5. turns any unhandled exception into the standard JSON 500 body, so clients
   never see a stack trace and support can still find the request by its id.

It is a plain ASGI middleware rather than ``BaseHTTPMiddleware`` so that streaming
responses (the SSE live feed) pass through untouched.
"""

import json
import re
import time
import uuid

import structlog
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from relay.core.errors import REQUEST_ID_HEADER, error_body
from relay.core.logging import get_logger

log = get_logger("relay.http")

_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_QUIET_PATHS = frozenset({"/healthz", "/readyz", "/metrics"})


def _incoming_request_id(scope: Scope) -> str | None:
    for name, value in scope.get("headers", []):
        if name == b"x-request-id":
            candidate = str(value.decode("latin-1"))
            return candidate if _VALID_REQUEST_ID.fullmatch(candidate) else None
    return None


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _incoming_request_id(scope) or uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id
        status_code = 500
        response_started = False
        started_at = time.perf_counter()

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code, response_started
            if message["type"] == "http.response.start":
                response_started = True
                status_code = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        with structlog.contextvars.bound_contextvars(request_id=request_id):
            try:
                await self.app(scope, receive, send_with_request_id)
            except Exception:
                log.exception("http.unhandled_error", method=scope["method"], path=scope["path"])
                if response_started:
                    raise
                await _send_internal_error(send_with_request_id, request_id)
            finally:
                duration_ms = round((time.perf_counter() - started_at) * 1000, 1)
                log_line = log.debug if scope["path"] in _QUIET_PATHS else log.info
                log_line(
                    "http.request",
                    method=scope["method"],
                    path=scope["path"],
                    status=status_code,
                    duration_ms=duration_ms,
                )


async def _send_internal_error(send: Send, request_id: str) -> None:
    body = json.dumps(
        error_body("internal_error", "An unexpected error occurred.", None, request_id)
    ).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 500,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
