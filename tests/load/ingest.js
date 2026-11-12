// k6 load test: how fast can Relay accept events, and how fast does it deliver them?
//
// Run it against the Docker stack (see docs/load-test.md):
//
//   docker run --rm --network relay_default -v "$PWD/tests/load:/scripts" \
//     grafana/k6:2.3.0 run -e BASE_URL=http://api:8000 /scripts/ingest.js
//
// setup() creates a fresh organisation with one endpoint pointing at a built-in
// test receiver, so every accepted event also becomes one real delivery.

import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8000";
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || "30s";

const accepted = new Counter("events_accepted");

export const options = {
  scenarios: {
    ingest: { executor: "constant-vus", vus: VUS, duration: DURATION },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"], // under 1% errors
    "http_req_duration{name:ingest}": ["p(95)<500"], // 95% of requests under 500 ms
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

const JSON_HEADERS = { "Content-Type": "application/json" };

function post(path, body, headers) {
  const response = http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: Object.assign({}, JSON_HEADERS, headers || {}),
  });
  if (response.status >= 300) {
    throw new Error(`${path} -> ${response.status}: ${response.body}`);
  }
  return response;
}

export function setup() {
  const email = `load-${Date.now()}@example.com`;
  const registered = post("/v1/auth/register", {
    email,
    password: "load-test-passphrase",
    organization_name: "Load test",
  });
  // The session comes back as cookies; pass them on explicitly.
  const cookie = Object.keys(registered.cookies)
    .map((name) => `${name}=${registered.cookies[name][0].value}`)
    .join("; ");
  const session = { Cookie: cookie };

  const apiKey = post("/v1/api-keys", { name: "load" }, session).json("key");
  const receiverUrl = post("/v1/receivers", { name: "load receiver" }, session).json("url");
  post("/v1/endpoints", { url: receiverUrl }, session);
  return { apiKey };
}

export default function (data) {
  const response = http.post(
    `${BASE_URL}/v1/events`,
    JSON.stringify({
      type: "order.paid",
      payload: { order_id: __ITER, vu: __VU, amount: 1999, currency: "INR" },
    }),
    {
      headers: Object.assign({ Authorization: `Bearer ${data.apiKey}` }, JSON_HEADERS),
      tags: { name: "ingest" },
    },
  );
  if (check(response, { "event accepted (201)": (r) => r.status === 201 })) {
    accepted.add(1);
  }
}
