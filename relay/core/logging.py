"""Structured logging.

Every log line is one JSON object written to stdout. Context such as ``request_id``
is bound with ``structlog.contextvars`` and merged into every line automatically.
Standard-library loggers (uvicorn, SQLAlchemy, ...) are routed through the same
formatter, so the whole process emits one consistent format.
"""

import logging
import sys
from collections.abc import MutableMapping
from typing import Any

import structlog
from opentelemetry import trace
from structlog.typing import Processor


def _add_trace_id(
    _logger: Any, _method: str, event: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Stamp each log line with the trace it belongs to, so you can jump from a
    log line to its trace and back."""
    context = trace.get_current_span().get_span_context()
    if context.is_valid:
        event["trace_id"] = format(context.trace_id, "032x")
    return event


def configure_logging(level: str = "INFO", *, json: bool = True) -> None:
    shared: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        _add_trace_id,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]
    renderer: Processor = (
        structlog.processors.JSONRenderer() if json else structlog.dev.ConsoleRenderer()
    )

    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.format_exc_info,
            renderer,
        ],
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)

    # Uvicorn installs its own handlers; send its logs through ours instead.
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
    # We write our own access log line (with request_id) in RequestContextMiddleware.
    logging.getLogger("uvicorn.access").disabled = True


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    logger: structlog.stdlib.BoundLogger = structlog.stdlib.get_logger(name)
    return logger
