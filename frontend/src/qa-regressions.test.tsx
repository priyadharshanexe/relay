/**
 * Regression tests for bugs found by clicking through the running app.
 * Each test is named after what a person saw go wrong.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ApiError, fieldErrors } from "./lib/api";
import type { DeliveryDetail, Endpoint } from "./lib/types";
import {
  emailAddress,
  eventTypes,
  newPassword,
  optionalRateLimit,
  requiredText,
  webhookUrl,
} from "./lib/validate";
import { ApiKeysPage, usageExample } from "./pages/ApiKeysPage";
import { DebouncedInput, DeliveriesPage } from "./pages/DeliveriesPage";
import { DeliveryDetailPage, holdReason } from "./pages/DeliveryDetailPage";
import { EndpointsPage } from "./pages/EndpointsPage";
import { LivePage } from "./pages/LivePage";
import { ReceiversPage } from "./pages/ReceiversPage";
import { type FakeCall, fakeApi, renderPage, sessionAs } from "./test/helpers";

const LOGGED_OUT = {
  "GET /v1/auth/me": { status: 401, body: { code: "not_authenticated", message: "Log in." } },
  "POST /v1/auth/refresh": { status: 401, body: { code: "invalid_session", message: "Ended." } },
};

function renderApp(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Assembled from parts so that it is obviously not a real credential.
const FAKE_KEY = ["rly", "test", "abcd1234", "EXAMPLE"].join("_");

const posts = (calls: FakeCall[]) => calls.filter((call) => call.method === "POST");

const ENDPOINT: Endpoint = {
  id: "e1",
  url: "https://hooks.example.com/orders",
  description: "",
  event_types: [],
  status: "active",
  rate_limit_per_sec: null,
  breaker_state: "closed",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
};

// ----------------------------------------------------------- 1: login, sign-up
describe("login and sign-up check the form before sending it", () => {
  it("an empty login form shows what is missing and sends nothing", async () => {
    const user = userEvent.setup();
    const calls = fakeApi(LOGGED_OUT);
    renderApp("/login");

    await user.click(await screen.findByRole("button", { name: "Log in" }));

    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter your email address.");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription("Enter your password.");
    expect(screen.queryByText("The request is not valid.")).not.toBeInTheDocument();
    expect(posts(calls).filter((call) => call.path === "/v1/auth/login")).toHaveLength(0);
  });

  it("a malformed email is caught in the browser", async () => {
    const user = userEvent.setup();
    const calls = fakeApi(LOGGED_OUT);
    renderApp("/login");

    await user.type(await screen.findByLabelText("Email"), "not-an-email");
    await user.type(screen.getByLabelText("Password"), "x");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(/valid email address/);
    expect(posts(calls).filter((call) => call.path === "/v1/auth/login")).toHaveLength(0);
  });

  it("an empty sign-up form names every missing field", async () => {
    const user = userEvent.setup();
    const calls = fakeApi(LOGGED_OUT);
    renderApp("/register");

    await user.click(await screen.findByRole("button", { name: "Create account" }));

    expect(screen.getByLabelText("Organisation name")).toHaveAccessibleDescription(
      "Enter the name of your organisation.",
    );
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Enter your email address.");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription("Choose a password.");
    expect(posts(calls).filter((call) => call.path === "/v1/auth/register")).toHaveLength(0);
  });

  it("an organisation name of only spaces is refused, and sent trimmed otherwise", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...LOGGED_OUT,
      "POST /v1/auth/register": { status: 201, body: sessionAs("owner") },
      "GET /v1/endpoints": { body: [] },
      "GET /v1/endpoints/health": { body: [] },
    });
    renderApp("/register");

    await user.type(await screen.findByLabelText("Organisation name"), "   ");
    await user.type(screen.getByLabelText("Email"), "dev@example.com");
    await user.type(screen.getByLabelText("Password"), "a long enough passphrase");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByLabelText("Organisation name")).toHaveAccessibleDescription(
      "Enter the name of your organisation.",
    );
    expect(posts(calls).filter((call) => call.path === "/v1/auth/register")).toHaveLength(0);

    await user.type(screen.getByLabelText("Organisation name"), "Acme  ");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByRole("heading", { name: "Endpoints" });
    const sent = calls.find((call) => call.path === "/v1/auth/register");
    expect(sent?.body).toMatchObject({ organization_name: "Acme" });
  });
});

// --------------------------------------------------------------- 2: request id
describe("the request id is shown only when the failure is ours", () => {
  it("is hidden for a wrong password", async () => {
    const user = userEvent.setup();
    fakeApi({
      ...LOGGED_OUT,
      "POST /v1/auth/login": {
        status: 401,
        body: { code: "invalid_credentials", message: "The email or password is incorrect.", request_id: "req-123" },
      },
    });
    renderApp("/login");

    await user.type(await screen.findByLabelText("Email"), "dev@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The email or password is incorrect.");
    expect(alert).not.toHaveTextContent("req-123");
    expect(alert).not.toHaveTextContent("Request ID");
  });

  it("is shown for a server error", async () => {
    fakeApi({
      "GET /v1/endpoints": { status: 500, body: { code: "internal_error", message: "Broken.", request_id: "req-500" } },
      "GET /v1/endpoints/health": { body: [] },
    });

    renderPage(<EndpointsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Request ID: req-500");
  });
});

// ----------------------------------------------- 4 and 5: server field messages
describe("server validation messages", () => {
  const error = (details: unknown) => new ApiError(422, "validation_error", "Not valid.", details);

  it.each([
    [{ loc: ["body", "name"], msg: "String should have at least 1 character", type: "string_too_short" }, "name", "This is required."],
    [{ loc: ["body", "password"], msg: "String should have at least 10 characters", type: "string_too_short" }, "password", "Use at least 10 characters."],
    [{ loc: ["body", "name"], msg: "String should have at most 200 characters", type: "string_too_long" }, "name", "Use at most 200 characters."],
    [{ loc: ["body", "name"], msg: "Field required", type: "missing" }, "name", "This is required."],
    [{ loc: ["body", "rate_limit_per_sec"], msg: "Input should be greater than or equal to 1", type: "greater_than_equal" }, "rate_limit_per_sec", "Enter 1 or more."],
    [{ loc: ["body", "email"], msg: "value is not a valid email address: no @", type: "value_error" }, "email", "Enter a valid email address, like name@example.com."],
  ])("are rewritten for people: %o", (detail, field, expected) => {
    expect(fieldErrors(error([detail]))).toEqual({ [field]: expected });
  });

  it("an error on one item of a list is shown on the list's field", () => {
    const result = fieldErrors(
      error([{ loc: ["body", "event_types", 1], msg: "String should match pattern", type: "string_pattern_mismatch" }]),
    );

    expect(Object.keys(result)).toEqual(["event_types"]);
    expect(result.event_types).toMatch(/characters that are not allowed/);
  });

  it("keeps the first message when a field has several", () => {
    const result = fieldErrors(
      error([
        { loc: ["body", "name"], msg: "Field required", type: "missing" },
        { loc: ["body", "name"], msg: "another", type: "other" },
      ]),
    );

    expect(result).toEqual({ name: "This is required." });
  });
});

describe("browser-side checks", () => {
  it("validates each kind of field", () => {
    expect(requiredText("   ", "a name")).toBe("Enter a name.");
    expect(requiredText(" x ", "a name")).toBeUndefined();
    expect(emailAddress("a@b.co")).toBeUndefined();
    expect(emailAddress("a@b")).toMatch(/valid email/);
    expect(newPassword("123456789")).toBe("Use at least 10 characters.");
    expect(newPassword("1234567890")).toBeUndefined();
    expect(webhookUrl("example.com/hook")).toMatch(/must start with https/);
    expect(webhookUrl("https://example.com/hook")).toBeUndefined();
    expect(webhookUrl("  ")).toMatch(/Enter the URL/);
    expect(eventTypes(["order.paid", "paid!"])).toMatch(/"paid!" is not a valid event type/);
    expect(eventTypes(["order.paid", "user_created-v2"])).toBeUndefined();
    expect(optionalRateLimit("")).toBeUndefined();
    expect(optionalRateLimit("5")).toBeUndefined();
    expect(optionalRateLimit("-5")).toMatch(/whole number of 1 or more/);
    expect(optionalRateLimit("1.5")).toMatch(/whole number/);
  });
});

describe("the endpoint form", () => {
  it("reports every problem at once, in plain words, without calling the server", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({ "GET /v1/endpoints": { body: [] }, "GET /v1/endpoints/health": { body: [] } });
    renderPage(<EndpointsPage />);
    await screen.findByText("No endpoints yet");

    await user.click(screen.getAllByRole("button", { name: "Add endpoint" })[0]!);
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("URL"), "example.com/hook");
    await user.type(within(dialog).getByLabelText("Event types"), "order.paid, paid!");
    await user.type(within(dialog).getByLabelText("Rate limit (per second)"), "-5");
    await user.click(within(dialog).getByRole("button", { name: "Create endpoint" }));

    expect(within(dialog).getByLabelText("URL")).toHaveAccessibleDescription(/must start with https/);
    expect(within(dialog).getByLabelText("Event types")).toHaveAccessibleDescription(
      /"paid!" is not a valid event type/,
    );
    expect(within(dialog).getByLabelText("Rate limit (per second)")).toHaveAccessibleDescription(
      /whole number of 1 or more/,
    );
    expect(within(dialog).queryByText(/String should/)).not.toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
  });

  it("an empty URL says what to enter", async () => {
    const user = userEvent.setup();
    fakeApi({ "GET /v1/endpoints": { body: [] }, "GET /v1/endpoints/health": { body: [] } });
    renderPage(<EndpointsPage />);
    await screen.findByText("No endpoints yet");

    await user.click(screen.getAllByRole("button", { name: "Add endpoint" })[0]!);
    await user.click(screen.getByRole("button", { name: "Create endpoint" }));

    expect(screen.getByLabelText("URL")).toHaveAccessibleDescription(
      "Enter the URL that should receive your events.",
    );
  });
});

// ------------------------------------------------------- 6: show-once secrets
describe("a secret that is shown once cannot be closed by accident", () => {
  async function createEndpoint() {
    const user = userEvent.setup();
    fakeApi({
      "GET /v1/endpoints": { body: [] },
      "GET /v1/endpoints/health": { body: [] },
      "POST /v1/endpoints": { status: 201, body: { ...ENDPOINT, secret: "whsec_c2VjcmV0" } },
    });
    renderPage(<EndpointsPage />);
    await screen.findByText("No endpoints yet");
    await user.click(screen.getAllByRole("button", { name: "Add endpoint" })[0]!);
    await user.type(screen.getByLabelText("URL"), "https://hooks.example.com/orders");
    await user.click(screen.getByRole("button", { name: "Create endpoint" }));
    return { user, dialog: await screen.findByRole("dialog", { name: "Save this secret" }) };
  }

  it("stays open on Escape and on a click outside, and has no close icon", async () => {
    const { user, dialog } = await createEndpoint();

    await user.keyboard("{Escape}");
    await user.click(dialog.parentElement!); // the dimmed area around the dialog

    expect(screen.getByTestId("secret-value")).toHaveTextContent("whsec_c2VjcmV0");
    expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("closes with its own button", async () => {
    const { user, dialog } = await createEndpoint();

    await user.click(within(dialog).getByRole("button", { name: "I have saved it" }));

    expect(screen.queryByText("whsec_c2VjcmV0")).not.toBeInTheDocument();
  });

  it("the same holds for a new API key, which also shows how to use it", async () => {
    const user = userEvent.setup();
    fakeApi({
      "GET /v1/api-keys": { body: [] },
      "POST /v1/api-keys": {
        status: 201,
        body: { id: "k1", name: "orders", prefix: "rly_test_abcd1234", key: FAKE_KEY, last_used_at: null, revoked_at: null, created_at: "2026-11-11T10:00:00Z" },
      },
    });
    renderPage(<ApiKeysPage />);
    await screen.findByText("No API keys yet");

    await user.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
    await user.type(screen.getByLabelText("Name"), "orders");
    await user.click(screen.getByRole("button", { name: "Create key" }));
    const dialog = await screen.findByRole("dialog", { name: "Save this API key" });
    await user.keyboard("{Escape}");

    expect(within(dialog).getByTestId("secret-value")).toHaveTextContent(FAKE_KEY);
    const example = within(dialog).getByTestId("usage-example");
    expect(example).toHaveTextContent(`Authorization: Bearer ${FAKE_KEY}`);
    expect(example).toHaveTextContent("/v1/events");
  });

  it("the usage example is a complete command", () => {
    const example = usageExample("rly_test_KEY");

    expect(example).toContain("curl -X POST");
    expect(example).toContain("Idempotency-Key");
    expect(example).toContain('"type": "order.paid"');
  });
});

describe("names are required in the browser", () => {
  it("an API key needs a name", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({ "GET /v1/api-keys": { body: [] } });
    renderPage(<ApiKeysPage />);
    await screen.findByText("No API keys yet");

    await user.click(screen.getAllByRole("button", { name: "Create API key" })[0]!);
    await user.type(screen.getByLabelText("Name"), "   ");
    await user.click(screen.getByRole("button", { name: "Create key" }));

    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription("Enter a name for the key.");
    expect(posts(calls)).toHaveLength(0);
  });

  it("a test receiver needs a name", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({ "GET /v1/receivers": { body: [] } });
    renderPage(<ReceiversPage />);
    await screen.findByText("No test receivers yet");

    await user.click(screen.getAllByRole("button", { name: "Create test receiver" })[0]!);
    await user.click(screen.getByRole("button", { name: "Create receiver" }));

    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      "Enter a name for the receiver.",
    );
    expect(posts(calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------- 7 and 8: endpoints page
describe("the endpoints page", () => {
  it("the test-event confirmation disappears after a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      fakeApi({
        "GET /v1/endpoints": { body: [ENDPOINT] },
        "GET /v1/endpoints/health": { body: [] },
        "POST /v1/endpoints/e1/test": { status: 202, body: { event_id: "ev1" } },
      });
      renderPage(<EndpointsPage />);

      await user.click(await screen.findByRole("button", { name: "Send test event" }));
      expect(await screen.findByText(/Test event queued\. See it under Deliveries\./)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4500);
      });
      expect(screen.queryByText(/Test event queued/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a test event for a paused endpoint will wait", async () => {
    const user = userEvent.setup();
    fakeApi({
      "GET /v1/endpoints": { body: [{ ...ENDPOINT, status: "paused" }] },
      "GET /v1/endpoints/health": { body: [] },
      "POST /v1/endpoints/e1/test": { status: 202, body: { event_id: "ev1" } },
    });
    renderPage(<EndpointsPage />);

    await user.click(await screen.findByRole("button", { name: "Send test event" }));

    expect(await screen.findByText(/sent when this endpoint is resumed/)).toBeInTheDocument();
  });

  it("refreshes by itself, so a breaker that opens shows up without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let failing = false;
      fakeApi({
        "GET /v1/endpoints": () => ({ body: [{ ...ENDPOINT, breaker_state: failing ? "open" : "closed" }] }),
        "GET /v1/endpoints/health": { body: [] },
      });
      renderPage(<EndpointsPage />);
      expect(await screen.findByText("Active")).toBeInTheDocument();

      failing = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });

      expect(await screen.findByText("Failing: deliveries on hold")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------- 9: typing in a filter
describe("the event type filter", () => {
  function Probe() {
    const location = useLocation();
    return <output data-testid="location">{location.pathname + location.search}</output>;
  }

  beforeEach(() => {
    fakeApi({
      "GET /v1/endpoints": { body: [] },
      "GET /v1/deliveries": { body: { items: [], next_cursor: null } },
    });
  });

  it("keeps every character that is typed", async () => {
    const user = userEvent.setup();
    renderPage(
      <>
        <DeliveriesPage />
        <Probe />
      </>,
      { path: "/deliveries" },
    );

    const input = await screen.findByLabelText("Event type");
    await user.type(input, "relay.test");

    expect(input).toHaveValue("relay.test");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/deliveries?event_type=relay.test"),
    );
    expect(input).toHaveValue("relay.test");
  });

  it("does not ask the server on every keystroke", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      "GET /v1/endpoints": { body: [] },
      "GET /v1/deliveries": { body: { items: [], next_cursor: null } },
    });
    renderPage(<DeliveriesPage />, { path: "/deliveries" });
    const input = await screen.findByLabelText("Event type");
    const before = calls.filter((call) => call.path.startsWith("/v1/deliveries")).length;

    await user.type(input, "order.paid");
    await waitFor(() =>
      expect(calls.some((call) => call.path.includes("event_type=order.paid"))).toBe(true),
    );

    const after = calls.filter((call) => call.path.startsWith("/v1/deliveries")).length;
    expect(after - before).toBeLessThanOrEqual(2); // not ten, one per letter
  });

  it("empties when the filters are cleared", async () => {
    const user = userEvent.setup();
    renderPage(<DeliveriesPage />, { path: "/deliveries?event_type=order.paid" });
    const input = await screen.findByLabelText("Event type");
    expect(input).toHaveValue("order.paid");

    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);

    await waitFor(() => expect(input).toHaveValue(""));
  });
});

describe("typing while the URL catches up", () => {
  /** A parent like the real page, except that its "URL" takes a while to
   *  update, as it does in a real browser. */
  function SlowUrl({ lagMs }: { lagMs: number }) {
    const [url, setUrl] = useState("");
    return (
      <>
        <DebouncedInput
          aria-label="Event type"
          value={url}
          delayMs={300}
          onCommit={(next) => setTimeout(() => setUrl(next), lagMs)}
        />
        <output data-testid="url">{url}</output>
        <button type="button" onClick={() => setUrl("")}>
          Clear
        </button>
      </>
    );
  }

  it("keeps characters typed after a pause, while the earlier write is still on its way", async () => {
    vi.useFakeTimers();
    try {
      render(<SlowUrl lagMs={200} />);
      const input = screen.getByLabelText("Event type");
      const type = (text: string) =>
        act(() => {
          fireEvent.change(input, { target: { value: text } });
        });
      const wait = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });

      type("ord");
      await wait(350); // typing paused: "ord" is being written to the URL...
      type("orde"); // ...and the user carries on before the URL has changed
      type("order");
      await wait(250); // the URL now reports "ord"

      // The old bug: the box snapped back to "ord" here and lost "er".
      expect(input).toHaveValue("order");

      await wait(1000);
      expect(input).toHaveValue("order");
      expect(screen.getByTestId("url")).toHaveTextContent("order");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still follows a change made elsewhere, such as Clear filters", async () => {
    vi.useFakeTimers();
    try {
      render(<SlowUrl lagMs={0} />);
      const input = screen.getByLabelText("Event type");
      act(() => {
        fireEvent.change(input, { target: { value: "order.paid" } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(screen.getByTestId("url")).toHaveTextContent("order.paid");

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      });

      expect(input).toHaveValue("");
    } finally {
      vi.useRealTimers();
    }
  });
});

// --------------------------------------------- 10 and 14: delivery detail page
describe("a waiting delivery explains why it is waiting", () => {
  const base: DeliveryDetail = {
    id: "d1",
    event_id: "ev-1",
    event_type: "order.paid",
    endpoint_id: "e1",
    endpoint_url: "https://hooks.example.com/orders",
    status: "pending",
    attempts: 0,
    next_attempt_at: "2026-11-11T10:01:00Z",
    last_error: null,
    created_at: "2026-11-11T10:00:00Z",
    updated_at: "2026-11-11T10:00:00Z",
    payload: {},
    endpoint_status: "active",
    endpoint_breaker_state: "closed",
    attempt_log: [],
  };

  it.each([
    [{ endpoint_breaker_state: "open" as const }, /has been failing/],
    [{ endpoint_breaker_state: "half_open" as const }, /has been failing/],
    [{ endpoint_status: "paused" as const }, /endpoint is paused/],
    [{ endpoint_status: "disabled" as const }, /endpoint is disabled/],
  ])("%o", (override, expected) => {
    expect(holdReason({ ...base, ...override })).toMatch(expected);
  });

  it("says nothing for an ordinary wait or a finished delivery", () => {
    expect(holdReason(base)).toBeNull();
    expect(holdReason({ ...base, status: "succeeded", endpoint_breaker_state: "open" })).toBeNull();
    expect(holdReason({ ...base, status: "dead", endpoint_status: "paused" })).toBeNull();
  });

  it("shows the reason on the page, and errors without their internal code", async () => {
    fakeApi({
      "GET /v1/deliveries/d1": {
        body: {
          ...base,
          status: "retrying",
          endpoint_breaker_state: "open",
          last_error: "http_status: the receiver answered HTTP 500",
        },
      },
    });

    renderPage(
      <Routes>
        <Route path="/deliveries/:id" element={<DeliveryDetailPage />} />
      </Routes>,
      { path: "/deliveries/d1" },
    );

    expect(await screen.findByText(/On hold\./)).toBeInTheDocument();
    expect(screen.getByText(/does not use up retry attempts/)).toBeInTheDocument();
    expect(screen.getByText("The receiver answered HTTP 500")).toBeInTheDocument();
    expect(screen.queryByText(/http_status:/)).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------- 11: live feed
describe("the live feed", () => {
  class FakeEventSource {
    static last: FakeEventSource;
    static readonly CLOSED = 2;
    readyState = 1;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private listener: ((event: MessageEvent<string>) => void) | null = null;
    constructor(readonly url: string) {
      FakeEventSource.last = this;
    }
    addEventListener(_type: string, listener: (event: MessageEvent<string>) => void) {
      this.listener = listener;
    }
    close() {}
    emit(data: object) {
      this.listener?.({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }

  it("shows which endpoint each attempt went to", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    fakeApi({ "GET /v1/endpoints": { body: [ENDPOINT] } });
    renderPage(<LivePage />);
    await waitFor(() => expect(FakeEventSource.last).toBeDefined());
    const update = {
      type: "delivery.attempt",
      delivery_id: "d1",
      event_id: "ev1",
      event_type: "order.paid",
      status: "succeeded",
      attempt: 1,
      status_code: 200,
      error_kind: null,
      duration_ms: 12,
      at: "2026-11-11T10:00:00Z",
    };

    act(() => FakeEventSource.last.emit({ ...update, endpoint_id: "e1" }));
    act(() => FakeEventSource.last.emit({ ...update, delivery_id: "d2", endpoint_id: "gone" }));

    expect(await screen.findByText("https://hooks.example.com/orders")).toBeInTheDocument();
    expect(screen.getByText("(deleted endpoint)")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Endpoint" })).toBeInTheDocument();
  });
});

// ------------------------------------------------------- 17: logout everywhere
describe("logging out in one tab logs out the others", () => {
  const DASHBOARD = {
    "GET /v1/auth/me": { body: sessionAs("owner") },
    "GET /v1/endpoints": { body: [] },
    "GET /v1/endpoints/health": { body: [] },
  };

  it("a logout signal from another tab shows the login page here", async () => {
    fakeApi(DASHBOARD);
    renderApp("/endpoints");
    await screen.findByRole("heading", { name: "Endpoints" });

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "relay.loggedOutAt", newValue: String(Date.now()) }),
      );
    });

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("unrelated storage changes are ignored", async () => {
    fakeApi(DASHBOARD);
    renderApp("/endpoints");
    await screen.findByRole("heading", { name: "Endpoints" });

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "something.else", newValue: "1" }));
    });

    expect(screen.getByRole("heading", { name: "Endpoints" })).toBeInTheDocument();
  });

  it("logging out here leaves the signal for the other tabs", async () => {
    const user = userEvent.setup();
    fakeApi({ ...DASHBOARD, "POST /v1/auth/logout": { status: 204 } });
    renderApp("/endpoints");

    await user.click(await screen.findByRole("button", { name: "Log out" }));

    await screen.findByRole("heading", { name: "Log in" });
    expect(localStorage.getItem("relay.loggedOutAt")).not.toBeNull();
  });

  it("the live feed stops and shows the login page once the session is gone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      class ClosingEventSource {
        static last: ClosingEventSource;
        static count = 0;
        static readonly CLOSED = 2;
        readyState = 1;
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(readonly url: string) {
          ClosingEventSource.last = this;
          ClosingEventSource.count += 1;
        }
        addEventListener() {}
        close() {}
      }
      vi.stubGlobal("EventSource", ClosingEventSource);
      let loggedIn = true;
      fakeApi({
        "GET /v1/auth/me": () =>
          loggedIn
            ? { body: sessionAs("owner") }
            : { status: 401, body: { code: "not_authenticated", message: "Log in." } },
        "POST /v1/auth/refresh": { status: 401, body: { code: "invalid_session", message: "Ended." } },
        "GET /v1/endpoints": { body: [] },
      });
      renderApp("/live");
      await screen.findByRole("heading", { name: "Live feed" });

      loggedIn = false; // logged out in another browser, say
      act(() => {
        ClosingEventSource.last.readyState = ClosingEventSource.CLOSED;
        ClosingEventSource.last.onerror?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3500);
      });

      expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
      expect(ClosingEventSource.count).toBe(1); // it did not keep reconnecting
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------- 19: a broken delivery link
describe("a mistyped delivery link", () => {
  it("says the delivery does not exist, with nothing to retry", async () => {
    fakeApi({
      "GET /v1/deliveries/not-a-real-id": {
        status: 422,
        body: { code: "validation_error", message: "The request is not valid." },
      },
    });

    renderPage(
      <Routes>
        <Route path="/deliveries/:id" element={<DeliveryDetailPage />} />
      </Routes>,
      { path: "/deliveries/not-a-real-id" },
    );

    expect(await screen.findByText(/does not exist, or belongs to another organisation/)).toBeInTheDocument();
    expect(screen.queryByText("The request is not valid.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All deliveries/ })).toBeInTheDocument();
  });
});
