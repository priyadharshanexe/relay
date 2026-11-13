import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import {
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
  Select,
} from "../components/ui";
import { api, fieldErrors } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Receiver, ReceiverMode } from "../lib/types";
import { requiredText } from "../lib/validate";

const RECEIVERS = ["receivers"] as const;

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

function ReceiverRow({ receiver, canEdit }: { receiver: Receiver; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);

  const setMode = useMutation({
    mutationFn: (mode: ReceiverMode) =>
      api<Receiver>(`/v1/receivers/${receiver.id}`, { method: "PATCH", body: { mode } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RECEIVERS }),
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`/v1/receivers/${receiver.id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RECEIVERS }),
  });

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(receiver.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The URL is selectable as a fallback.
    }
  }

  const mode = MODES.find((item) => item.value === receiver.mode);

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900">{receiver.name}</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="block select-all truncate rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">
              {receiver.url}
            </code>
            <Button size="sm" onClick={copyUrl}>
              {copied ? "Copied" : "Copy URL"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {receiver.requests_received === 0
              ? "No requests received yet"
              : `${receiver.requests_received} request${
                  receiver.requests_received === 1 ? "" : "s"
                } received · last ${timeAgo(receiver.last_received_at)}`}
          </p>
        </div>
        <div className="w-56 shrink-0">
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
        </div>
      </div>
      {canEdit && (
        <div className="mt-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      )}
      {setMode.isError && (
        <div className="mt-3">
          <ErrorState error={setMode.error} />
        </div>
      )}
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
        description="Stand-in servers hosted by Relay. Point an endpoint at one, then make it fail, slow down or recover to see how Relay reacts."
        action={addButton}
      />

      {receivers.isPending && <LoadingState label="Loading test receivers…" />}
      {receivers.isError && (
        <ErrorState error={receivers.error} onRetry={() => void receivers.refetch()} />
      )}
      {receivers.data?.length === 0 && (
        <EmptyState title="No test receivers yet" action={addButton}>
          A test receiver gives you a URL that accepts webhooks, so you can try Relay without
          running a server of your own.
        </EmptyState>
      )}
      {receivers.data && receivers.data.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-200">
            {receivers.data.map((receiver) => (
              <ReceiverRow key={receiver.id} receiver={receiver} canEdit={canEdit} />
            ))}
          </ul>
        </Card>
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
