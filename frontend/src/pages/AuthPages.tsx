import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SESSION_QUERY_KEY } from "../auth/AuthProvider";
import { Logo } from "../components/icons";
import { Button, ErrorState, Field, Input, LoadingState } from "../components/ui";
import { api, fieldErrors, setCurrentOrgId } from "../lib/api";
import type { InvitationInfo, Session } from "../lib/types";
import {
  collect,
  emailAddress,
  type Errors,
  hasErrors,
  newPassword,
  requiredText,
} from "../lib/validate";

const LINK = "font-medium text-accent transition-colors hover:text-accent-hover";

/** What Relay actually sends: shown beside the sign-in forms, so the first
 *  screen says what the product does by showing it. */
function SampleRequest() {
  const header = (name: string, value: string) => (
    <div>
      <span className="text-fg-3">{name}:</span> <span className="text-fg-2">{value}</span>
    </div>
  );
  return (
    <div className="w-full max-w-md">
      <p className="mb-3 text-xs text-fg-3">What your server receives</p>
      <div className="overflow-hidden rounded-xl border border-line bg-canvas">
        <div className="border-b border-line px-4 py-2.5 font-mono text-xs">
          <span className="text-accent">POST</span> <span className="text-fg">/webhooks/orders</span>
        </div>
        <div className="space-y-0.5 px-4 py-3 font-mono text-[11.5px] leading-relaxed">
          {header("webhook-id", "msg_01JD8Q2H7M")}
          {header("webhook-timestamp", "1763560800")}
          {header("webhook-signature", "v1,K5oZfzN95Z9…")}
          {header("content-type", "application/json")}
        </div>
        <div className="border-t border-line px-4 py-3 font-mono text-[11.5px] leading-relaxed">
          <div className="json-punct">{"{"}</div>
          <div className="pl-4">
            <span className="json-key">"type"</span>
            <span className="json-punct">: </span>
            <span className="json-string">"order.paid"</span>
            <span className="json-punct">,</span>
          </div>
          <div className="pl-4">
            <span className="json-key">"order_id"</span>
            <span className="json-punct">: </span>
            <span className="json-number">1042</span>
            <span className="json-punct">,</span>
          </div>
          <div className="pl-4">
            <span className="json-key">"total"</span>
            <span className="json-punct">: </span>
            <span className="json-string">"49.00"</span>
          </div>
          <div className="json-punct">{"}"}</div>
        </div>
      </div>
      <ul className="mt-6 space-y-2 text-[13px] text-fg-2">
        <li>Signed, so the receiver can prove it came from you.</li>
        <li>Retried on a schedule when the receiver is down.</li>
        <li>Kept, so a failed one can be replayed later.</li>
      </ul>
    </div>
  );
}

export function AuthShell({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-[-0.02em]">Relay</span>
        </div>
        <div className="flex flex-1 items-center py-12">
          <div className="w-full max-w-[360px] animate-rise lg:ml-[max(0px,calc(50%-180px-3rem))]">
            <h1 className="mb-7 text-2xl font-semibold tracking-[-0.03em] text-fg">{title}</h1>
            {children}
            {footer && <p className="mt-6 text-[13px] text-fg-3">{footer}</p>}
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="hidden items-center justify-center border-l border-line bg-panel px-12 lg:flex">
        <SampleRequest />
      </div>
    </div>
  );
}

/** Loads what an invitation link is for. Needs no login. */
export function useInvitation(token: string | null) {
  return useQuery({
    queryKey: ["invitation", token],
    queryFn: () =>
      api<InvitationInfo>(`/v1/invitations/${encodeURIComponent(token ?? "")}`, {
        skipRefresh: true,
      }),
    enabled: token !== null,
    retry: false,
    staleTime: 60_000,
  });
}

/** Carry the invitation along when moving between "log in" and "sign up". */
function withInvite(path: string, invite: string | null): string {
  return invite ? `${path}?invite=${encodeURIComponent(invite)}` : path;
}

/** Both forms end the same way: the API set the session cookies, so store the
 *  session and let the router show the dashboard. */
function useStartSession(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<Session>(path, { method: "POST", body, skipRefresh: true }),
    onSuccess: (session) => {
      setCurrentOrgId(session.organizations[0]?.id ?? null);
      // Update the session in place. (Clearing the whole cache here would detach
      // the app's subscription to it, and the app would never see the login.)
      queryClient.setQueryData(SESSION_QUERY_KEY, session);
    },
  });
}

export function LoginPage() {
  const [params] = useSearchParams();
  const invite = params.get("invite");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Errors<"email" | "password">>({});
  const login = useStartSession("/v1/auth/login");

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = collect({
      email: emailAddress(email),
      password: password ? undefined : "Enter your password.",
    });
    setErrors(found);
    if (hasErrors(found)) {
      login.reset(); // drop any earlier server error: the form is what is wrong now
      return;
    }
    login.mutate({ email: email.trim(), password });
  }

  return (
    <AuthShell
      title="Log in"
      footer={
        <>
          New to Relay?{" "}
          <Link to={withInvite("/register", invite)} className={LINK}>
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {invite && (
          <p role="note" className="rounded-lg border border-accent-line bg-accent-soft px-3.5 py-2.5 text-[13px] text-[#a9c7ff]">
            Log in to accept your invitation.
          </p>
        )}
        <Field label="Email" error={errors.email}>
          {(props) => (
            <Input
              {...props}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field label="Password" error={errors.password}>
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        {login.isError && <ErrorState error={login.error} />}
        <Button type="submit" variant="primary" className="w-full" busy={login.isPending}>
          Log in
        </Button>
      </form>
    </AuthShell>
  );
}

type RegisterField = "organization_name" | "email" | "password";

export function RegisterPage() {
  const [params] = useSearchParams();
  const invite = params.get("invite");
  // Someone who was invited joins that organisation: they do not name a new one,
  // and the email address is the one the invitation was sent to.
  const invitation = useInvitation(invite);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organization, setOrganization] = useState("");
  const [clientErrors, setClientErrors] = useState<Errors<RegisterField>>({});
  const register = useStartSession("/v1/auth/register");

  // What the server says about a field wins only when the browser found nothing.
  const serverErrors = fieldErrors(register.error) as Errors<RegisterField>;
  const errors = hasErrors(clientErrors) ? clientErrors : serverErrors;

  const footer = (
    <>
      Already have an account?{" "}
      <Link to={withInvite("/login", invite)} className={LINK}>
        Log in
      </Link>
    </>
  );

  if (invite && invitation.isPending) return <LoadingState label="Loading your invitation…" />;
  if (invite && invitation.isError) {
    return (
      <AuthShell title="Create your account" footer={footer}>
        <ErrorState error={invitation.error} />
        <p className="mt-4 text-sm text-fg-2">
          Ask the person who invited you for a new link, or{" "}
          <Link to="/register" className={LINK}>
            create your own organisation
          </Link>
          .
        </p>
      </AuthShell>
    );
  }
  const invited = invite ? invitation.data : undefined;

  function submit(event: FormEvent) {
    event.preventDefault();
    const found = collect({
      organization_name: invited
        ? undefined
        : requiredText(organization, "the name of your organisation"),
      email: invited ? undefined : emailAddress(email),
      password: newPassword(password),
    });
    setClientErrors(found);
    if (hasErrors(found)) {
      register.reset();
      return;
    }
    register.mutate(
      invited && invite
        ? { email: invited.email, password, invitation_token: invite }
        : { email: email.trim(), password, organization_name: organization.trim() },
    );
  }

  return (
    <AuthShell
      title={invited ? `Join ${invited.organization_name}` : "Create your account"}
      footer={footer}
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {invited ? (
          <p className="text-sm text-fg-2">
            You were invited as a <strong>{invited.role}</strong>. Choose a password to create your
            account.
          </p>
        ) : (
          <Field label="Organisation name" error={errors.organization_name}>
            {(props) => (
              <Input
                {...props}
                autoComplete="organization"
                value={organization}
                onChange={(event) => setOrganization(event.target.value)}
              />
            )}
          </Field>
        )}
        <Field
          label="Email"
          hint={invited ? "The invitation was sent to this address." : undefined}
          error={errors.email}
        >
          {(props) => (
            <Input
              {...props}
              type="email"
              autoComplete="email"
              readOnly={invited !== undefined}
              value={invited ? invited.email : email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field label="Password" hint="At least 10 characters." error={errors.password}>
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        {register.isError && !hasErrors(errors) && <ErrorState error={register.error} />}
        <Button type="submit" variant="primary" className="w-full" busy={register.isPending}>
          {invited ? "Create account and join" : "Create account"}
        </Button>
      </form>
    </AuthShell>
  );
}
