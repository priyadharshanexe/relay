import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { fakeApi, sessionAs } from "./test/helpers";

function renderApp(path = "/") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const LOGGED_OUT = {
  "GET /v1/auth/me": { status: 401, body: { code: "not_authenticated", message: "Log in." } },
  "POST /v1/auth/refresh": { status: 401, body: { code: "invalid_session", message: "Ended." } },
};
const EMPTY_DASHBOARD = {
  "GET /v1/endpoints": { body: [] },
  "GET /v1/endpoints/health": { body: [] },
};

describe("App", () => {
  it("sends a logged-out visitor to the login page", async () => {
    fakeApi(LOGGED_OUT);

    renderApp("/endpoints");

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("shows the dashboard straight after logging in", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...LOGGED_OUT,
      ...EMPTY_DASHBOARD,
      "POST /v1/auth/login": { body: sessionAs("owner") },
    });
    renderApp("/login");

    await user.type(await screen.findByLabelText("Email"), "dev@example.com");
    await user.type(screen.getByLabelText("Password"), "a long enough passphrase");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("heading", { name: "Endpoints" })).toBeInTheDocument();
    expect(screen.getByText("dev@example.com")).toBeInTheDocument();
    const login = calls.find((call) => call.path === "/v1/auth/login");
    expect(login?.body).toEqual({ email: "dev@example.com", password: "a long enough passphrase" });
  });

  it("shows the dashboard straight after signing up", async () => {
    const user = userEvent.setup();
    fakeApi({
      ...LOGGED_OUT,
      ...EMPTY_DASHBOARD,
      "POST /v1/auth/register": { status: 201, body: sessionAs("owner") },
    });
    renderApp("/register");

    await user.type(await screen.findByLabelText("Organisation name"), "Acme");
    await user.type(screen.getByLabelText("Email"), "dev@example.com");
    await user.type(screen.getByLabelText("Password"), "a long enough passphrase");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("heading", { name: "Endpoints" })).toBeInTheDocument();
  });

  it("shows a wrong-password error on the form and stays on the login page", async () => {
    const user = userEvent.setup();
    fakeApi({
      ...LOGGED_OUT,
      "POST /v1/auth/login": {
        status: 401,
        body: { code: "invalid_credentials", message: "The email or password is incorrect." },
      },
    });
    renderApp("/login");

    await user.type(await screen.findByLabelText("Email"), "dev@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The email or password is incorrect.");
    expect(screen.getByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it("shows field errors from the server when sign-up is invalid", async () => {
    const user = userEvent.setup();
    fakeApi({
      ...LOGGED_OUT,
      "POST /v1/auth/register": {
        status: 422,
        body: {
          code: "validation_error",
          message: "The request is not valid.",
          details: [{ loc: ["body", "password"], msg: "String should have at least 10 characters" }],
        },
      },
    });
    renderApp("/register");

    await user.type(await screen.findByLabelText("Organisation name"), "Acme");
    await user.type(screen.getByLabelText("Email"), "dev@example.com");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
        "String should have at least 10 characters",
      ),
    );
  });

  it("returns to the login page after logging out", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...EMPTY_DASHBOARD,
      "GET /v1/auth/me": { body: sessionAs("owner") },
      "POST /v1/auth/logout": { status: 204 },
    });
    renderApp("/endpoints");

    await user.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(calls.some((call) => call.path === "/v1/auth/logout")).toBe(true);
  });

  it("shows only the organisations the user belongs to in the switcher", async () => {
    const session = sessionAs("owner");
    session.organizations.push({ id: "org-2", name: "Second Org", role: "viewer" });
    const user = userEvent.setup();
    const calls = fakeApi({ ...EMPTY_DASHBOARD, "GET /v1/auth/me": { body: session } });
    renderApp("/endpoints");

    const switcher = await screen.findByLabelText("Organisation");
    await user.selectOptions(switcher, "Second Org");

    // Data is reloaded for the new organisation, and its role applies at once.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/v1/endpoints").at(-1)?.headers["X-Org-ID"]).toBe(
        "org-2",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Add endpoint" })).not.toBeInTheDocument(),
    );
  });
});
