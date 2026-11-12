import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Endpoint } from "../lib/types";
import { fakeApi, renderPage } from "../test/helpers";
import { EndpointsPage, parseEventTypes } from "./EndpointsPage";

const ENDPOINT: Endpoint = {
  id: "e1",
  url: "https://hooks.example.com/orders",
  description: "Order events",
  event_types: ["order.paid"],
  status: "active",
  rate_limit_per_sec: 5,
  breaker_state: "closed",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
};

describe("parseEventTypes", () => {
  it("splits on commas, spaces and new lines and drops blanks", () => {
    expect(parseEventTypes(" order.paid,order.refunded\n user.created ,, ")).toEqual([
      "order.paid",
      "order.refunded",
      "user.created",
    ]);
    expect(parseEventTypes("   ")).toEqual([]);
  });
});

describe("EndpointsPage", () => {
  it("explains what to do when there are no endpoints", async () => {
    fakeApi({ "GET /v1/endpoints": { body: [] }, "GET /v1/endpoints/health": { body: [] } });

    renderPage(<EndpointsPage />);

    expect(await screen.findByText("No endpoints yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add endpoint" })).not.toHaveLength(0);
  });

  it("lists endpoints with their health", async () => {
    fakeApi({
      "GET /v1/endpoints": { body: [ENDPOINT] },
      "GET /v1/endpoints/health": {
        body: [{ endpoint_id: "e1", attempts: 40, successes: 39, success_rate: 0.975, p95_ms: 180 }],
      },
    });

    renderPage(<EndpointsPage />);

    expect(await screen.findByText("https://hooks.example.com/orders")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(/order\.paid · max 5\/s/)).toBeInTheDocument();
    expect(await screen.findByText("97.5%")).toBeInTheDocument();
    expect(screen.getByText("180 ms")).toBeInTheDocument();
  });

  it("shows when the circuit breaker is holding deliveries back", async () => {
    fakeApi({
      "GET /v1/endpoints": { body: [{ ...ENDPOINT, breaker_state: "open" }] },
      "GET /v1/endpoints/health": { body: [] },
    });

    renderPage(<EndpointsPage />);

    expect(await screen.findByText("Failing: deliveries on hold")).toBeInTheDocument();
  });

  it("shows the error and its request id when loading fails, and can retry", async () => {
    let fail = true;
    fakeApi({
      "GET /v1/endpoints": () =>
        fail
          ? { status: 500, body: { code: "internal_error", message: "An unexpected error occurred.", request_id: "req-77" } }
          : { body: [ENDPOINT] },
      "GET /v1/endpoints/health": { body: [] },
    });

    renderPage(<EndpointsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("An unexpected error occurred.");
    expect(screen.getByRole("alert")).toHaveTextContent("req-77");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("https://hooks.example.com/orders")).toBeInTheDocument();
  });

  it("hides every write action from viewers", async () => {
    fakeApi({ "GET /v1/endpoints": { body: [ENDPOINT] }, "GET /v1/endpoints/health": { body: [] } });

    renderPage(<EndpointsPage />, { role: "viewer" });

    await screen.findByText("https://hooks.example.com/orders");
    for (const name of ["Add endpoint", "Edit", "Pause", "Rotate secret", "Delete"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("creates an endpoint and shows its signing secret once", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      "GET /v1/endpoints": { body: [] },
      "GET /v1/endpoints/health": { body: [] },
      "POST /v1/endpoints": { status: 201, body: { ...ENDPOINT, secret: "whsec_c2VjcmV0" } },
    });
    renderPage(<EndpointsPage />);
    await screen.findByText("No endpoints yet");

    await user.click(screen.getAllByRole("button", { name: "Add endpoint" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "Add endpoint" });
    await user.type(within(dialog).getByLabelText("URL"), "https://hooks.example.com/orders");
    await user.type(within(dialog).getByLabelText("Event types"), "order.paid, order.refunded");
    await user.type(within(dialog).getByLabelText("Rate limit (per second)"), "5");
    await user.click(within(dialog).getByRole("button", { name: "Create endpoint" }));

    const secretDialog = await screen.findByRole("dialog", { name: "Save this secret" });
    expect(within(secretDialog).getByTestId("secret-value")).toHaveTextContent("whsec_c2VjcmV0");
    expect(within(secretDialog).getByText(/shown only once/)).toBeInTheDocument();
    const post = calls.find((call) => call.method === "POST");
    expect(post?.body).toEqual({
      url: "https://hooks.example.com/orders",
      description: "",
      event_types: ["order.paid", "order.refunded"],
      rate_limit_per_sec: 5,
    });

    await user.click(within(secretDialog).getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByText("whsec_c2VjcmV0")).not.toBeInTheDocument();
  });

  it("shows the server's reason next to the URL when it is refused", async () => {
    const user = userEvent.setup();
    fakeApi({
      "GET /v1/endpoints": { body: [] },
      "GET /v1/endpoints/health": { body: [] },
      "POST /v1/endpoints": {
        status: 422,
        body: {
          code: "invalid_endpoint_url",
          message: "169.254.169.254 is blocked: link-local address (includes cloud metadata)",
        },
      },
    });
    renderPage(<EndpointsPage />);
    await screen.findByText("No endpoints yet");

    await user.click(screen.getAllByRole("button", { name: "Add endpoint" })[0]!);
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("URL"), "http://169.254.169.254/");
    await user.click(within(dialog).getByRole("button", { name: "Create endpoint" }));

    const url = within(dialog).getByLabelText("URL");
    await waitFor(() => expect(url).toHaveAttribute("aria-invalid", "true"));
    expect(url).toHaveAccessibleDescription(/169\.254\.169\.254 is blocked/);
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // the form stays open
  });

  it("asks before deleting and only deletes after confirmation", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      "GET /v1/endpoints": { body: [ENDPOINT] },
      "GET /v1/endpoints/health": { body: [] },
      "DELETE /v1/endpoints/e1": { status: 204 },
    });
    renderPage(<EndpointsPage />);
    await screen.findByText("https://hooks.example.com/orders");

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this endpoint?" });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Delete endpoint" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
  });

  it("closes a dialog with the Escape key", async () => {
    const user = userEvent.setup();
    fakeApi({ "GET /v1/endpoints": { body: [] }, "GET /v1/endpoints/health": { body: [] } });
    renderPage(<EndpointsPage />);
    await screen.findByText("No endpoints yet");

    await user.click(screen.getAllByRole("button", { name: "Add endpoint" })[0]!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
