/**
 * Team management, invitations, the one-click endpoint for a test receiver, and
 * the menu on a narrow screen.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { Layout } from "./components/Layout";
import type { Invitation, InvitationInfo, Member, Receiver, Session } from "./lib/types";
import { ReceiversPage } from "./pages/ReceiversPage";
import { TeamPage } from "./pages/TeamPage";
import { type FakeCall, fakeApi, renderPage, sessionAs } from "./test/helpers";

const LOGGED_OUT = {
  "GET /v1/auth/me": { status: 401, body: { code: "not_authenticated", message: "Log in." } },
  "POST /v1/auth/refresh": { status: 401, body: { code: "invalid_session", message: "Ended." } },
};
const EMPTY_DASHBOARD = {
  "GET /v1/endpoints": { body: [] },
  "GET /v1/endpoints/health": { body: [] },
};

const ME: Member = {
  user_id: "user-1",
  email: "dev@example.com",
  role: "owner",
  joined_at: "2026-01-01T00:00:00Z",
};
const SAM: Member = {
  user_id: "user-2",
  email: "sam@example.com",
  role: "developer",
  joined_at: "2026-02-01T00:00:00Z",
};
const PENDING: Invitation = {
  id: "inv-1",
  email: "new@example.com",
  role: "viewer",
  expires_at: "2030-01-01T00:00:00Z",
  created_at: "2026-03-01T00:00:00Z",
};
const INFO: InvitationInfo = {
  organization_name: "Globex",
  email: "dev@example.com",
  role: "developer",
  expires_at: "2030-01-01T00:00:00Z",
};
const TEAM = {
  "GET /v1/orgs/current/members": { body: [ME, SAM] },
  "GET /v1/orgs/current/invitations": { body: [PENDING] },
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

function sent(calls: FakeCall[], method: string): FakeCall[] {
  return calls.filter((call) => call.method === method);
}

beforeEach(() => localStorage.clear());

// ------------------------------------------------------------------------ team
describe("the team page", () => {
  it("lets an owner see and manage members and invitations", async () => {
    fakeApi(TEAM);
    renderPage(<TeamPage />);

    expect(await screen.findByLabelText("Role of sam@example.com")).toHaveValue("developer");
    expect(screen.getByLabelText("Role of dev@example.com")).toHaveValue("owner");
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(await screen.findByText("new@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite someone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it.each(["developer", "viewer"] as const)("shows a %s the team, read-only", async (role) => {
    const calls = fakeApi(TEAM);
    renderPage(<TeamPage />, { role });

    expect(await screen.findByText("sam@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Role of sam@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite someone" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    // The invitation list is for owners: it is not even requested.
    expect(calls.some((call) => call.path.includes("invitations"))).toBe(false);
  });

  it("changes a member's role", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...TEAM,
      "PATCH /v1/orgs/current/members/user-2": { body: { ...SAM, role: "viewer" } },
    });
    renderPage(<TeamPage />);

    await user.selectOptions(await screen.findByLabelText("Role of sam@example.com"), "viewer");

    await waitFor(() => expect(sent(calls, "PATCH")).toHaveLength(1));
    expect(sent(calls, "PATCH")[0]?.body).toEqual({ role: "viewer" });
  });

  it("explains why the last owner cannot be demoted", async () => {
    const user = userEvent.setup();
    fakeApi({
      ...TEAM,
      "PATCH /v1/orgs/current/members/user-1": {
        status: 409,
        body: {
          code: "last_owner",
          message: "An organisation needs at least one owner. Make someone else an owner first.",
        },
      },
    });
    renderPage(<TeamPage />);

    await user.selectOptions(await screen.findByLabelText("Role of dev@example.com"), "viewer");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An organisation needs at least one owner.",
    );
    expect(screen.getByLabelText("Role of dev@example.com")).toHaveValue("owner");
  });

  it("removes a member only after confirming", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({ ...TEAM, "DELETE /v1/orgs/current/members/user-2": { status: 204 } });
    renderPage(<TeamPage />);

    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog", { name: "Remove this member?" });
    expect(dialog).toHaveTextContent("sam@example.com");
    expect(sent(calls, "DELETE")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Remove member" }));

    await waitFor(() => expect(sent(calls, "DELETE")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("calls removing yourself what it is: leaving", async () => {
    const user = userEvent.setup();
    fakeApi(TEAM);
    renderPage(<TeamPage />);

    await user.click(await screen.findByRole("button", { name: "Leave" }));

    expect(screen.getByRole("dialog", { name: "Leave this organisation?" })).toBeInTheDocument();
  });

  it("renames the organisation and reloads the session that shows the name", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...TEAM,
      "PATCH /v1/orgs/current": { body: { id: "org-1", name: "Acme Payments", role: "owner" } },
      "GET /v1/auth/me": { body: sessionAs("owner") },
    });
    renderPage(<TeamPage />);

    await user.click(await screen.findByRole("button", { name: "Rename" }));
    const input = screen.getByLabelText("Organisation name");
    expect(input).toHaveValue("Acme");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save name" }));
    expect(input).toHaveAccessibleDescription("Enter a name for the organisation.");
    expect(sent(calls, "PATCH")).toHaveLength(0);

    await user.type(input, "  Acme Payments ");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() => expect(sent(calls, "PATCH")[0]?.body).toEqual({ name: "Acme Payments" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("creates an invitation and shows its link exactly once", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...TEAM,
      "POST /v1/orgs/current/invitations": {
        status: 201,
        body: { ...PENDING, id: "inv-2", email: "kim@example.com", token: "tok-123" },
      },
    });
    renderPage(<TeamPage />);

    await user.click(await screen.findByRole("button", { name: "Invite someone" }));
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(
      "Enter the email address of the person to invite.",
    );
    await user.type(screen.getByLabelText("Email"), "kim@");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(
      "Enter a valid email address, like name@example.com.",
    );
    expect(sent(calls, "POST")).toHaveLength(0);

    await user.type(screen.getByLabelText("Email"), "example.com");
    await user.selectOptions(screen.getByLabelText("Role"), "viewer");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));

    const dialog = await screen.findByRole("dialog", { name: "Send this invitation link" });
    expect(sent(calls, "POST")[0]?.body).toEqual({ email: "kim@example.com", role: "viewer" });
    expect(within(dialog).getByTestId("secret-value")).toHaveTextContent(
      `${window.location.origin}/invite/tok-123`,
    );
    // A stray Escape must not throw the link away.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Send this invitation link" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByText(/tok-123/)).not.toBeInTheDocument();
  });

  it("says so when the person is already in the team", async () => {
    const user = userEvent.setup();
    fakeApi({
      ...TEAM,
      "POST /v1/orgs/current/invitations": {
        status: 409,
        body: { code: "already_member", message: "This person is already in the organisation." },
      },
    });
    renderPage(<TeamPage />);

    await user.click(await screen.findByRole("button", { name: "Invite someone" }));
    await user.type(screen.getByLabelText("Email"), "sam@example.com");
    await user.click(screen.getByRole("button", { name: "Create invitation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This person is already in the organisation.",
    );
  });

  it("revokes an invitation after confirming", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      ...TEAM,
      "DELETE /v1/orgs/current/invitations/inv-1": { status: 204 },
    });
    renderPage(<TeamPage />);

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Revoke invitation" }));

    await waitFor(() => expect(sent(calls, "DELETE")).toHaveLength(1));
  });
});

// ----------------------------------------------------------------- invitations
describe("an invitation link", () => {
  it("tells a logged-out visitor what it is for and how to accept", async () => {
    fakeApi({ ...LOGGED_OUT, "GET /v1/invitations/tok-1": { body: INFO } });

    renderApp("/invite/tok-1");

    expect(await screen.findByRole("heading", { name: "Join Globex" })).toBeInTheDocument();
    expect(screen.getByText("dev@example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/register?invite=tok-1",
    );
    expect(screen.getByRole("link", { name: "I already have an account" })).toHaveAttribute(
      "href",
      "/login?invite=tok-1",
    );
  });

  it("says so when the link is no longer valid", async () => {
    fakeApi({
      ...LOGGED_OUT,
      "GET /v1/invitations/old": {
        status: 404,
        body: {
          code: "invitation_not_found",
          message: "This invitation link is not valid any more.",
        },
      },
    });

    renderApp("/invite/old");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invitation link is not valid any more.",
    );
    expect(screen.getByRole("link", { name: "Go to log in" })).toBeInTheDocument();
  });

  it("signs an invited person up without asking for an organisation", async () => {
    const user = userEvent.setup();
    const joined: Session = {
      user: { id: "user-9", email: "dev@example.com" },
      organizations: [{ id: "org-2", name: "Globex", role: "developer" }],
    };
    const calls = fakeApi({
      ...LOGGED_OUT,
      ...EMPTY_DASHBOARD,
      "GET /v1/invitations/tok-1": { body: INFO },
      "POST /v1/auth/register": { status: 201, body: joined },
    });
    renderApp("/register?invite=tok-1");

    expect(await screen.findByRole("heading", { name: "Join Globex" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Organisation name")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("dev@example.com");
    expect(screen.getByLabelText("Email")).toHaveAttribute("readonly");

    await user.type(screen.getByLabelText("Password"), "a long enough passphrase");
    await user.click(screen.getByRole("button", { name: "Create account and join" }));

    expect(await screen.findByRole("heading", { name: "Endpoints" })).toBeInTheDocument();
    const register = calls.find((call) => call.path === "/v1/auth/register");
    expect(register?.body).toEqual({
      email: "dev@example.com",
      password: "a long enough passphrase",
      invitation_token: "tok-1",
    });
    expect(localStorage.getItem("relay.orgId")).toBe("org-2");
  });

  it("lets the invited person join with one click when logged in", async () => {
    const user = userEvent.setup();
    let joined = false;
    const before = sessionAs("owner");
    const after: Session = {
      ...before,
      organizations: [...before.organizations, { id: "org-2", name: "Globex", role: "developer" }],
    };
    const calls = fakeApi({
      ...EMPTY_DASHBOARD,
      "GET /v1/auth/me": () => ({ body: joined ? after : before }),
      "GET /v1/invitations/tok-1": { body: INFO },
      "POST /v1/invitations/tok-1/accept": () => {
        joined = true;
        return { body: { id: "org-2", name: "Globex", role: "developer" } };
      },
    });
    renderApp("/invite/tok-1");

    await user.click(await screen.findByRole("button", { name: "Join Globex" }));

    expect(await screen.findByRole("heading", { name: "Endpoints" })).toBeInTheDocument();
    // The dashboard opens on the organisation just joined.
    expect(screen.getByLabelText("Organisation")).toHaveValue("org-2");
    const endpoints = calls.filter((call) => call.path === "/v1/endpoints").at(-1);
    expect(endpoints?.headers["X-Org-ID"]).toBe("org-2");
  });

  it("explains when you are logged in as someone else", async () => {
    fakeApi({
      "GET /v1/auth/me": { body: sessionAs("owner") },
      "GET /v1/invitations/tok-1": { body: { ...INFO, email: "other@example.com" } },
    });

    renderApp("/invite/tok-1");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You are logged in as dev@example.com.",
    );
    expect(screen.queryByRole("button", { name: /^Join/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("comes back to the invitation after logging in", async () => {
    const user = userEvent.setup();
    fakeApi({
      ...LOGGED_OUT,
      "GET /v1/invitations/tok-1": { body: INFO },
      "POST /v1/auth/login": { body: sessionAs("owner") },
    });
    renderApp("/login?invite=tok-1");

    expect(await screen.findByRole("note")).toHaveTextContent("Log in to accept your invitation.");
    await user.type(screen.getByLabelText("Email"), "dev@example.com");
    await user.type(screen.getByLabelText("Password"), "a long enough passphrase");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("button", { name: "Join Globex" })).toBeInTheDocument();
  });
});

describe("someone removed from their only organisation", () => {
  it("is told what happened and can log out", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      "GET /v1/auth/me": { body: { ...sessionAs("owner"), organizations: [] } },
      "POST /v1/auth/logout": { status: 204 },
    });
    renderApp("/endpoints");

    expect(
      await screen.findByRole("heading", { name: "You are not in any organisation" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(calls.some((call) => call.path === "/v1/auth/logout")).toBe(true);
  });
});

describe("someone removed while the dashboard is open", () => {
  it("is moved off the organisation as soon as a request says it is gone", async () => {
    fakeApi({
      // The page was loaded while they still belonged to the organisation...
      "GET /v1/auth/me": { body: { ...sessionAs("owner"), organizations: [] } },
      // ...and the next request finds that they no longer do.
      "GET /v1/orgs/current/members": {
        status: 404,
        body: { code: "organization_not_found", message: "No such organisation." },
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["session"], sessionAs("owner"));
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/team"]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "You are not in any organisation" }),
    ).toBeInTheDocument();
  });
});

// ------------------------------------------------------------- narrow screens
describe("the menu on a narrow screen", () => {
  function renderLayout() {
    return renderPage(
      <Routes>
        <Route element={<Layout />}>
          <Route path="/endpoints" element={<h1>Endpoints page</h1>} />
          <Route path="/team" element={<h1>Team page</h1>} />
        </Route>
      </Routes>,
      { path: "/endpoints" },
    );
  }

  it("opens and closes with the menu button, the backdrop and Escape", async () => {
    const user = userEvent.setup();
    renderLayout();
    const button = screen.getByRole("button", { name: "Open menu" });
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await user.click(screen.getByTestId("menu-backdrop"));
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
  });

  it("closes when a page is chosen", async () => {
    const user = userEvent.setup();
    renderLayout();

    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.click(screen.getByRole("link", { name: "Team" }));

    expect(await screen.findByRole("heading", { name: "Team page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

// ------------------------------------------------------------- test receivers
describe("a test receiver", () => {
  const RECEIVER: Receiver = {
    id: "rec-1",
    name: "Flaky customer",
    url: "http://api:8000/receiver/abc",
    mode: "ok",
    status_code: 200,
    delay_ms: 0,
    retry_after_seconds: 0,
    requests_received: 0,
    last_received_at: null,
    created_at: "2026-01-01T00:00:00Z",
  };

  it("gets an endpoint with one click, and the secret is shown once", async () => {
    const user = userEvent.setup();
    const calls = fakeApi({
      "GET /v1/receivers": { body: [RECEIVER] },
      "GET /v1/endpoints": { body: [] },
      "POST /v1/endpoints": { status: 201, body: { id: "ep-1", url: RECEIVER.url, secret: "whsec_abc" } },
    });
    renderPage(<ReceiversPage />);

    await user.click(await screen.findByRole("button", { name: "Create endpoint" }));

    const dialog = await screen.findByRole("dialog", { name: "Endpoint created" });
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      url: "http://api:8000/receiver/abc",
      description: "Test receiver: Flaky customer",
    });
    expect(within(dialog).getByTestId("secret-value")).toHaveTextContent("whsec_abc");
    await user.click(within(dialog).getByRole("button", { name: "I have saved it" }));
    expect(screen.queryByText("whsec_abc")).not.toBeInTheDocument();
  });

  it("shows that an endpoint already delivers to it, instead of offering another", async () => {
    fakeApi({
      "GET /v1/receivers": { body: [RECEIVER] },
      "GET /v1/endpoints": { body: [{ id: "ep-1", url: RECEIVER.url }] },
    });
    renderPage(<ReceiversPage />);

    expect(await screen.findByText("Endpoint connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create endpoint" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View endpoints" })).toHaveAttribute(
      "href",
      "/endpoints",
    );
  });

  it("does not offer a viewer the button", async () => {
    fakeApi({ "GET /v1/receivers": { body: [RECEIVER] }, "GET /v1/endpoints": { body: [] } });
    renderPage(<ReceiversPage />, { role: "viewer" });

    expect(await screen.findByText(/No endpoint delivers here yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create endpoint" })).not.toBeInTheDocument();
  });
});
