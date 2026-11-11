"""One JSON error shape for every failure: ``{code, message, details, request_id}``.

Handlers here cover our own ``AppError``, FastAPI validation errors and Starlette
HTTP errors (404, 405, ...). Unhandled exceptions are turned into a 500 by
``RequestContextMiddleware`` so that the response still carries the request id.
"""

from http import HTTPStatus
from typing import Any, cast

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import HTTPExceptionHandler

REQUEST_ID_HEADER = "X-Request-ID"


class AppError(Exception):
    """An expected error that maps to a specific HTTP status and error code."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def request_id_of(request: Request) -> str | None:
    value = getattr(request.state, "request_id", None)
    return value if isinstance(value, str) else None


def error_body(
    code: str, message: str, details: Any = None, request_id: str | None = None
) -> dict[str, Any]:
    return {"code": code, "message": message, "details": details, "request_id": request_id}


def error_response(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    details: Any = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    request_id = request_id_of(request)
    all_headers = dict(headers or {})
    if request_id:
        all_headers[REQUEST_ID_HEADER] = request_id
    return JSONResponse(
        status_code=status_code,
        content=error_body(code, message, details, request_id),
        headers=all_headers,
    )


def _status_code_slug(status_code: int) -> str:
    try:
        return HTTPStatus(status_code).name.lower()
    except ValueError:
        return "http_error"


async def _handle_app_error(request: Request, exc: AppError) -> JSONResponse:
    return error_response(request, exc.status_code, exc.code, exc.message, exc.details, exc.headers)


async def _handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    # Only location, message and type: the raw "input" could echo a password back.
    details = [
        {"loc": list(err.get("loc", ())), "msg": str(err.get("msg", "")), "type": err.get("type")}
        for err in exc.errors()
    ]
    return error_response(request, 422, "validation_error", "The request is not valid.", details)


async def _handle_http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    message = exc.detail if isinstance(exc.detail, str) else "HTTP error"
    return error_response(
        request,
        exc.status_code,
        _status_code_slug(exc.status_code),
        message,
        headers=dict(exc.headers) if exc.headers else None,
    )


def register_exception_handlers(app: FastAPI) -> None:
    # Starlette types handlers as taking a plain Exception; it only ever passes the
    # registered class (or a subclass), so the narrower signatures are safe.
    app.add_exception_handler(AppError, cast(HTTPExceptionHandler, _handle_app_error))
    app.add_exception_handler(
        RequestValidationError, cast(HTTPExceptionHandler, _handle_validation_error)
    )
    app.add_exception_handler(
        StarletteHTTPException, cast(HTTPExceptionHandler, _handle_http_exception)
    )
