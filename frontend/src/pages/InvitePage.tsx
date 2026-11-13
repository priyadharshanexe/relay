import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SESSION_QUERY_KEY, useLogout } from "../auth/AuthProvider";
import { Button, ErrorState, LoadingState } from "../components/ui";
import { api, setCurrentOrgId } from "../lib/api";
import { fullDate } from "../lib/format";
import type { Organization, Session } from "../lib/types";
import { AuthShell, useInvitation } from "./AuthPages";

const LINK = "font-medium text-brand-600 hover:text-brand-700";

/**
 * Where an invitation link leads.
 *
 * - Logged out: say what the invitation is for, and offer to sign up or log in.
 * - Logged in as the invited address: one button to join.
 * - Logged in as someone else: explain, and offer to log out. The invitation is
 *   bound to one address, so it cannot be accepted from another account.
 */
export function InvitePage({ session }: { session: Session | null }) {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = useLogout();
  const invitation = useInvitation(token);

  const accept = useMutation({
    mutationFn: () =>
      api<Organization>(`/v1/invitations/${encodeURIComponent(token)}/accept`, { method: "POST" }),
    onSuccess: async (organization) => {
      // Open the dashboard on the organisation just joined. The session must
      // list it first, or the dashboard would fall back to another one.
      const fresh = await api<Session>("/v1/auth/me");
      queryClient.setQueryData(SESSION_QUERY_KEY, fresh);
      setCurrentOrgId(organization.id);
      // Anything loaded so far belongs to another organisation.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
      await navigate("/endpoints", { replace: true });
    },
  });

  if (invitation.isPending) return <LoadingState label="Loading your invitation…" />;

  if (invitation.isError) {
    return (
      <AuthShell title="Invitation">
        <ErrorState error={invitation.error} />
        <p className="mt-4 text-sm text-slate-600">
          Invitation links work once and expire. Ask the person who invited you for a new one.
        </p>
        <p className="mt-4 text-sm">
          <Link to={session ? "/endpoints" : "/login"} className={LINK}>
            {session ? "Go to the dashboard" : "Go to log in"}
          </Link>
        </p>
      </AuthShell>
    );
  }

  const { organization_name, email, role, expires_at } = invitation.data;
  const query = `?invite=${encodeURIComponent(token)}`;
  const summary = (
    <p className="text-sm text-slate-600">
      <strong>{email}</strong> was invited to join <strong>{organization_name}</strong> as a{" "}
      <strong>{role}</strong>. The invitation is valid until {fullDate(expires_at)}.
    </p>
  );

  if (session === null) {
    return (
      <AuthShell title={`Join ${organization_name}`}>
        {summary}
        <div className="mt-5 space-y-3">
          <Link
            to={`/register${query}`}
            className="block w-full rounded-md bg-brand-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-brand-700"
          >
            Create an account
          </Link>
          <Link
            to={`/login${query}`}
            className="block w-full rounded-md bg-white px-3 py-2 text-center text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          >
            I already have an account
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (session.user.email !== email) {
    return (
      <AuthShell title={`Join ${organization_name}`}>
        {summary}
        <p role="alert" className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          You are logged in as <strong>{session.user.email}</strong>. Log out, then open this link
          again as {email}.
        </p>
        <div className="mt-5 flex justify-between gap-3">
          <Button onClick={() => void navigate("/endpoints")}>Back to the dashboard</Button>
          <Button variant="primary" onClick={() => void logout()}>
            Log out
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`Join ${organization_name}`}>
      {summary}
      {accept.isError && (
        <div className="mt-4">
          <ErrorState error={accept.error} />
        </div>
      )}
      <div className="mt-5 flex justify-between gap-3">
        <Button onClick={() => void navigate("/endpoints")}>Not now</Button>
        <Button variant="primary" busy={accept.isPending} onClick={() => accept.mutate()}>
          Join {organization_name}
        </Button>
      </div>
    </AuthShell>
  );
}
