import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { SESSION_QUERY_KEY } from "../auth/AuthProvider";
import { Button, ErrorState, Field, Input } from "../components/ui";
import { api, fieldErrors, setCurrentOrgId } from "../lib/api";
import type { Session } from "../lib/types";

function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 font-bold text-white"
          >
            R
          </span>
          <span className="text-lg font-semibold text-slate-900">Relay</span>
        </div>
        <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h1 className="mb-5 text-lg font-semibold text-slate-900">{title}</h1>
          {children}
        </div>
        <p className="mt-4 text-center text-sm text-slate-600">{footer}</p>
      </div>
    </div>
  );
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useStartSession("/v1/auth/login");

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password });
  }

  return (
    <AuthShell
      title="Log in"
      footer={
        <>
          New to Relay?{" "}
          <Link to="/register" className="font-medium text-brand-600 hover:text-brand-700">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Email">
          {(props) => (
            <Input
              {...props}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field label="Password">
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="current-password"
              required
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

export function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organization, setOrganization] = useState("");
  const register = useStartSession("/v1/auth/register");
  const errors = fieldErrors(register.error);
  const hasFieldErrors = Object.keys(errors).length > 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    register.mutate({ email, password, organization_name: organization });
  }

  return (
    <AuthShell
      title="Create your account"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Organisation name" error={errors.organization_name}>
          {(props) => (
            <Input
              {...props}
              autoComplete="organization"
              required
              value={organization}
              onChange={(event) => setOrganization(event.target.value)}
            />
          )}
        </Field>
        <Field label="Email" error={errors.email}>
          {(props) => (
            <Input
              {...props}
              type="email"
              autoComplete="email"
              required
              value={email}
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
              required
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        {register.isError && !hasFieldErrors && <ErrorState error={register.error} />}
        <Button type="submit" variant="primary" className="w-full" busy={register.isPending}>
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
