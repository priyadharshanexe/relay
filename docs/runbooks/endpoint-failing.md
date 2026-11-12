# Runbook: an endpoint has been failing for 15 minutes

**Alert:** `RelayEndpointFailing` (notify, not a page)

## What it means

At least one endpoint's circuit breaker has been open for 15 minutes. After 5 failed deliveries in a row, Relay stops sending to that endpoint and tries one "probe" delivery every 60 seconds. The breaker closes by itself as soon as a probe succeeds.

**Customer impact:** that customer is not receiving webhooks. Nothing is lost: their deliveries are held, do not use up retry attempts while the breaker is open, and resume automatically.

This is almost always the customer's server, not Relay. The reason to act is so the customer hears it from us before they notice missing data.

## Find which endpoints

```sql
SELECT e.id, o.name AS organization, e.url, e.breaker_state,
       e.consecutive_failures, e.breaker_opened_at
FROM endpoints e
JOIN organizations o ON o.id = e.org_id
WHERE e.breaker_state <> 'closed'
ORDER BY e.breaker_opened_at;
```

## Find out why

The last few attempts say what is wrong:

```sql
SELECT a.started_at, a.status_code, a.error_kind, a.duration_ms,
       left(a.response_snippet, 120) AS response
FROM attempts a
JOIN deliveries d ON d.id = a.delivery_id
WHERE d.endpoint_id = '<endpoint id>'
ORDER BY a.started_at DESC
LIMIT 10;
```

| What you see | What it usually means | What to tell the customer |
|---|---|---|
| `http_status`, 5xx | Their server is erroring | "Your endpoint is returning HTTP 500. Here is the response body we got." |
| `http_status`, 401 or 403 | Their auth or firewall rejects us | "Your endpoint rejects our requests. Check signature verification and IP allow-lists." |
| `http_status`, 404 or 410 | The URL changed | "Your endpoint URL returns 404. Has it moved?" |
| `http_status`, 429 | They are rate-limiting us | "Your server asks us to slow down. You can set a rate limit on the endpoint." |
| `timeout` | Their server is too slow or hangs | "Your endpoint did not answer within 15 seconds. Answer first, then do the work." |
| `connect` or `dns` | Server down or DNS broken | "We cannot connect to your endpoint. Is the server up?" |
| `tls` | Certificate expired or wrong | "Your endpoint's TLS certificate is not valid." |
| `ssrf_blocked` | The URL now resolves to a private address | "Your endpoint's hostname points at a private address, which we do not deliver to." |

The same information is on the delivery's page in the dashboard (attempt timeline, response body, headers), which the customer can see too.

## Is it us?

Check before blaming the customer. It is probably us if:

- many unrelated endpoints opened at the same moment, or
- the errors are `connect`, `dns` or `tls` across several customers.

In that case look at the workers' outbound network (DNS, egress firewall, proxy settings) and treat it as an incident.

## After the customer fixes it

Nothing needs doing: the next probe succeeds, the breaker closes and held deliveries flow. To speed it up, the customer can press **Resume** on the endpoint, which resets the breaker at once.

Deliveries that ran out of attempts *before* the breaker opened are in the dead-letter queue. The customer can replay them from the dashboard (**Dead-letter queue → Replay matching**, filtered by the endpoint).

## If the endpoint is abandoned

If the customer does not respond and the endpoint has been failing for days, pause it. Its deliveries are kept, and the alert stops counting it.
