import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import type { Role, Session } from "../lib/types";

export function sessionAs(role: Role = "owner"): Session {
  return {
    user: { id: "user-1", email: "dev@example.com" },
    organizations: [{ id: "org-1", name: "Acme", role }],
  };
}

/** Render a page the way the app does: with data fetching, routing and a
 *  logged-in user. */
export function renderPage(ui: ReactElement, { role = "owner" as Role, path = "/" } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider session={sessionAs(role)}>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type Reply = { status?: number; body?: unknown };
type Handler = (call: FakeCall) => Reply;

/**
 * Replace `fetch` with a fake API. Routes are keyed by "METHOD /path" (the query
 * string is ignored). Returns the list of calls made, for assertions.
 */
export function fakeApi(routes: Record<string, Reply | Handler>): FakeCall[] {
  const calls: FakeCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = input.split("?")[0] ?? input;
      const call: FakeCall = {
        method,
        path: input,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        headers: (init.headers ?? {}) as Record<string, string>,
      };
      calls.push(call);
      const route = routes[`${method} ${path}`];
      if (!route) {
        return jsonResponse(404, { code: "not_found", message: `No fake for ${method} ${path}` });
      }
      const reply = typeof route === "function" ? route(call) : route;
      return jsonResponse(reply.status ?? 200, reply.body);
    }),
  );
  return calls;
}

export function jsonResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "req-test-1" },
  });
}
