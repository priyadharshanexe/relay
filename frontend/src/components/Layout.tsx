import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Badge, Button } from "./ui";

const NAV = [
  { to: "/endpoints", label: "Endpoints" },
  { to: "/receivers", label: "Test receivers" },
  { to: "/api-keys", label: "API keys" },
];

export function Layout() {
  const { session, organization, switchOrganization, logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-10 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Skip to content
      </a>

      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 px-5 py-5">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white"
          >
            R
          </span>
          <span className="text-base font-semibold text-slate-900">Relay</span>
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

        <nav aria-label="Main" className="flex-1 space-y-0.5 px-3">
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

      <main id="main" className="min-w-0 flex-1 px-8 py-8">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
