import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { ApiError, api, getCurrentOrgId, setCurrentOrgId } from "../lib/api";
import type { Organization, Session } from "../lib/types";

interface AuthContextValue {
  session: Session;
  organization: Organization;
  /** Owners and developers can change things; viewers can only look. */
  canEdit: boolean;
  switchOrganization: (orgId: string) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const SESSION_QUERY_KEY = ["session"] as const;

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

function pickOrganization(session: Session, preferredId: string | null): Organization | null {
  return (
    session.organizations.find((org) => org.id === preferredId) ?? session.organizations[0] ?? null
  );
}

export function AuthProvider({ session, children }: { session: Session; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [orgId, setOrgId] = useState<string | null>(() => getCurrentOrgId());
  const organization = pickOrganization(session, orgId);

  // Keep the stored id in step with what we actually use, so the API client
  // sends the matching X-Org-ID header.
  if (organization && getCurrentOrgId() !== organization.id) setCurrentOrgId(organization.id);

  const switchOrganization = useCallback(
    (nextId: string) => {
      setCurrentOrgId(nextId);
      setOrgId(nextId);
      // Everything on screen belongs to the previous organisation: drop it all
      // except the session itself.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    await api<void>("/v1/auth/logout", { method: "POST", skipRefresh: true }).catch(() => undefined);
    setCurrentOrgId(null);
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
    // Forget everything that belonged to the logged-out user.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
  }, [queryClient]);

  const value = useMemo<AuthContextValue | null>(
    () =>
      organization && {
        session,
        organization,
        canEdit: organization.role !== "viewer",
        switchOrganization,
        logout,
      },
    [session, organization, switchOrganization, logout],
  );

  if (!value) {
    return <p className="p-8 text-sm text-slate-600">You are not a member of any organisation.</p>;
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
