import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { DeliveryStatusBadge, errorKindLabel } from "../components/delivery";
import { Badge, Button, Card, ErrorState, LoadingState } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { fullDate, milliseconds, timeAgo } from "../lib/format";
import type { Attempt, Delivery, DeliveryDetail } from "../lib/types";

const REPLAYABLE = new Set(["dead", "succeeded"]);

function HeaderList({ title, headers }: { title: string; headers: Record<string, string> | null }) {
  const entries = Object.entries(headers ?? {});
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      {entries.length === 0 ? (
        <p className="mt-1 text-xs text-slate-500">None recorded.</p>
      ) : (
        <dl className="mt-1 space-y-0.5 font-mono text-xs">
          {entries.map(([name, value]) => (
            <div key={name} className="flex gap-2">
              <dt className="shrink-0 text-slate-500">{name}:</dt>
              <dd className="break-all text-slate-800">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function AttemptItem({ attempt, previous }: { attempt: Attempt; previous?: Attempt }) {
  const [open, setOpen] = useState(false);
  const ok = attempt.error_kind === null;
  // The gap since the previous attempt makes the backoff schedule visible.
  const gapSeconds = previous
    ? Math.round(
        (new Date(attempt.started_at).getTime() - new Date(previous.started_at).getTime()) / 1000,
      )
    : null;

  return (
    <li className="relative pl-8">
      <span
        aria-hidden="true"
        className={`absolute left-0 top-1.5 h-3 w-3 rounded-full ring-4 ring-white ${
          ok ? "bg-emerald-500" : "bg-red-500"
        }`}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-slate-900">Attempt {attempt.attempt_number}</span>
        <Badge tone={ok ? "green" : "red"}>
          {attempt.status_code !== null ? `HTTP ${attempt.status_code}` : errorKindLabel(attempt.error_kind)}
        </Badge>
        {!ok && attempt.status_code !== null && (
          <span className="text-xs text-slate-500">{errorKindLabel(attempt.error_kind)}</span>
        )}
        <span className="text-xs text-slate-500">{milliseconds(attempt.duration_ms)}</span>
        <time className="text-xs text-slate-500" dateTime={attempt.started_at}>
          {fullDate(attempt.started_at)}
        </time>
        {gapSeconds !== null && (
          <span className="text-xs text-slate-400">
            ({gapSeconds >= 120 ? `${Math.round(gapSeconds / 60)} min` : `${gapSeconds} s`} after the
            previous attempt)
          </span>
        )}
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="mt-1 text-xs font-medium text-brand-700 hover:underline"
      >
        {open ? "Hide details" : "Show request and response"}
      </button>
      {open && (
        <div className="mt-2 grid gap-4 rounded-md bg-slate-50 p-3 md:grid-cols-2">
          <HeaderList title="Request headers" headers={attempt.request_headers} />
          <div className="space-y-3">
            <HeaderList title="Response headers" headers={attempt.response_headers} />
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Response body (first part)
              </h4>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-xs text-slate-800 ring-1 ring-slate-200">
                {attempt.response_snippet || "(empty)"}
              </pre>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

export function DeliveryDetailPage() {
  const { id = "" } = useParams();
  const { canEdit } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["delivery", id],
    queryFn: () => api<DeliveryDetail>(`/v1/deliveries/${id}`),
    // Keep watching while it is still on its way.
    refetchInterval: (state) =>
      state.state.data && !REPLAYABLE.has(state.state.data.status) ? 3_000 : false,
  });

  const replay = useMutation({
    mutationFn: () => api<Delivery>(`/v1/deliveries/${id}/replay`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["delivery", id] });
      await queryClient.invalidateQueries({ queryKey: ["deliveries"] });
    },
  });

  const back = (
    <Link to="/deliveries" className="text-sm font-medium text-brand-700 hover:underline">
      ← All deliveries
    </Link>
  );

  if (query.isPending) return <LoadingState label="Loading delivery…" />;
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-4">
        {back}
        {missing ? (
          <p className="text-sm text-slate-600">This delivery does not exist, or belongs to another organisation.</p>
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }

  const delivery = query.data;
  const replayable = REPLAYABLE.has(delivery.status);

  return (
    <>
      <div className="mb-4">{back}</div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-xl font-semibold text-slate-900">{delivery.event_type}</h1>
            <DeliveryStatusBadge status={delivery.status} />
          </div>
          <p className="mt-1 break-all font-mono text-sm text-slate-600">{delivery.endpoint_url}</p>
        </div>
        {canEdit && (
          <div className="text-right">
            <Button
              variant="primary"
              busy={replay.isPending}
              disabled={!replayable}
              onClick={() => replay.mutate()}
            >
              Replay
            </Button>
            {!replayable && (
              <p className="mt-1 text-xs text-slate-500">Still on its way: nothing to replay yet.</p>
            )}
          </div>
        )}
      </div>

      {replay.isError && (
        <div className="mb-4">
          <ErrorState error={replay.error} />
        </div>
      )}
      {replay.isSuccess && (
        <p role="status" className="mb-4 rounded-md bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          Queued for replay. This page updates as the new attempt happens.
        </p>
      )}

      <Card className="mb-6 p-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">Attempts since last replay</dt>
            <dd className="font-medium text-slate-900">{delivery.attempts}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Created</dt>
            <dd className="font-medium text-slate-900" title={fullDate(delivery.created_at)}>
              {timeAgo(delivery.created_at)}
            </dd>
          </div>
          {(delivery.status === "retrying" || delivery.status === "pending") && (
            <div>
              <dt className="text-xs text-slate-500">Next attempt</dt>
              <dd className="font-medium text-slate-900" title={fullDate(delivery.next_attempt_at)}>
                {timeAgo(delivery.next_attempt_at)}
              </dd>
            </div>
          )}
          <div className="sm:col-span-2">
            <dt className="text-xs text-slate-500">Message ID (webhook-id)</dt>
            <dd className="break-all font-mono text-xs text-slate-900">{delivery.event_id}</dd>
          </div>
          {delivery.last_error && (
            <div className="sm:col-span-2 lg:col-span-4">
              <dt className="text-xs text-slate-500">Last error</dt>
              <dd className="font-medium text-red-700">{delivery.last_error}</dd>
            </div>
          )}
        </dl>
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        <section aria-labelledby="attempts-heading" className="lg:col-span-3">
          <h2 id="attempts-heading" className="mb-3 text-sm font-semibold text-slate-900">
            Attempts
          </h2>
          <Card className="p-5">
            {delivery.attempt_log.length === 0 ? (
              <p className="text-sm text-slate-500">
                No attempt has been made yet. A worker will pick this delivery up shortly.
              </p>
            ) : (
              <ol className="space-y-5 border-l border-slate-200 pl-0 [&>li]:-ml-1.5">
                {delivery.attempt_log.map((attempt, index) => (
                  <AttemptItem
                    key={attempt.id}
                    attempt={attempt}
                    previous={delivery.attempt_log[index - 1]}
                  />
                ))}
              </ol>
            )}
          </Card>
        </section>
        <section aria-labelledby="payload-heading" className="lg:col-span-2">
          <h2 id="payload-heading" className="mb-3 text-sm font-semibold text-slate-900">
            Event payload
          </h2>
          <Card className="p-4">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-slate-800">
              {JSON.stringify(delivery.payload, null, 2)}
            </pre>
          </Card>
        </section>
      </div>
    </>
  );
}
