import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { motion } from "motion/react";
import { useTheme } from "../lib/theme";
import { SPRING } from "./motionkit";
import { CloseIcon, Logo, LogoutIcon, MenuIcon, MoonIcon, SunIcon } from "./icons";
import { cx } from "./ui";

/** Tabs in two groups: watching deliveries, then setting things up. */
const TABS: { to: string; label: string }[][] = [
  [
    { to: "/overview", label: "Overview" },
    { to: "/endpoints", label: "Endpoints" },
    { to: "/deliveries", label: "Deliveries" },
    { to: "/dead-letter", label: "Dead-letter queue" },
    { to: "/live", label: "Live feed" },
  ],
  [
    { to: "/receivers", label: "Test receivers" },
    { to: "/api-keys", label: "API keys" },
    { to: "/team", label: "Team" },
  ],
];

export function ThemeButton() {
  const [theme, toggle] = useTheme();
  const other = theme === "dark" ? "light" : "dark";
  const Icon = theme === "dark" ? MoonIcon : SunIcon;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${other} theme`}
      title={`Switch to ${other} theme`}
      className="flex h-8 items-center gap-2 rounded-[5px] px-2 text-xs text-fg-2 transition-colors hover:bg-hover hover:text-fg"
    >
      {/* Keyed so the icon turns in when the theme changes. */}
      <Icon key={theme} className="animate-pop" />
      <span className="md:sr-only">{theme === "dark" ? "Dark" : "Light"} theme</span>
    </button>
  );
}

export function Layout() {
  const { session, organization, switchOrganization, logout } = useAuth();
  const location = useLocation();
  // On a phone the account controls (theme, email, log out) fold into a menu
  // under the top bar. On wider screens they sit in the bar and this does nothing.
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 4);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  // Choosing a page closes the menu.
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
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-panel focus:px-3 focus:py-2 focus:text-sm focus:text-fg focus:shadow-pop"
      >
        Skip to content
      </a>

      <header
        className={cx(
          // Solid, so nothing shows through it; the hairline appears once the page scrolls.
          "sticky top-0 z-30 border-b bg-canvas transition-colors duration-200",
          scrolled ? "border-line" : "border-transparent",
        )}
      >
        {/* The top bar: wordmark, organisation, account. */}
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 md:px-8">
          <Link to="/overview" className="flex shrink-0 items-center gap-2 rounded-md" aria-label="Relay home">
            <Logo />
            <span className="hidden text-lg font-semibold tracking-[-0.03em] sm:inline" style={{ fontFamily: "var(--font-display)" }}>
              Relay
            </span>
          </Link>
          <span aria-hidden="true" className="hidden text-xl font-light text-line-strong sm:inline">
            /
          </span>

          <label htmlFor="org-switcher" className="sr-only">
            Organisation
          </label>
          <div className="relative flex min-w-0 items-center gap-2 rounded-[5px] px-2 py-1.5 transition-colors hover:bg-hover">
            <span className="truncate text-[13px] font-medium text-fg">{organization.name}</span>
            <span className="hidden shrink-0 rounded-[4px] border border-line-strong px-1.5 text-2xs capitalize text-fg-2 sm:inline">
              {organization.role}
            </span>
            <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" className="shrink-0 text-fg-3">
              <path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {/* The real control lies transparently over the label, so it keeps
                native keyboard and screen-reader behaviour, and its list opens
                right under it. */}
            <select
              id="org-switcher"
              data-overlay=""
              value={organization.id}
              onChange={(event) => switchOrganization(event.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-[5px] border-0 bg-transparent text-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {session.organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1" />

          <button
            type="button"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="account-menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-9 w-9 items-center justify-center rounded-md text-fg-2 hover:bg-hover hover:text-fg md:hidden"
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>

          {/* Account controls: inline in the bar on wide screens, a menu on phones. */}
          <div
            id="account-menu"
            className={cx(
              "flex items-center gap-1",
              "max-md:absolute max-md:inset-x-0 max-md:top-14 max-md:z-40 max-md:flex-col max-md:items-stretch max-md:gap-1 max-md:border-b max-md:border-line max-md:bg-panel max-md:p-3 max-md:shadow-pop",
              menuOpen ? "max-md:animate-rise" : "max-md:hidden",
            )}
          >
            <ThemeButton />
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-line max-md:hidden" />
            <p className="max-w-56 truncate px-2 text-xs text-fg-2 max-md:py-2" title={session.user.email}>
              {session.user.email}
            </p>
            <button
              type="button"
              onClick={() => void logout()}
              className="flex h-8 items-center gap-1.5 rounded-[5px] px-2 text-xs text-fg-2 transition-colors hover:bg-hover hover:text-fg"
            >
              <LogoutIcon width={14} height={14} />
              Log out
            </button>
          </div>
        </div>

        {/* The tabs. On a phone they scroll sideways inside this strip. */}
        <nav aria-label="Main" className="mx-auto max-w-6xl overflow-x-auto px-2 md:px-6 [scrollbar-width:none]">
          <ul className="flex min-w-max items-center">
            {TABS.map((group, groupIndex) => (
              <li key={groupIndex} className="flex items-center">
                {groupIndex > 0 && <span aria-hidden="true" className="mx-2 h-4 w-px bg-line-strong" />}
                <ul className="flex">
                  {group.map(({ to, label }) => (
                    <li key={to}>
                      <NavLink
                        to={to}
                        viewTransition
                        className={({ isActive }) =>
                          cx(
                            "relative flex h-11 items-center px-2.5 text-[13px] font-medium transition-colors duration-150",
                            isActive ? "text-fg" : "text-fg-2 hover:text-fg",
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            {label}
                            {/* One underline, shared by all tabs: it glides to the
                                chosen one instead of appearing under it. */}
                            {isActive && (
                              <motion.span
                                layoutId="tab-underline"
                                transition={SPRING}
                                className="absolute inset-x-2.5 -bottom-px h-[2px] rounded-full bg-accent shadow-[0_0_12px_var(--color-accent)]"
                              />
                            )}
                          </>
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      {menuOpen && (
        <div
          data-testid="menu-backdrop"
          className="fixed inset-0 z-20 animate-fade bg-[rgb(20_19_16/0.35)] md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <main id="main" className="mx-auto max-w-6xl px-4 py-8 md:px-8 md:py-12">
        {/* Page changes animate through the View Transitions API (see index.css). */}
        <Outlet />
      </main>
    </div>
  );
}
