/** Layout and navigation audit: where actions live and where Back goes. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "./auth/AuthProvider";
import { MoreMenu } from "./components/MoreMenu";
import type { DeliveryDetail } from "./lib/types";
import { DeliveryDetailPage } from "./pages/DeliveryDetailPage";
import { fakeApi, sessionAs } from "./test/helpers";

describe("the More menu", () => {
  it("keeps rare and destructive actions out of sight until asked for", async () => {
    const user = userEvent.setup();
    const chosen: string[] = [];
    render(
      <MoreMenu
        label="More actions for orders"
        actions={[
          { label: "Rotate secret", onSelect: () => chosen.push("rotate") },
          { label: "Delete", onSelect: () => chosen.push("delete"), danger: true },
        ]}
      />,
    );
    const toggle = screen.getByRole("button", { name: "More actions for orders" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(chosen).toEqual(["delete"]);
    // Choosing an action closes the menu.
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<MoreMenu label="More" actions={[{ label: "Rotate secret", onSelect: () => {} }]} />);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
  });
});

const DETAIL: DeliveryDetail = {
  id: "d1",
  event_id: "e1",
  event_type: "order.paid",
  endpoint_id: "ep1",
  endpoint_url: "https://hooks.example.com/",
  status: "dead",
  attempts: 1,
  next_attempt_at: "2026-03-10T12:00:00Z",
  last_error: null,
  created_at: "2026-03-10T12:00:00Z",
  updated_at: "2026-03-10T12:00:00Z",
  payload: {},
  endpoint_status: "active",
  endpoint_breaker_state: "closed",
  attempt_log: [],
};

function renderDetailFrom(from?: string) {
  fakeApi({ "GET /v1/deliveries/d1": { body: DETAIL } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: "/deliveries/d1", state: from ? { from } : null }]}>
        <AuthProvider session={sessionAs("owner")}>
          <Routes>
            <Route path="/deliveries/:id" element={<DeliveryDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the back link on a delivery", () => {
  it("returns to the dead-letter queue when that is where you came from", async () => {
    renderDetailFrom("/dead-letter");
    expect(await screen.findByRole("link", { name: "Dead-letter queue" })).toHaveAttribute("href", "/dead-letter");
  });

  it("returns to all deliveries otherwise", async () => {
    renderDetailFrom();
    expect(await screen.findByRole("link", { name: "All deliveries" })).toHaveAttribute("href", "/deliveries");
  });
});
