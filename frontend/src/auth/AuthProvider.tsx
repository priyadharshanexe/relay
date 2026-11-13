import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, api, getCurrentOrgId, setCurrentOrgId } from "../lib/api";
import type { Organization, Session } from "../lib/types";

interface AuthContextValue {
  session: Session;
  organization: Organization;
  /** Owners and developers can change things; viewers can only look. */
  canEdit: boolean;
  /** Only owners manage the team and the organisation itself. */
  isOwner: boolean;
  switchOrganization: (orgId: string) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const SESSION_QUERY_KEY = ["session"] as const;

/** Written on logout. Other tabs of the same browser see the change and log out too. */
export const LOGOUT_SIGNAL_KEY = "relay.loggedOutAt";

/** Forget the session and everything loaded for it. The router then shows Log in. */
export function endSessionLocally(queryClient: QueryClient): void {
  setCurrentOrgId(null);
  queryClient.setQueryData(SESSION_QUERY_KEY, null);
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
}

/** Loads "who am I?". Resolves to null when nobody is logged in. */
export function useSessionQuery() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async (): Promise<Session | null> => {
      try {
        return await api<Session>("/v1/auth/me");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/** Log out here, and tell the other tabs of this browser to do the same. */
export function useLogout(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await api<void>("/v1/auth/logout", { method: "POST", skipRefresh: true }).catch(() => undefined);
    endSessionLocally(queryClient);
    try {
      localStorage.setItem(LOGOUT_SIGNAL_KEY, String(Date.now()));
    } catch {
      // Storage can be unavailable (private mode); this tab is logged out anyway.
    }
  }, [queryClient]);
}

/** Shown to someone who is logged in but belongs to no organisation, which
 *  happens when they are removed from their only one. */
function NoOrganization({ email, onLogout }: { email: string; onLogout: () => void }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-lg font-semibold text-slate-900">You are not in any organisation</h1>
      <p className="mt-2 text-sm text-slate-600">
        <span className="font-medium">{email}</span> no longer belongs to an organisation. Ask an
        owner to send you an invitation link, then open it while logged in.
      </p>
      <button
        type="button"
        onClick={onLogout}
        className="mt-6 rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
      >
        Log out
      </button>
    </div>
  );
}

function pickOrganization(session: Session, preferredId: string | null): Organization | null {
  return (
    session.organizations.find((org) => org.id === preferredId) ?? session.organizations[0] ?? null
  );
}

export function AuthProvider({ session, children }: { session: Session; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [orgId, setOrgId] = useState<string | null>(() => getCurrentOrgId());
  const organization = pickOrganization(session, orgId);

  const organizationId = organization?.id ?? null;

  // Keep the stored id in step with what we actually use, so the API client
  // sends the matching X-Org-ID header.
  //
  // In a layout effect, not during render: React may render and then throw the
  // result away, and a discarded render must not overwrite the stored choice.
  // Layout effects still run before the pages below start loading their data.
  const shownOrgId = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (organizationId === null) return;
    if (getCurrentOrgId() !== organizationId) setCurrentOrgId(organizationId);
    if (shownOrgId.current !== null && shownOrgId.current !== organizationId) {
      // The organisation changed under us (for example we were removed from the
      // one on screen). What is loaded belongs to the old one: load it again.
      void queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    }
    shownOrgId.current = organizationId;
  }, [organizationId, queryClient]);

  // "No such organisation" on any request means the list of organisations we
  // hold is out of date: we were removed from this one while the page was open.
  // Ask again who we are, and the screen follows from the answer.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "error") return;
        if (event.query.queryKey[0] === "session") return;
        const error: unknown = event.action.error;
        if (error instanceof ApiError && error.code === "organization_not_found") {
          void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
        }
      }),
    [queryClient],
  );

  const switchOrganization = useCallback(
    (nextId: string) => {
      setCurrentOrgId(nextId);
      shownOrgId.current = nextId;
      setOrgId(nextId);
      // Everything on screen belongs to the previous organisation: drop it all
      // except the session itself.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    },
    [queryClient],
  );

  const logout = useLogout();

  // Logging out in one tab must log out every tab. The browser fires "storage"
  // in the *other* tabs when a value changes, which is exactly what is needed.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === LOGOUT_SIGNAL_KEY && event.newValue) endSessionLocally(queryClient);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [queryClient]);

  const value = useMemo<AuthContextValue | null>(
    () =>
      organization && {
        session,
        organization,
        canEdit: organization.role !== "viewer",
        isOwner: organization.role === "owner",
        switchOrganization,
        logout,
      },
    [session, organization, switchOrganization, logout],
  );

  if (!value) {
    return <NoOrganization email={session.user.email} onLogout={() => void logout()} />;
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
