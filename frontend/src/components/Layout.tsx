import { type ComponentType, type SVGProps, useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import {
  CloseIcon,
  DeadLetterIcon,
  DeliveriesIcon,
  EndpointsIcon,
  KeyIcon,
  LiveIcon,
  Logo,
  LogoutIcon,
  MenuIcon,
  OverviewIcon,
  ReceiverIcon,
  TeamIcon,
} from "./icons";
import { cx } from "./ui";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Delivery",
    items: [
      { to: "/overview", label: "Overview", icon: OverviewIcon },
      { to: "/endpoints", label: "Endpoints", icon: EndpointsIcon },
      { to: "/deliveries", label: "Deliveries", icon: DeliveriesIcon },
      { to: "/dead-letter", label: "Dead-letter queue", icon: DeadLetterIcon },
      { to: "/live", label: "Live feed", icon: LiveIcon },
    ],
  },
  {
    heading: "Build",
    items: [
      { to: "/receivers", label: "Test receivers", icon: ReceiverIcon },
      { to: "/api-keys", label: "API keys", icon: KeyIcon },
    ],
  },
  {
    heading: "Organisation",
    items: [{ to: "/team", label: "Team", icon: TeamIcon }],
  },
];

function initials(text: string): string {
  const words = text.trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
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
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-raised focus:px-3 focus:py-2 focus:text-sm focus:text-fg"
      >
        Skip to content
      </a>

      {/* Narrow screens only: a bar with the menu button. */}
      <header className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-line bg-canvas/85 px-4 backdrop-blur md:hidden">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="text-sm font-semibold tracking-[-0.01em]">Relay</span>
        </div>
        <button
          type="button"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          onClick={() => setMenuOpen((open) => !open)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-2 hover:bg-hover hover:text-fg"
        >
          {menuOpen ? <CloseIcon /> : <MenuIcon />}
        </button>
      </header>

      {menuOpen && (
        <div
          data-testid="menu-backdrop"
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <aside
        id="sidebar"
        className={cx(
          "fixed inset-y-0 left-0 z-40 flex w-64 max-w-[85vw] flex-col border-r border-line bg-canvas transition-transform duration-200 md:sticky md:top-0 md:z-auto md:h-screen md:w-60 md:shrink-0 md:translate-x-0",
          menuOpen ? "translate-x-0" : "-translate-x-full max-md:invisible",
        )}
      >
        <div className="flex h-14 items-center gap-2.5 px-5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-[-0.02em]">Relay</span>
        </div>

        <div className="px-3 pb-3">
          <label htmlFor="org-switcher" className="sr-only">
            Organisation
          </label>
          <div className="relative flex items-center gap-2.5 rounded-lg border border-line bg-panel px-2.5 py-2 transition-colors focus-within:border-accent-line hover:border-line-strong">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-[#2b3550] to-[#1c2236] text-2xs font-semibold text-[#a9c1ff]"
            >
              {initials(organization.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-fg">{organization.name}</p>
              <p className="text-2xs capitalize text-fg-3">{organization.role}</p>
            </div>
            <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" className="text-fg-3">
              <path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {/* The real control sits invisibly on top, so it keeps native
                keyboard and screen-reader behaviour. */}
            <select
              id="org-switcher"
              value={organization.id}
              onChange={(event) => switchOrganization(event.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {session.organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4">
          {NAV.map((group) => (
            <div key={group.heading} className="mt-4 first:mt-1">
              <p className="mb-1 px-2.5 text-2xs font-medium uppercase tracking-[0.08em] text-fg-3">
                {group.heading}
              </p>
              <ul className="space-y-px">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <li key={to}>
                    <NavLink
                      to={to}
                      className={({ isActive }) =>
                        cx(
                          "group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                          isActive
                            ? "bg-raised text-fg before:absolute before:inset-y-1.5 before:-left-3 before:w-[2px] before:rounded-full before:bg-accent"
                            : "text-fg-2 hover:bg-panel hover:text-fg",
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon className={isActive ? "text-accent" : "text-fg-3 group-hover:text-fg-2"} />
                          {label}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="flex items-center gap-2.5 border-t border-line px-4 py-3">
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-raised text-2xs font-semibold text-fg-2 ring-1 ring-line-strong"
          >
            {initials(session.user.email.replace(/@.*/, "").replace(/[._-]+/g, " "))}
          </span>
          <p className="min-w-0 flex-1 truncate text-xs text-fg-2" title={session.user.email}>
            {session.user.email}
          </p>
          <button
            type="button"
            onClick={() => void logout()}
            title="Log out"
            className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg"
          >
            <LogoutIcon width={14} height={14} />
            <span className="sr-only md:not-sr-only">Log out</span>
          </button>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-4 py-8 md:px-10 md:py-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
