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
import { api, fieldErrors } from "../lib/api";
import { fullDate, timeAgo } from "../lib/format";
import type { ApiKey, ApiKeyCreated } from "../lib/types";
import { requiredText } from "../lib/validate";

const KEYS = ["api-keys"] as const;

/** A copy-and-paste request that sends one event with the new key. */
export function usageExample(key: string): string {
  return [
    `curl -X POST ${window.location.origin}/v1/events \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Idempotency-Key: order-42-paid" \\`,
    `  -d '{"type": "order.paid", "payload": {"order_id": 42}}'`,
  ].join("\n");
}

export function ApiKeysPage() {
  const { canEdit } = useAuth();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const keys = useQuery({
    queryKey: KEYS,
    queryFn: () => api<ApiKey[]>("/v1/api-keys"),
    refetchInterval: 15_000, // "last used" changes as the key is used
  });

  const create = useMutation({
    mutationFn: () =>
      api<ApiKeyCreated>("/v1/api-keys", { method: "POST", body: { name: name.trim() } }),
    onSuccess: async (key) => {
      setCreating(false);
      setName("");
      setCreated(key);
      await queryClient.invalidateQueries({ queryKey: KEYS });
    },
  });

  const revoke = useMutation({
    mutationFn: (key: ApiKey) => api<void>(`/v1/api-keys/${key.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: KEYS });
    },
  });

  const [clientError, setClientError] = useState<string>();

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = requiredText(name, "a name for the key");
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
      Create API key
    </Button>
  );

  return (
    <>
      <PageHeader
        title="API keys"
        description="Your backend uses an API key to send events to Relay. Treat keys like passwords."
        action={addButton}
      />

      {keys.isPending && <LoadingState label="Loading API keys…" />}
      {keys.isError && <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />}
      {keys.data?.length === 0 && (
        <EmptyState title="No API keys yet" action={addButton}>
          Create a key, then send your first event with it.
        </EmptyState>
      )}
      {keys.data && keys.data.length > 0 && (
        <Card className="overflow-hidden">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-5 py-3">Name</th>
                <th scope="col" className="px-5 py-3">Key</th>
                <th scope="col" className="px-5 py-3">Last used</th>
                <th scope="col" className="px-5 py-3">Created</th>
                <th scope="col" className="px-5 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {keys.data.map((key) => (
                <tr key={key.id} className={key.revoked_at ? "text-slate-400" : "text-slate-700"}>
                  <td className="px-5 py-3 font-medium">{key.name}</td>
                  <td className="px-5 py-3 font-mono text-xs">{key.prefix}…</td>
                  <td className="px-5 py-3" title={fullDate(key.last_used_at)}>
                    {timeAgo(key.last_used_at)}
                  </td>
                  <td className="px-5 py-3" title={fullDate(key.created_at)}>
                    {timeAgo(key.created_at)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {key.revoked_at ? (
                      <Badge tone="red">Revoked</Badge>
                    ) : (
                      canEdit && (
                        <Button size="sm" variant="ghost" onClick={() => setRevoking(key)}>
                          Revoke
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Modal title="Create API key" open={creating} onClose={() => setCreating(false)}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Name" hint="For example the service that will use it." error={nameError}>
            {(props) => (
              <Input
                {...props}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="orders-service"
              />
            )}
          </Field>
          {create.isError && !nameError && <ErrorState error={create.error} />}
          <div className="flex justify-end gap-3">
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" variant="primary" busy={create.isPending}>
              Create key
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        title="Save this API key"
        open={created !== null}
        onClose={() => setCreated(null)}
        dismissible={false}
      >
        {created && (
          <>
            <SecretReveal label={`API key "${created.name}"`} secret={created.key} />
            <div className="mt-4">
              <p className="text-sm font-medium text-slate-900">Send your first event</p>
              <p className="mt-1 text-xs text-slate-500">
                Run this from your backend or a terminal. The key goes in the Authorization header.
              </p>
              <pre
                data-testid="usage-example"
                className="mt-2 overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100"
              >
                {usageExample(created.key)}
              </pre>
            </div>
            <div className="mt-5 flex justify-end">
              <Button variant="primary" onClick={() => setCreated(null)}>
                I have saved it
              </Button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this API key?"
        confirmLabel="Revoke key"
        danger
        busy={revoke.isPending}
        error={revoke.isError ? revoke.error : undefined}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        onClose={() => setRevoking(null)}
      >
        Anything still using <strong>{revoking?.name}</strong> will immediately stop being able to
        send events. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
