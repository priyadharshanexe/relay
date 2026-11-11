# Relay

Reliable, signed webhook delivery: a transactional outbox, retries with backoff, a dead-letter queue and replay.

> **Status:** under active development. The foundation and the database schema are done; the delivery pipeline is next.
> The full README (architecture diagram, guarantees, demo) arrives with the first release.

## Quick start

Requirements: Docker Desktop.

```bash
docker compose up --build
```

| Service  | Address |
|----------|---------|
| API      | http://localhost:8000 (interactive docs at http://localhost:8000/docs) |
| Postgres | `localhost:5433`, user/password/database `relay` |
| Redis    | `localhost:6379` |

Postgres is published on host port 5433, not 5432, so it never clashes with a Postgres you may already have installed.

Check it's up:

```bash
curl http://localhost:8000/readyz
# {"status":"ok","checks":{"database":"ok","redis":"ok"}}
```

## Development

Requirements: [uv](https://docs.astral.sh/uv/) (it installs the right Python for you) and Docker.

```bash
uv sync                                  # install dependencies into .venv
docker compose up -d postgres redis      # services the tests need
uv run pytest                            # tests
uv run ruff check . && uv run ruff format --check .   # lint and format
uv run mypy                              # type check (strict)
```

The tests build their own `relay_test` database from the migrations on every run, so they never touch your development data.

### Database migrations

`docker compose up` applies migrations automatically before the API and worker start. To work with them by hand:

```bash
uv run alembic upgrade head                               # apply
uv run alembic revision --autogenerate -m "describe it"   # create one after changing relay/db/models.py
```

A test fails if the models and the migrations ever disagree.

Run the API or worker on your machine instead of in Docker (copy `.env.example` to `.env` first):

```bash
uv run uvicorn --factory relay.main:create_app --reload
uv run python -m relay.worker
```

## Project layout

```
relay/
  api/       HTTP routes (health so far)
  core/      settings, logging, error handling, request-id middleware
  db/        models, migrations, engine and sessions
  domain/    pure business logic, with no web, database or network imports
  services/  use cases that combine domain logic with I/O
  worker/    the delivery worker and its lifecycle
tests/
  unit/         fast tests, no services needed
  integration/  tests against real Postgres and Redis
docs/decisions/ architecture decision records
```

## Licence

[MIT](LICENSE)
