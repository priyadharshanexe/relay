# Relay

Reliable, signed webhook delivery: a transactional outbox, retries with backoff, a dead-letter queue and replay.

> **Status:** under active development. The backend, the dashboard, metrics, alerts and a load test are done. Tracing and deployment are next.
> The full README (architecture diagram, guarantees, demo) arrives with the first release.

## Quick start

Requirements: Docker Desktop.

```bash
docker compose up --build
```

| Service  | Address |
|----------|---------|
| Dashboard | http://localhost:8080 |
| API      | http://localhost:8000 (interactive docs at http://localhost:8000/docs) |
| Postgres | `localhost:5433`, user/password/database `relay` |
| Redis    | `localhost:6379` |
| Grafana  | http://localhost:3000 (the "Relay overview" dashboard, no login locally) |
| Prometheus | http://localhost:9090 (alerts under Alerts) |

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

### Dashboard

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173, forwards API calls to localhost:8000
npm test             # component and API-client tests
npm run typecheck
```

End-to-end test (a real browser against the whole stack; the override shortens the retry schedule so a failing delivery is dead-lettered in seconds):

```bash
docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build --wait
cd frontend
npx playwright install chromium   # first time only
npm run e2e
```

## Observability

- **Metrics:** the API serves `/metrics` and each worker serves its own on port 9100. Prometheus scrapes both.
- **Dashboard:** queue lag, queue depth, delivery success rate and duration, ingest rate and API latency.
- **Alerts** ([rules](infra/observability/prometheus/alerts.yml), with [unit tests](infra/observability/prometheus/alerts.test.yml) that run in CI):

| Alert | Fires when | Runbook |
|---|---|---|
| `RelayQueueLagging` | a deliverable delivery has waited over 5 minutes, for 10 minutes | [queue-lag.md](docs/runbooks/queue-lag.md) |
| `RelayEndpointFailing` | an endpoint's circuit breaker has been open for 15 minutes | [endpoint-failing.md](docs/runbooks/endpoint-failing.md) |
| `RelayTargetDown` | Prometheus cannot reach the API or a worker for 2 minutes | [queue-lag.md](docs/runbooks/queue-lag.md) |

## Load test

On a laptop, one API process and one worker: **about 108 events/s at p95 164 ms**, and 165 events/s when saturated. 8,286 events in, 8,286 delivered exactly once. Method, machine and limits are in [docs/load-test.md](docs/load-test.md).

## Project layout

```
relay/
  api/       HTTP routes (auth, organisations, API keys, endpoints, events, deliveries, health)
  core/      settings, logging, errors, security, encryption, middleware
  db/        models, migrations, engine and sessions
  domain/    pure business logic, with no web, database or network imports
  services/  use cases that combine domain logic with I/O
  worker/    claim (SKIP LOCKED), send (IP-pinned), record, and the worker loop
frontend/    the React dashboard (TypeScript, Vite, TanStack Query, Tailwind)
tests/
  unit/         fast tests, no services needed
  integration/  tests against real Postgres and Redis
docs/decisions/ architecture decision records
docs/runbooks/  what to do when an alert fires
infra/observability/  Prometheus config, alert rules, Grafana dashboard
```

## Licence

[MIT](LICENSE)
