# syntax=docker/dockerfile:1

# ---- build stage: resolve and install dependencies into /app/.venv ----------
FROM python:3.13-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /src

# Dependencies first, so this layer is cached until uv.lock changes.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Then the application itself, installed as a regular (non-editable) package.
COPY README.md ./
COPY relay ./relay
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable


# ---- runtime stage: just Python and the virtualenv, running as non-root -----
FROM python:3.13-slim AS runtime

RUN groupadd --system --gid 10001 relay \
 && useradd --system --uid 10001 --gid relay --no-create-home relay

COPY --from=builder --chown=relay:relay /app/.venv /app/.venv

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
USER relay
EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"]

CMD ["uvicorn", "--factory", "relay.main:create_app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--proxy-headers"]
