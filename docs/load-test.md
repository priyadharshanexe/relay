# Load test

Measured on 2026-11-12 with [k6](https://k6.io/) against the standard `docker compose up` stack. These are baseline numbers for the default single-process configuration on a laptop, not the limits of the design.

## Machine

| | |
|---|---|
| CPU | Intel Core i5-13450HX (13th gen), 16 logical CPUs available to Docker |
| Memory | 24 GB host, 11.5 GB available to Docker |
| OS | Windows 11, Docker Desktop (Linux containers) |
| Stack | 1 API process, 1 worker process (batch 50, concurrency 20), PostgreSQL 16, Redis 7, all on the same machine |

The load generator, the API, the worker, the database and the receiver all share this one machine, and the receiver is the API's own built-in test receiver. So during a run the single API process is both accepting events and answering the worker's deliveries.

## What was measured

[tests/load/ingest.js](../tests/load/ingest.js) creates a fresh organisation with one endpoint, then N virtual users send `POST /v1/events` as fast as they can for 30 seconds. Every accepted event becomes one real, signed delivery. After the load stops, the queue is watched until it is empty.

## Results

| | 10 virtual users | 50 virtual users |
|---|---|---|
| Events accepted | 3,253 | 5,033 |
| **Ingest rate** | **108 events/s** | **165 events/s** |
| Ingest latency, median | 86 ms | 195 ms |
| **Ingest latency, p95** | **164 ms** | **870 ms** |
| Ingest latency, p99 | 207 ms | 1.34 s |
| Failed requests | 0 | 0 |
| Peak queue depth | 253 | 3,931 |
| Oldest overdue delivery, peak | 9 s | 43 s |
| Queue empty after load stopped | 17 s | 41 s |
| Peak delivery rate (1 worker) | not measured separately | 92 deliveries/s |
| Delivery duration, p95 | not measured separately | 395 ms |

### Correctness under load

Across both runs, 8,286 events were accepted. The database afterwards held **8,286 deliveries, all `succeeded`, with 8,286 attempts on 8,286 distinct deliveries**: every event delivered exactly once, none lost, none duplicated, no failed attempt.

## Reading the numbers

- **Around 100 events/s is the comfortable range for one API process**, with p95 under 200 ms and the queue never more than a few seconds behind.
- **At 50 concurrent senders the API is saturated.** Throughput only rises to 165 events/s while p95 latency grows fivefold to 870 ms. The test's own threshold (p95 under 500 ms) fails at this level, which is the honest result: this is past the knee of the curve.
- **Ingestion outruns delivery, by design.** Events were accepted at 165/s but delivered at about 92/s, so the queue grew to 3,931 and then drained in 41 seconds. Nothing was dropped and no caller was slowed down by a receiver: that is what the transactional outbox is for. The `relay_oldest_pending_age_seconds` gauge peaked at 43 s, far below the 5-minute alert threshold.
- **Delivery is limited by the receiver here, not by the worker.** The receiver is the same single API process that is busy ingesting, which is why delivery p95 was 395 ms.

## What limits throughput, and what I would do next

1. **One API process.** Ingestion is one short transaction, so it scales with processes. The next step is several API processes behind the proxy. That needs the Prometheus client's multi-process mode, because each process keeps its own counters.
2. **One worker.** Workers coordinate through `FOR UPDATE SKIP LOCKED`, so `docker compose up --scale worker=4` adds delivery capacity with no code change. Measuring that properly needs a receiver that is not the API.
3. **Connection pool of 10 (plus 10 overflow) per process.** With 50 concurrent requests, some wait for a connection; this is part of the median rising from 86 ms to 195 ms.
4. **Everything on one laptop.** A real measurement would put the load generator and the receiver on separate machines.

Further out, when PostgreSQL itself becomes the limit: partition `attempts` by month, and move the queue to a dedicated broker.

## Run it yourself

```bash
docker compose up --build --wait
docker run --rm --network relay_default -v "$PWD/tests/load:/scripts" \
  grafana/k6:2.3.0 run -e BASE_URL=http://api:8000 -e VUS=10 -e DURATION=30s /scripts/ingest.js
```

Watch it happen on the Grafana dashboard at http://localhost:3000 while it runs.
