import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attempt, Delivery, DeliveryDetail, LiveUpdate } from "../lib/types";
import { type FakeCall, fakeApi, renderPage } from "../test/helpers";
import { DeadLetterPage, DeliveriesPage } from "./DeliveriesPage";
import { DeliveryDetailPage } from "./DeliveryDetailPage";
import { LivePage } from "./LivePage";

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: "d1",
    event_id: "ev-1",
    event_type: "order.paid",
    endpoint_id: "e1",
    endpoint_url: "https://hooks.example.com/orders",
    status: "succeeded",
    attempts: 1,
    next_attempt_at: "2026-11-11T10:00:00Z",
    last_error: null,
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
    ...overrides,
  };
}

const ENDPOINTS = {
  "GET /v1/endpoints": {
    body: [{ id: "e1", url: "https://hooks.example.com/orders", event_types: [] }],
  },
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function lastListCall(calls: FakeCall[]): URLSearchParams {
  const call = calls.filter((c) => c.path.startsWith("/v1/deliveries")).at(-1);
  return new URLSearchParams(call?.path.split("?")[1] ?? "");
}

// --------------------------------------------------------------------- explorer
describe("DeliveriesPage", () => {
  it("lists deliveries with status, error and a link to the detail page", async () => {
    fakeApi({
      ...ENDPOINTS,
      "GET /v1/deliveries": {
        body: {
          items: [
            delivery(),
            delivery({
              id: "d2",
              status: "dead",
              attempts: 7,
              event_type: "user.created",
              last_error: "http_status: the receiver answered HTTP 500",
            }),
          ],
          next_cursor: null,
        },
      },
    });

    renderPage(<DeliveriesPage />);

    const link = await screen.findByRole("link", { name: "user.created" });
    expect(link).toHaveAttribute("href", "/deliveries/d2");
    const row = link.closest("tr")!;
    expect(within(row).getByText("Dead")).toBeInTheDocument();
    expect(within(row).getByText("http_status: the receiver answered HTTP 500")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 deliveries")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("explains the empty state when nothing has been delivered yet", async () => {
    fakeApi({ ...ENDPOINTS, "GET /v1/deliveries": { body: { items: [], next_cursor: null } } });

    renderPage(<DeliveriesPage />);

    expect(await screen.findByText("No deliveries yet")).toBeInTheDocument();
  });

  it("reads its filters from the URL, so a filtered view can be shared", async () => {
    const calls = fakeApi({
      ...ENDPOINTS,
      "GET /v1/deliveries": { body: { items: [], next_cursor: null } },
    });

    renderPage(<DeliveriesPage />, { path: "/deliveries?status=dead&event_type=order.paid" });

    expect(await screen.findByText("Nothing matches these filters")).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveValue("dead");
    expect(screen.getByLabelText("Event type")).toHaveValue("order.paid");
    const query = lastListCall(calls);
    expect(query.get("status")).toBe("dead");
    expect(query.get("event_type")).toBe("order.paid");
  });

  it("writes a changed filter into the URL and asks the API again", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...ENDPOINTS,
      "GET /v1/deliveries": { body: { items: [delivery()], next_cursor: null } },
    });
    renderPage(
      <>
        <DeliveriesPage />
        <LocationProbe />
      </>,
      { path: "/deliveries" },
    );
    await screen.findByRole("link", { name: "order.paid" });

    await user.selectOptions(screen.getByLabelText("Status"), "Retrying");
    await user.selectOptions(
      await screen.findByLabelText("Endpoint"),
      "https://hooks.example.com/orders",
    );

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/deliveries?status=retrying&endpoint_id=e1",
      ),
    );
    await waitFor(() => expect(lastListCall(calls).get("endpoint_id")).toBe("e1"));
    expect(lastListCall(calls).get("status")).toBe("retrying");
  });

  it("clears the filters", async () => {
    const user = userEvent.setup();
    fakeApi({ ...ENDPOINTS, "GET /v1/deliveries": { body: { items: [], next_cursor: null } } });
    renderPage(
      <>
        <DeliveriesPage />
        <LocationProbe />
      </>,
      { path: "/deliveries?status=dead" },
    );
    await screen.findByText("Nothing matches these filters");

    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/deliveries$/));
    expect(await screen.findByText("No deliveries yet")).toBeInTheDocument();
  });

  it("loads the next page with the cursor from the previous one", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...ENDPOINTS,
      "GET /v1/deliveries": (call) =>
        call.path.includes("cursor=page-2")
          ? { body: { items: [delivery({ id: "d2", event_type: "second.page" })], next_cursor: null } }
          : { body: { items: [delivery()], next_cursor: "page-2" } },
    });
    renderPage(<DeliveriesPage />);

    await user.click(await screen.findByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("link", { name: "second.page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "order.paid" })).toBeInTheDocument(); // page 1 stays
    expect(lastListCall(calls).get("cursor")).toBe("page-2");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument(),
    );
  });

  it("shows an error with a retry button when loading fails", async () => {
    fakeApi({
      ...ENDPOINTS,
      "GET /v1/deliveries": { status: 500, body: { code: "internal_error", message: "Broken.", request_id: "req-5" } },
    });

    renderPage(<DeliveriesPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Broken.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ dead letter
describe("DeadLetterPage", () => {
  it("always asks for dead deliveries and hides the status filter", async () => {
    const calls = fakeApi({
      ...ENDPOINTS,
      "GET /v1/deliveries": { body: { items: [delivery({ status: "dead" })], next_cursor: null } },
    });

    renderPage(<DeadLetterPage />, { path: "/dead-letter?status=succeeded" });

    await screen.findByRole("link", { name: "order.paid" });
    expect(lastListCall(calls).get("status")).toBe("dead"); // the URL cannot override it
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
  });

  it("replays in bulk only after confirmation, using the current filters", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...ENDPOINTS,
      "GET /v1/deliveries": { body: { items: [delivery({ status: "dead" })], next_cursor: null } },
      "POST /v1/deliveries/replay": { body: { replayed: 3 } },
    });
    renderPage(<DeadLetterPage />, { path: "/dead-letter?endpoint_id=e1" });
    await screen.findByRole("link", { name: "order.paid" });

    await user.click(screen.getByRole("button", { name: "Replay matching" }));
    const dialog = screen.getByRole("dialog");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Replay" }));

    expect(await screen.findByRole("status")).toHaveTextContent("3 deliveries queued for replay.");
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toMatchObject({ status: "dead", endpoint_id: "e1", event_type: null });
  });

  it("says so when the queue is empty", async () => {
    fakeApi({ ...ENDPOINTS, "GET /v1/deliveries": { body: { items: [], next_cursor: null } } });

    renderPage(<DeadLetterPage />);

    expect(await screen.findByText("The dead-letter queue is empty")).toBeInTheDocument();
  });

  it("does not offer bulk replay to viewers", async () => {
    fakeApi({ ...ENDPOINTS, "GET /v1/deliveries": { body: { items: [], next_cursor: null } } });

    renderPage(<DeadLetterPage />, { role: "viewer" });

    await screen.findByText("The dead-letter queue is empty");
    expect(screen.queryByRole("button", { name: /Replay/ })).not.toBeInTheDocument();
  });
});

// ----------------------------------------------------------------------- detail
function attempt(number: number, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: `a${number}`,
    attempt_number: number,
    started_at: `2026-11-11T10:0${number}:00Z`,
    duration_ms: 120,
    status_code: 500,
    error_kind: "http_status",
    response_snippet: "boom",
    request_headers: { "webhook-id": "ev-1", "webhook-signature": "v1,abcdef****" },
    response_headers: { "content-type": "text/plain" },
    ...overrides,
  };
}

function detail(overrides: Partial<DeliveryDetail> = {}): DeliveryDetail {
  return {
    ...delivery({ status: "dead", attempts: 2, last_error: "http_status: the receiver answered HTTP 500" }),
    payload: { order_id: 42 },
    attempt_log: [attempt(1), attempt(2)],
    ...overrides,
  };
}

function renderDetail(role: "owner" | "viewer" = "owner") {
  return renderPage(
    <Routes>
      <Route path="/deliveries/:id" element={<DeliveryDetailPage />} />
    </Routes>,
    { path: "/deliveries/d1", role },
  );
}

describe("DeliveryDetailPage", () => {
  it("shows the attempt timeline, the payload and the last error", async () => {
    fakeApi({ "GET /v1/deliveries/d1": { body: detail() } });

    renderDetail();

    expect(await screen.findByText("Attempt 1")).toBeInTheDocument();
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();
    expect(screen.getAllByText("HTTP 500")).toHaveLength(2);
    expect(screen.getByText(/60 s after the\s+previous attempt/)).toBeInTheDocument();
    expect(screen.getByText("http_status: the receiver answered HTTP 500")).toBeInTheDocument();
    expect(screen.getByText(/"order_id": 42/)).toBeInTheDocument();
  });

  it("reveals masked request headers and the response on demand", async () => {
    const user = userEvent.setup();
    fakeApi({ "GET /v1/deliveries/d1": { body: detail({ attempt_log: [attempt(1)] }) } });
    renderDetail();

    const toggle = await screen.findByRole("button", { name: "Show request and response" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    expect(screen.getByText("v1,abcdef****")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
  });

  it("describes an attempt that never got an HTTP response", async () => {
    fakeApi({
      "GET /v1/deliveries/d1": {
        body: detail({ attempt_log: [attempt(1, { status_code: null, error_kind: "timeout" })] }),
      },
    });

    renderDetail();

    expect(await screen.findByText("Timed out")).toBeInTheDocument();
  });

  it("replays a dead delivery and reloads it", async () => {
    const user = userEvent.setup();
    let replayed = false;
    const calls = fakeApi({
      "GET /v1/deliveries/d1": () => ({
        body: replayed ? detail({ status: "pending", attempts: 0, last_error: null }) : detail(),
      }),
      "POST /v1/deliveries/d1/replay": () => {
        replayed = true;
        return { body: delivery({ status: "pending", attempts: 0 }) };
      },
    });
    renderDetail();

    await user.click(await screen.findByRole("button", { name: "Replay" }));

    expect(await screen.findByText(/Queued for replay/)).toBeInTheDocument();
    expect(await screen.findByText("Pending")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    // The history is kept: both earlier attempts are still listed.
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();
  });

  it("disables replay while the delivery is still on its way", async () => {
    fakeApi({ "GET /v1/deliveries/d1": { body: detail({ status: "retrying" }) } });

    renderDetail();

    expect(await screen.findByRole("button", { name: "Replay" })).toBeDisabled();
    expect(screen.getByText(/Still on its way/)).toBeInTheDocument();
  });

  it("hides replay from viewers", async () => {
    fakeApi({ "GET /v1/deliveries/d1": { body: detail() } });

    renderDetail("viewer");

    await screen.findByText("Attempt 1");
    expect(screen.queryByRole("button", { name: "Replay" })).not.toBeInTheDocument();
  });

  it("explains a delivery that does not exist", async () => {
    fakeApi({
      "GET /v1/deliveries/d1": { status: 404, body: { code: "delivery_not_found", message: "No such delivery." } },
    });

    renderDetail();

    expect(await screen.findByText(/does not exist, or belongs to another organisation/)).toBeInTheDocument();
  });
});

// -------------------------------------------------------------------- live feed
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  emit(update: Partial<LiveUpdate>) {
    this.listeners.get("delivery.attempt")?.({ data: JSON.stringify(update) } as MessageEvent<string>);
  }
  emitRaw(data: string) {
    this.listeners.get("delivery.attempt")?.({ data } as MessageEvent<string>);
  }
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }
}

function liveUpdate(overrides: Partial<LiveUpdate> = {}): LiveUpdate {
  return {
    type: "delivery.attempt",
    delivery_id: "d1",
    event_id: "ev-1",
    event_type: "order.paid",
    endpoint_id: "e1",
    status: "succeeded",
    attempt: 1,
    status_code: 200,
    error_kind: null,
    duration_ms: 42,
    at: "2026-11-11T10:00:00Z",
    ...overrides,
  };
}

describe("LivePage", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  const source = () => FakeEventSource.instances.at(-1)!;

  it("subscribes to the current organisation's stream", () => {
    renderPage(<LivePage />);

    expect(source().url).toBe("/v1/stream/deliveries?org_id=org-1");
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
    expect(screen.getByText("Waiting for deliveries…")).toBeInTheDocument();
  });

  it("shows updates as they arrive, newest first", () => {
    renderPage(<LivePage />);
    act(() => source().open());
    expect(screen.getByRole("status")).toHaveTextContent("Live");

    act(() => source().emit(liveUpdate()));
    act(() =>
      source().emit(
        liveUpdate({
          delivery_id: "d2",
          event_type: "user.created",
          status: "retrying",
          status_code: 500,
          error_kind: "http_status",
          at: "2026-11-11T10:00:05Z",
        }),
      ),
    );

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByRole("link", { name: "user.created" })).toHaveAttribute(
      "href",
      "/deliveries/d2",
    );
    expect(within(rows[0]!).getByText("HTTP 500")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Retrying")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("HTTP 200")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("42 ms")).toBeInTheDocument();
  });

  it("ignores a malformed message instead of breaking", () => {
    renderPage(<LivePage />);
    act(() => source().open());

    act(() => source().emitRaw("{not json"));
    act(() => source().emit(liveUpdate()));

    expect(screen.getAllByRole("row")).toHaveLength(2); // header + the one good update
  });

  it("pauses (closing the stream) and resumes with a new one", async () => {
    const user = userEvent.setup();
    renderPage(<LivePage />);
    const first = source();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(first.closed).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Paused");

    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(source().closed).toBe(false);
  });

  it("clears the list", async () => {
    const user = userEvent.setup();
    renderPage(<LivePage />);
    act(() => source().emit(liveUpdate()));

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.getByText("Waiting for deliveries…")).toBeInTheDocument();
  });

  it("refreshes the session and reconnects after the server closes the stream", async () => {
    vi.useFakeTimers();
    try {
      const calls = fakeApi({ "GET /v1/auth/me": { body: {} } });
      renderPage(<LivePage />);
      const first = source();

      act(() => first.fail(FakeEventSource.CLOSED)); // e.g. the session token expired
      expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });

      expect(calls.some((call) => call.path === "/v1/auth/me")).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(2);
      expect(first.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the browser retry by itself after a network blip", () => {
    renderPage(<LivePage />);

    act(() => source().fail(FakeEventSource.CONNECTING));

    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
    expect(FakeEventSource.instances).toHaveLength(1); // no second stream opened
  });

  it("closes the stream when the page is left", () => {
    const view = renderPage(<LivePage />);
    const opened = source();

    view.unmount();

    expect(opened.closed).toBe(true);
  });
});
