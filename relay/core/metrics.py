"""Prometheus metrics.

Prometheus *pulls*: every few seconds it requests ``/metrics`` from each process
and stores the numbers it finds. So each process only has to keep counters in
memory and print them on request; it never pushes anything anywhere.

Three kinds are used here:

* **Counter**: only ever goes up (events ingested). You graph its *rate*.
* **Histogram**: counts observations in buckets (delivery duration), from which
  Prometheus estimates percentiles such as p95.
* **Gauge**: a value that goes up and down (queue depth). These are read from the
  database at scrape time, because the queue's state lives there, not in any one
  process.

Labels are kept to small, fixed sets (result, route, status). Putting an endpoint
id or an organisation id in a label would create one time series per customer and
overwhelm Prometheus; per-customer detail belongs in the database and the logs.
"""

from prometheus_client import Counter, Gauge, Histogram

# ---------------------------------------------------------------------- ingest
EVENTS_INGESTED = Counter(
    "relay_events_ingested",
    "Events accepted by POST /v1/events (idempotent replays are not counted).",
)

# -------------------------------------------------------------------- delivery
DELIVERY_ATTEMPTS = Counter(
    "relay_delivery_attempts",
    "Delivery attempts made, by result: success, or the kind of error.",
    ["result"],
)
DELIVERY_DURATION = Histogram(
    "relay_delivery_duration_seconds",
    "Time one delivery attempt took, from sending the request to reading the response.",
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30),
)
DELIVERIES_FINISHED = Counter(
    "relay_deliveries_finished",
    "Deliveries that reached a final state: succeeded, or dead (out of attempts).",
    ["outcome"],
)
DELIVERIES_POSTPONED = Counter(
    "relay_deliveries_postponed",
    "Deliveries put back in the queue without using an attempt, by reason.",
    ["reason"],
)
LEASES_RECOVERED = Counter(
    "relay_leases_recovered",
    "Deliveries re-queued because the worker holding them stopped responding.",
)

# ----------------------------------------------------------------------- queue
QUEUE_DEPTH = Gauge(
    "relay_queue_depth",
    "Deliveries that are not finished yet, by status.",
    ["status"],
)
OLDEST_PENDING_AGE = Gauge(
    "relay_oldest_pending_age_seconds",
    "How overdue the most overdue deliverable delivery is. Near zero when workers keep up.",
)
BREAKER_OPEN_ENDPOINTS = Gauge(
    "relay_breaker_open_endpoints",
    "Endpoints whose circuit breaker is open or half-open (deliveries on hold).",
)

# ------------------------------------------------------------------------ HTTP
HTTP_REQUESTS = Counter(
    "relay_http_requests",
    "API requests handled, by method, route template and status code.",
    ["method", "route", "status"],
)
HTTP_REQUEST_DURATION = Histogram(
    "relay_http_request_duration_seconds",
    "Time the API took to answer, by method and route template.",
    ["method", "route"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
)

QUEUE_STATUSES = ("pending", "retrying", "in_flight")
