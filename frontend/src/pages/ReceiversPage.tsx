import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { SecretReveal } from "../components/SecretReveal";
import { PlusIcon, ReceiverIcon } from "../components/icons";
import { useSpotlight } from "../components/motionkit";
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  PageHeader,
  Select,
} from "../components/ui";
import { api, fieldErrors } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Endpoint, EndpointCreated, Receiver, ReceiverMode } from "../lib/types";
import { requiredText } from "../lib/validate";

const RECEIVERS = ["receivers"] as const;
// The same list the Endpoints page loads, so the two pages share one copy.
const ENDPOINTS = ["endpoints"] as const;

export const MODES: { value: ReceiverMode; label: string; explain: string }[] = [
  { value: "ok", label: "Succeed (200)", explain: "Accepts every webhook." },
  { value: "error", label: "Fail (500)", explain: "Rejects every webhook, so Relay retries." },
  {
    value: "rate_limit",
    label: "Rate limit (429)",
    explain: "Answers 429 with Retry-After, which Relay honours.",
  },
  { value: "slow", label: "Respond slowly", explain: "Waits 2 seconds, then accepts." },
  { value: "timeout", label: "Never respond", explain: "Holds the connection until Relay gives up." },
];

/** What each behaviour means for deliveries: accepted, failing, or held up. */
const MODE_DOT: Record<ReceiverMode, string> = {
  ok: "bg-ok",
  error: "bg-bad",
  rate_limit: "bg-warn",
  slow: "bg-warn",
  timeout: "bg-bad",
};

function ReceiverRow({
  receiver,
  canEdit,
  connected,
  order = 0,
}: {
  receiver: Receiver;
  canEdit: boolean;
  /** Whether an endpoint already delivers to this receiver. Unknown while loading. */
  connected: boolean | undefined;
  order?: number;
}) {
  const spotlight = useSpotlight();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const setMode = useMutation({
    mutationFn: (mode: ReceiverMode) =>
      api<Receiver>(`/v1/receivers/${receiver.id}`, { method: "PATCH", body: { mode } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RECEIVERS }),
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`/v1/receivers/${receiver.id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RECEIVERS }),
  });

  // One click instead of: copy the URL, go to Endpoints, paste it into a form.
  const [secret, setSecret] = useState<string | null>(null);
  const createEndpoint = useMutation({
    mutationFn: () =>
      api<EndpointCreated>("/v1/endpoints", {
        method: "POST",
        body: { url: receiver.url, description: `Test receiver: ${receiver.name}` },
      }),
    onSuccess: async (endpoint) => {
      setSecret(endpoint.secret);
      await queryClient.invalidateQueries({ queryKey: ENDPOINTS });
    },
  });

  const mode = MODES.find((item) => item.value === receiver.mode);
  const requests =
    receiver.requests_received === 0
      ? "No requests received yet"
      : `${receiver.requests_received} request${receiver.requests_received === 1 ? "" : "s"} received`;

  return (
    <li
      {...spotlight}
      style={{ animationDelay: `${Math.min(order, 10) * 60}ms` }}
      className="spotlight grid animate-rise gap-x-10 gap-y-4 rounded-xl border border-line bg-panel px-5 py-5 transition-transform duration-200 hover:-translate-y-0.5 md:grid-cols-[minmax(0,1fr)_15rem] [animation-fill-mode:both]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${MODE_DOT[receiver.mode]}`} />
          <h3 className="truncate text-sm font-medium text-fg">{receiver.name}</h3>
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-1 pl-[18px]">
          <code className="truncate select-all font-mono text-xs text-fg-2">{receiver.url}</code>
          <CopyButton value={receiver.url} label="Copy URL" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 pl-[18px] text-xs text-fg-3">
          <span className="tabular">
            {requests}
            {receiver.last_received_at && <> · last {timeAgo(receiver.last_received_at)}</>}
          </span>
          {connected && (
            <span className="flex items-center gap-2">
              <Badge tone="green">Endpoint connected</Badge>
              <Link to="/endpoints" className="font-medium text-accent transition-colors hover:text-accent-hover">
                View endpoints
              </Link>
            </span>
          )}
          {connected === false && (
            <span className="flex flex-wrap items-center gap-2.5">
              {canEdit && (
                <Button
                  size="sm"
                  icon={<PlusIcon width={13} height={13} />}
                  busy={createEndpoint.isPending}
                  onClick={() => createEndpoint.mutate()}
                >
                  Create endpoint
                </Button>
              )}
              <span>
                No endpoint delivers here yet{canEdit ? "." : ". Ask an owner or developer to add one."}
              </span>
            </span>
          )}
        </div>
        {createEndpoint.isError && (
          <div className="mt-3">
            <ErrorState error={createEndpoint.error} />
          </div>
        )}
        {setMode.isError && (
          <div className="mt-3">
            <ErrorState error={setMode.error} />
          </div>
        )}
      </div>
      <div>
        <Field label="Behaviour" hint={mode?.explain}>
          {(props) => (
            <Select
              {...props}
              value={receiver.mode}
              disabled={!canEdit || setMode.isPending}
              onChange={(event) => setMode.mutate(event.target.value as ReceiverMode)}
            >
              {MODES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {canEdit && (
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="ghost" className="hover:text-bad" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this test receiver?"
        confirmLabel="Delete receiver"
        danger
        busy={remove.isPending}
        error={remove.isError ? remove.error : undefined}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmDelete(false)}
      >
        Endpoints pointing at <strong>{receiver.name}</strong> will start failing.
      </ConfirmDialog>
      <Modal
        title="Endpoint created"
        open={secret !== null}
        onClose={() => setSecret(null)}
        dismissible={false}
      >
        {secret && (
          <>
            <p className="mb-3 text-sm text-fg-2">
              Events now go to <strong>{receiver.name}</strong>. Open Endpoints and use "Send test
              event" to try it.
            </p>
            <SecretReveal label="Signing secret for the new endpoint" secret={secret} />
            <p className="mt-3 text-sm text-fg-2">
              The test receiver does not need it. Keep it only if you want to check signatures
              yourself.
            </p>
            <div className="mt-5 flex justify-end">
              <Button variant="primary" onClick={() => setSecret(null)}>
                I have saved it
              </Button>
            </div>
          </>
        )}
      </Modal>
    </li>
  );
}

export function ReceiversPage() {
  const { canEdit } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const receivers = useQuery({
    queryKey: RECEIVERS,
    queryFn: () => api<Receiver[]>("/v1/receivers"),
    refetchInterval: 5_000, // the request counters change as deliveries arrive
  });

  const endpoints = useQuery({
    queryKey: ENDPOINTS,
    queryFn: () => api<Endpoint[]>("/v1/endpoints"),
  });
  const endpointUrls = endpoints.data && new Set(endpoints.data.map((endpoint) => endpoint.url));

  const create = useMutation({
    mutationFn: () =>
      api<Receiver>("/v1/receivers", { method: "POST", body: { name: name.trim() } }),
    onSuccess: async () => {
      setCreating(false);
      setName("");
      await queryClient.invalidateQueries({ queryKey: RECEIVERS });
    },
  });

  const [clientError, setClientError] = useState<string>();

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = requiredText(name, "a name for the receiver");
    setClientError(problem);
    if (problem) {
      create.reset();
      return;
    }
    create.mutate();
  }

  const nameError = clientError ?? fieldErrors(create.error).name;
  const addButton = canEdit && (
    <Button variant="primary" onClick={() => setCreating(true)}>
      Create test receiver
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Test receivers"
        description="Fake customer servers, hosted by Relay. Make one fail, slow down or recover, and watch how deliveries respond."
        action={addButton}
      />

      {receivers.isPending && <LoadingState label="Loading test receivers…" />}
      {receivers.isError && (
        <ErrorState error={receivers.error} onRetry={() => void receivers.refetch()} />
      )}
      {receivers.data?.length === 0 && (
        <EmptyState title="No test receivers yet" action={addButton} icon={<ReceiverIcon />}>
          A test receiver gives you a URL that accepts webhooks, so you can try Relay without
          running a server of your own.
        </EmptyState>
      )}
      {receivers.data && receivers.data.length > 0 && (
        <ul className="grid gap-3">
            {receivers.data.map((receiver, index) => (
              <ReceiverRow
                key={receiver.id}
                order={index}
                receiver={receiver}
                canEdit={canEdit}
                connected={endpointUrls?.has(receiver.url)}
              />
            ))}
        </ul>
      )}

      <Modal title="Create test receiver" open={creating} onClose={() => setCreating(false)}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Name" error={nameError}>
            {(props) => (
              <Input
                {...props}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Flaky customer"
              />
            )}
          </Field>
          {create.isError && !nameError && <ErrorState error={create.error} />}
          <div className="flex justify-end gap-3">
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" variant="primary" busy={create.isPending}>
              Create receiver
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
