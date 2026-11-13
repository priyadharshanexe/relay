import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Badge, Button } from "./ui";

const NAV = [
  { to: "/endpoints", label: "Endpoints" },
  { to: "/deliveries", label: "Deliveries" },
  { to: "/dead-letter", label: "Dead-letter queue" },
  { to: "/live", label: "Live feed" },
  { to: "/receivers", label: "Test receivers" },
  { to: "/api-keys", label: "API keys" },
  { to: "/team", label: "Team" },
];

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
      >
        R
      </span>
      <span className="text-base font-semibold text-slate-900">Relay</span>
    </div>
  );
}

export function Layout() {
  const { session, organization, switchOrganization, logout } = useAuth();
  const location = useLocation();
  // On a narrow screen the sidebar is a drawer, closed until asked for. On a
  // wide screen it is always there and this flag does nothing.
  const [menuOpen, setMenuOpen] = useState(false);

  // Choosing a page closes the drawer.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="min-h-screen md:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Skip to content
      </a>

      {/* Narrow screens only: a bar with the menu button. */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
        <Logo />
        <button
          type="button"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          onClick={() => setMenuOpen((open) => !open)}
          className="rounded-md p-2 text-slate-600 hover:bg-slate-100"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            {menuOpen ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 5.5h14M3 10h14M3 14.5h14" />}
          </svg>
        </button>
      </header>

      {menuOpen && (
        <div
          data-testid="menu-backdrop"
          className="fixed inset-0 z-30 bg-slate-900/40 md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <aside
        id="sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex w-64 max-w-[85vw] flex-col border-r border-slate-200 bg-white transition-transform duration-200 md:static md:z-auto md:w-60 md:shrink-0 md:translate-x-0 ${
          menuOpen ? "translate-x-0" : "max-md:invisible -translate-x-full"
        }`}
      >
        <div className="px-5 py-5">
          <Logo />
        </div>

        <div className="px-4 pb-4">
          <label htmlFor="org-switcher" className="mb-1 block text-xs font-medium text-slate-500">
            Organisation
          </label>
          <select
            id="org-switcher"
            value={organization.id}
            onChange={(event) => switchOrganization(event.target.value)}
            className="block w-full rounded-md border-0 bg-slate-50 px-2.5 py-1.5 text-sm text-slate-900 ring-1 ring-inset ring-slate-200"
          >
            {session.organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
          <div className="mt-2">
            <Badge tone={organization.role === "viewer" ? "slate" : "blue"}>
              {organization.role}
            </Badge>
          </div>
        </div>

        <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium ${
                  isActive
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-200 px-4 py-4">
          <p className="truncate text-sm text-slate-700" title={session.user.email}>
            {session.user.email}
          </p>
          <Button variant="ghost" size="sm" className="-ml-2 mt-1" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
