/** The Overview page, its charts, and the JSON inspector. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { JsonView } from "./components/JsonView";
import { niceMax } from "./components/charts";
import type { Endpoint } from "./lib/types";
import { gap } from "./pages/DeliveryDetailPage";
import { OverviewPage } from "./pages/OverviewPage";
import { emptyOverview, fakeApi, renderPage } from "./test/helpers";

const ENDPOINT: Endpoint = {
  id: "e1",
  url: "https://hooks.example.com/orders",
  description: "Orders service",
  event_types: [],
  status: "active",
  rate_limit_per_sec: null,
  breaker_state: "closed",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function busyOverview() {
  const data = emptyOverview();
  data.buckets[22] = { ...data.buckets[22]!, succeeded: 8, failed: 2, p95_ms: 120 };
  data.buckets[23] = { ...data.buckets[23]!, succeeded: 30, failed: 0, p95_ms: 80 };
  return {
    ...data,
    endpoints: [
      {
        endpoint_id: "e1",
        succeeded: [...Array(22).fill(0), 8, 30],
        failed: [...Array(22).fill(0), 2, 0],
      },
    ],
    deliveries_by_status: { pending: 1, in_flight: 0, retrying: 2, succeeded: 37, dead: 3 },
    events: 25,
    attempts: 40,
    successes: 38,
    success_rate: 0.95,
    p95_ms: 110,
  };
}

describe("the overview", () => {
  it("shows the key figures, the charts and the busiest endpoints", async () => {
    fakeApi({
      "GET /v1/stats/overview": { body: busyOverview() },
      "GET /v1/endpoints": { body: [ENDPOINT] },
    });
    renderPage(<OverviewPage />);

    const rate = (await screen.findByText("Success rate")).closest("dl");
    expect(rate).toHaveTextContent("95.0%");
    expect(rate).toHaveTextContent("38 of 40 attempts");
    expect(screen.getByText("110 ms")).toBeInTheDocument();
    expect(screen.getByText("3 more still on their way")).toBeInTheDocument();
    // Dead letters link straight to the queue.
    expect(screen.getByRole("link", { name: /Dead letters/ })).toHaveAttribute("href", "/dead-letter");

    // Each chart says in words what it shows.
    expect(screen.getByText("40 delivery attempts in the last 24 hours, 2 of them failed.")).toBeInTheDocument();
    expect(screen.getByText(/highest 120 ms/)).toBeInTheDocument();

    // Endpoints are named by their description, with the URL beneath.
    const list = screen.getByRole("region", { name: "Endpoints by activity" });
    expect(within(list).getByText("Orders service")).toBeInTheDocument();
    expect(within(list).getByText("https://hooks.example.com/orders")).toBeInTheDocument();
    expect(within(list).getByRole("img", { name: "40 attempts in 24 hours, 2 failed" })).toBeInTheDocument();
  });

  it("shows how to get started when nothing has been delivered", async () => {
    fakeApi({
      "GET /v1/stats/overview": { body: emptyOverview() },
      "GET /v1/endpoints": { body: [] },
    });
    renderPage(<OverviewPage />);

    expect(await screen.findByRole("heading", { name: "Send your first webhook" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create a test receiver/ })).toHaveAttribute("href", "/receivers");
    expect(screen.queryByText(/delivery attempts in the last 24 hours/)).not.toBeInTheDocument();
  });

  it("explains a failure to load, and can retry", async () => {
    fakeApi({
      "GET /v1/stats/overview": { status: 500, body: { code: "internal_error", message: "Something broke." } },
      "GET /v1/endpoints": { body: [] },
    });
    renderPage(<OverviewPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Something broke.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("the JSON inspector", () => {
  const payload = {
    order_id: 42,
    paid: true,
    note: null,
    customer: { name: "Ada", tags: ["vip", "beta"] },
    lines: [],
  };

  it("shows every value with its key", () => {
    render(<JsonView value={payload} />);
    const view = screen.getByTestId("json-view");
    expect(view).toHaveTextContent('"order_id": 42');
    expect(view).toHaveTextContent('"paid": true');
    expect(view).toHaveTextContent('"note": null');
    expect(view).toHaveTextContent('"name": "Ada"');
    expect(view).toHaveTextContent('"lines": []');
  });

  it("folds and unfolds objects, showing what a folded one holds", async () => {
    const user = userEvent.setup();
    render(<JsonView value={payload} />);

    await user.click(screen.getByRole("button", { name: "Fold customer" }));

    const view = screen.getByTestId("json-view");
    expect(view).not.toHaveTextContent('"name": "Ada"');
    expect(view).toHaveTextContent("2 keys");
    await user.click(screen.getByRole("button", { name: "Unfold customer" }));
    expect(view).toHaveTextContent('"name": "Ada"');
  });

  it("starts deep levels folded, so a big payload opens readable", () => {
    render(<JsonView value={{ a: { b: { c: { d: 1 } } } }} />);
    expect(screen.getByRole("button", { name: "Unfold c" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("json-view")).toHaveTextContent("1 key");
  });

  it("can copy the whole payload", () => {
    render(<JsonView value={payload} />);
    expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
  });
});

describe("chart and timeline helpers", () => {
  it.each([
    [0, 4],
    [3, 4],
    [7, 8],
    [23, 25],
    [140, 150],
    [1000, 1000],
  ])("rounds an axis maximum of %i up to %i", (value, expected) => {
    expect(niceMax(value)).toBe(expected);
  });

  it.each([
    [30, "30 s"],
    [60, "1 min"],
    [95, "1 min 35 s"],
    [600, "10 min"],
    [3600, "1 h"],
    [23_400, "6.5 h"],
    [86_400, "24 h"],
  ])("describes a %i second wait as %s", (seconds, expected) => {
    expect(gap(seconds)).toBe(expected);
  });
});
