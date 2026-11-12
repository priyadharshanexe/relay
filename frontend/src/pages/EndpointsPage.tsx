import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { SecretReveal } from "../components/SecretReveal";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  PageHeader,
} from "../components/ui";
import { ApiError, api, fieldErrors } from "../lib/api";
import { milliseconds, percent, timeAgo } from "../lib/format";
import type {
  Endpoint,
  EndpointCreated,
  EndpointHealth,
  RotatedSecret,
} from "../lib/types";

const ENDPOINTS_KEY = ["endpoints"] as const;
const HEALTH_KEY = ["endpoints", "health"] as const;

/** "order.paid, order.refunded" -> ["order.paid", "order.refunded"] */
export function parseEventTypes(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function StatusBadge({ endpoint }: { endpoint: Endpoint }) {
  if (endpoint.status === "paused") return <Badge tone="amber">Paused</Badge>;
  if (endpoint.status === "disabled") return <Badge tone="red">Disabled</Badge>;
  if (endpoint.breaker_state === "open") return <Badge tone="red">Failing: deliveries on hold</Badge>;
  if (endpoint.breaker_state === "half_open") return <Badge tone="amber">Testing recovery</Badge>;
  return <Badge tone="green">Active</Badge>;
}

// ------------------------------------------------------------------ create/edit
interface FormValues {
  url: string;
  description: string;
  eventTypes: string;
  rateLimit: string;
}

function EndpointForm({
  endpoint,
  onDone,
  onCreated,
}: {
  endpoint?: Endpoint;
  onDone: () => void;
  onCreated: (created: EndpointCreated) => void;
}) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<FormValues>({
    url: endpoint?.url ?? "",
    description: endpoint?.description ?? "",
    eventTypes: endpoint?.event_types.join(", ") ?? "",
    rateLimit: endpoint?.rate_limit_per_sec?.toString() ?? "",
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        url: values.url.trim(),
        description: values.description.trim(),
        event_types: parseEventTypes(values.eventTypes),
        rate_limit_per_sec: values.rateLimit.trim() ? Number(values.rateLimit) : null,
      };
      return endpoint
        ? api<Endpoint>(`/v1/endpoints/${endpoint.id}`, { method: "PATCH", body })
        : api<EndpointCreated>("/v1/endpoints", { method: "POST", body });
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ENDPOINTS_KEY });
      if ("secret" in saved) onCreated(saved as EndpointCreated);
      else onDone();
    },
  });

  const errors = fieldErrors(save.error);
  // The URL check (scheme, private addresses, ...) is not a per-field error from
  // the validator, so attach it to the URL field ourselves.
  const urlError =
    errors.url ??
    (save.error instanceof ApiError && save.error.code === "invalid_endpoint_url"
      ? save.error.message
      : undefined);
  const hasFieldError = Boolean(urlError) || Object.keys(errors).length > 0;

  function set<K extends keyof FormValues>(key: K) {
    return (event: { target: { value: string } }) =>
      setValues((current) => ({ ...current, [key]: event.target.value }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="URL" hint="Where Relay sends your events." error={urlError}>
        {(props) => (
          <Input
            {...props}
            type="url"
            required
            placeholder="https://example.com/webhooks"
            value={values.url}
            onChange={set("url")}
          />
        )}
      </Field>
      <Field label="Description" error={errors.description}>
        {(props) => <Input {...props} value={values.description} onChange={set("description")} />}
      </Field>
      <Field
        label="Event types"
        hint="Separate with commas. Leave empty to receive every event."
        error={errors.event_types}
      >
        {(props) => (
          <Input
            {...props}
            placeholder="order.paid, order.refunded"
            value={values.eventTypes}
            onChange={set("eventTypes")}
          />
        )}
      </Field>
      <Field
        label="Rate limit (per second)"
        hint="Optional. Protects a server that cannot take bursts."
        error={errors.rate_limit_per_sec}
      >
        {(props) => (
          <Input
            {...props}
            type="number"
            min={1}
            inputMode="numeric"
            value={values.rateLimit}
            onChange={set("rateLimit")}
          />
        )}
      </Field>
      {save.isError && !hasFieldError && <ErrorState error={save.error} />}
      <div className="flex justify-end gap-3 pt-2">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          {endpoint ? "Save changes" : "Create endpoint"}
        </Button>
      </div>
    </form>
  );
}

// -------------------------------------------------------------------------- row
type Action = "pause" | "resume" | "test" | "rotate-secret" | "delete";

function EndpointRow({
  endpoint,
  health,
  canEdit,
  onEdit,
  onSecret,
}: {
  endpoint: Endpoint;
  health?: EndpointHealth;
  canEdit: boolean;
  onEdit: () => void;
  onSecret: (title: string, secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"rotate-secret" | "delete" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (action: Action) =>
      action === "delete"
        ? api<void>(`/v1/endpoints/${endpoint.id}`, { method: "DELETE" })
        : api<unknown>(`/v1/endpoints/${endpoint.id}/${action}`, { method: "POST" }),
    onSuccess: async (result, action) => {
      setConfirm(null);
      if (action === "rotate-secret") {
        onSecret("New signing secret", (result as RotatedSecret).secret);
      }
      if (action === "test") setNotice("Test event queued.");
      await queryClient.invalidateQueries({ queryKey: ENDPOINTS_KEY });
    },
  });

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-mono text-sm font-medium text-slate-900" title={endpoint.url}>
              {endpoint.url}
            </p>
            <StatusBadge endpoint={endpoint} />
          </div>
          {endpoint.description && (
            <p className="mt-1 text-sm text-slate-600">{endpoint.description}</p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            {endpoint.event_types.length > 0 ? endpoint.event_types.join(", ") : "All event types"}
            {endpoint.rate_limit_per_sec !== null && ` · max ${endpoint.rate_limit_per_sec}/s`}
            {` · created ${timeAgo(endpoint.created_at)}`}
          </p>
        </div>
        <dl className="flex shrink-0 gap-6 text-right">
          <div>
            <dt className="text-xs text-slate-500">Success (24 h)</dt>
            <dd className="text-sm font-semibold text-slate-900">
              {percent(health?.success_rate ?? null)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">p95 latency</dt>
            <dd className="text-sm font-semibold text-slate-900">
              {milliseconds(health?.p95_ms ?? null)}
            </dd>
          </div>
        </dl>
      </div>

      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" busy={act.isPending && act.variables === "test"} onClick={() => act.mutate("test")}>
            Send test event
          </Button>
          {endpoint.status === "active" ? (
            <Button size="sm" onClick={() => act.mutate("pause")}>
              Pause
            </Button>
          ) : (
            <Button size="sm" onClick={() => act.mutate("resume")}>
              Resume
            </Button>
          )}
          <Button size="sm" onClick={() => setConfirm("rotate-secret")}>
            Rotate secret
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm("delete")}>
            Delete
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-2 text-xs text-emerald-700">
          {notice}
        </p>
      )}
      {act.isError && !confirm && (
        <div className="mt-3">
          <ErrorState error={act.error} />
        </div>
      )}

      <ConfirmDialog
        open={confirm === "rotate-secret"}
        title="Rotate signing secret?"
        confirmLabel="Rotate secret"
        busy={act.isPending}
        error={act.isError ? act.error : undefined}
        onConfirm={() => act.mutate("rotate-secret")}
        onClose={() => setConfirm(null)}
      >
        You will get a new secret. The current one keeps working for 24 hours, and until then every
        message is signed with both, so you can switch your server over without any failed
        verifications.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "delete"}
        title="Delete this endpoint?"
        confirmLabel="Delete endpoint"
        danger
        busy={act.isPending}
        error={act.isError ? act.error : undefined}
        onConfirm={() => act.mutate("delete")}
        onClose={() => setConfirm(null)}
      >
        <span className="font-mono">{endpoint.url}</span> and its delivery history will be removed.
        This cannot be undone.
      </ConfirmDialog>
    </li>
  );
}

// ------------------------------------------------------------------------- page
export function EndpointsPage() {
  const { canEdit } = useAuth();
  const [form, setForm] = useState<{ endpoint?: Endpoint } | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);

  const endpoints = useQuery({
    queryKey: ENDPOINTS_KEY,
    queryFn: () => api<Endpoint[]>("/v1/endpoints"),
  });
  const health = useQuery({
    queryKey: HEALTH_KEY,
    queryFn: () => api<EndpointHealth[]>("/v1/endpoints/health"),
    refetchInterval: 30_000,
  });
  const healthById = new Map(health.data?.map((item) => [item.endpoint_id, item]));

  const addButton = canEdit && (
    <Button variant="primary" onClick={() => setForm({})}>
      Add endpoint
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Endpoints"
        description="The URLs on your servers that receive webhooks. Each has its own signing secret."
        action={addButton}
      />

      {endpoints.isPending && <LoadingState label="Loading endpoints…" />}
      {endpoints.isError && (
        <ErrorState error={endpoints.error} onRetry={() => void endpoints.refetch()} />
      )}
      {endpoints.data?.length === 0 && (
        <EmptyState title="No endpoints yet" action={addButton}>
          Add the URL of a server that should receive your events. To try Relay without a server of
          your own, create a test receiver first and use its URL.
        </EmptyState>
      )}
      {endpoints.data && endpoints.data.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-200">
            {endpoints.data.map((endpoint) => (
              <EndpointRow
                key={endpoint.id}
                endpoint={endpoint}
                health={healthById.get(endpoint.id)}
                canEdit={canEdit}
                onEdit={() => setForm({ endpoint })}
                onSecret={(title, value) => setSecret({ title, value })}
              />
            ))}
          </ul>
        </Card>
      )}

      <Modal
        title={form?.endpoint ? "Edit endpoint" : "Add endpoint"}
        open={form !== null}
        onClose={() => setForm(null)}
      >
        {form && (
          <EndpointForm
            key={form.endpoint?.id ?? "new"}
            endpoint={form.endpoint}
            onDone={() => setForm(null)}
            onCreated={(created) => {
              setForm(null);
              setSecret({ title: "Signing secret for your new endpoint", value: created.secret });
            }}
          />
        )}
      </Modal>

      <Modal title="Save this secret" open={secret !== null} onClose={() => setSecret(null)}>
        {secret && (
          <>
            <SecretReveal label={secret.title} secret={secret.value} />
            <p className="mt-3 text-sm text-slate-600">
              Your server uses it to check that each webhook really came from Relay.
            </p>
            <div className="mt-5 flex justify-end">
              <Button variant="primary" onClick={() => setSecret(null)}>
                I have saved it
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
