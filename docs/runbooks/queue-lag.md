# Runbook: webhook deliveries are running late

**Alerts:** `RelayQueueLagging` (page), `RelayTargetDown` (page)

## What it means

A delivery that could be sent right now has been waiting more than 5 minutes, and this has been true for 10 minutes. Workers are not keeping up with the queue, or are not running at all.

**Customer impact:** webhooks arrive late. Nothing is lost: every delivery is a row in PostgreSQL and will be sent once workers catch up.

The alert only counts deliveries that are *due* and belong to an *active* endpoint. Deliveries waiting on a retry delay, a paused endpoint or an open circuit breaker do not trigger it.

## First 5 minutes

1. Open the **Relay overview** dashboard in Grafana and look at three panels:

   | Panel | What to look for |
   |---|---|
   | Oldest overdue delivery | Still climbing, or already falling? |
   | Queue depth by status | Is `pending` growing? Is anything `in_flight`? |
   | Delivery attempts by result | Are any attempts happening at all? |

2. Check that workers are running:

   ```bash
   docker compose ps worker
   docker compose logs --tail 100 worker
   ```

3. Decide which case you are in:

   | Attempts happening? | `in_flight` | Most likely cause | Go to |
   |---|---|---|---|
   | No | 0 | Workers are down or cannot reach the database | A |
   | No | Stuck above 0 | Workers died holding leases | B |
   | Yes, but queue still grows | Above 0 | More events than workers can send | C |
   | Yes, slowly | Above 0 | Receivers are slow, every attempt hits the timeout | D |

## A. Workers are down or cannot reach the database

Look in the worker log for `worker.claim_failed` (database unreachable) or a crash on start-up (bad configuration).

```bash
curl -s http://localhost:8000/readyz          # is the database up for the API?
docker compose up -d worker                   # start workers again
```

A worker that restarts needs no clean-up: it simply claims whatever is due.

## B. Workers died while holding deliveries

Deliveries claimed by a dead worker stay `in_flight` until their lease (60 s) expires. Then any running worker re-queues them automatically and logs `worker.recovered_expired_leases`. The **Postponed and recovered** panel shows this.

If `in_flight` stays above zero for more than two minutes with workers running, look at who holds the leases:

```sql
SELECT locked_by, count(*), min(locked_until) AS first_expiry
FROM deliveries
WHERE status = 'in_flight'
GROUP BY locked_by;
```

A `first_expiry` in the past with workers running means the sweeper is not running: restart the workers.

## C. More events than the workers can send

Confirm with the ingest rate (**Events ingested**) against the finish rate (**Deliveries finished**). If ingest is steadily higher, add workers:

```bash
docker compose up -d --scale worker=4
```

Workers coordinate through `FOR UPDATE SKIP LOCKED`, so they can be added and removed freely; no two workers ever take the same delivery.

Then find out who is sending the load:

```sql
SELECT org_id, count(*) AS events
FROM events
WHERE created_at > now() - interval '15 minutes'
GROUP BY org_id
ORDER BY events DESC
LIMIT 5;
```

## D. Receivers are slow

If **Delivery duration** p95 is close to the 15 s timeout, slow receivers are holding worker slots. Find them:

```sql
SELECT e.url, count(*) AS attempts, round(avg(a.duration_ms)) AS avg_ms
FROM attempts a
JOIN deliveries d ON d.id = a.delivery_id
JOIN endpoints e ON e.id = d.endpoint_id
WHERE a.started_at > now() - interval '15 minutes'
GROUP BY e.url
ORDER BY avg_ms DESC
LIMIT 5;
```

Their circuit breakers will open after 5 consecutive failures and take the pressure off. If one endpoint is hurting everyone before that happens, pause it from the dashboard (its deliveries are kept and resume later) and contact the customer.

## When it is over

- The **Oldest overdue delivery** panel returns to near zero and the alert resolves by itself.
- Note what the cause was and how long deliveries were delayed.
- If the cause was C, raise the default number of workers.
