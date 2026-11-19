import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { JsonView } from "../components/JsonView";
import { DeliveryStatusBadge, errorKindLabel, readableError } from "../components/delivery";
import {
  AlertIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  CloseIcon,
  ReplayIcon,
} from "../components/icons";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  ErrorState,
  LoadingState,
  Notice,
  SectionTitle,
  cx,
} from "../components/ui";
import { ApiError, api } from "../lib/api";
import { fullDate, milliseconds, timeAgo } from "../lib/format";
import type { Attempt, Delivery, DeliveryDetail } from "../lib/types";

const REPLAYABLE = new Set(["dead", "succeeded"]);

/** Why a waiting delivery is not being sent right now, if there is a reason
 *  beyond the normal retry delay. Without this, "Pending" looks like a stall. */
export function holdReason(delivery: DeliveryDetail): string | null {
  if (delivery.status !== "pending" && delivery.status !== "retrying") return null;
  if (delivery.endpoint_status === "paused") {
    return "This endpoint is paused. The delivery will be sent when the endpoint is resumed.";
  }
  if (delivery.endpoint_status === "disabled") {
    return "This endpoint is disabled, so nothing is being sent to it.";
  }
  if (delivery.endpoint_breaker_state !== "closed") {
    return (
      "This endpoint has been failing, so Relay has stopped sending to it for now. " +
      "It tries one delivery about every minute, and resumes all of them as soon as one succeeds. " +
      "Waiting like this does not use up retry attempts."
    );
  }
  return null;
}

/** 95 -> "1 min 35 s", 7200 -> "2 h". The wait between attempts, i.e. the backoff. */
export function gap(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest && minutes < 10 ? `${minutes} min ${rest} s` : `${Math.round(seconds / 60)} min`;
  }
  const hours = seconds / 3600;
  return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} h`;
}

function HeaderList({ title, headers }: { title: string; headers: Record<string, string> | null }) {
  const entries = Object.entries(headers ?? {});
  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-xs text-fg-3">{title}</h4>
      {entries.length === 0 ? (
        <p className="text-xs text-fg-3">None recorded.</p>
      ) : (
        <dl className="space-y-1 font-mono text-xs">
          {entries.map(([name, value]) => (
            <div key={name} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3">
              <dt className="truncate text-fg-3" title={name}>
                {name}
              </dt>
              <dd className="break-all text-fg-2">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function AttemptItem({ attempt, previous, last }: { attempt: Attempt; previous?: Attempt; last: boolean }) {
  const [open, setOpen] = useState(false);
  const ok = attempt.error_kind === null;
  // The gap since the previous attempt makes the backoff schedule visible.
  const gapSeconds = previous
    ? Math.round(
        (new Date(attempt.started_at).getTime() - new Date(previous.started_at).getTime()) / 1000,
      )
    : null;

  return (
    <li className="relative pl-9">
      {/* The rail joining this attempt to the next one. */}
      {!last && <span aria-hidden="true" className="absolute bottom-[-1.25rem] left-[11px] top-7 w-px bg-line-strong" />}
      <span
        aria-hidden="true"
        className={cx(
          "absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full border",
          ok ? "border-ok/40 bg-ok-soft" : "border-bad/40 bg-bad-soft",
        )}
      >
        <span className={cx("h-2 w-2 rounded-full", ok ? "bg-ok" : "bg-bad")} />
      </span>

      {gapSeconds !== null && (
        <p className="mb-1 flex items-center gap-1.5 text-2xs text-fg-3">
          <ClockIcon width={11} height={11} />
          {gap(gapSeconds)} after the previous attempt
        </p>
      )}
      <div className="rounded-lg border border-line bg-raised/40">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
          <span className="text-[13px] font-medium text-fg">Attempt {attempt.attempt_number}</span>
          <Badge tone={ok ? "green" : "red"}>
            {attempt.status_code !== null ? `HTTP ${attempt.status_code}` : errorKindLabel(attempt.error_kind)}
          </Badge>
          {!ok && attempt.status_code !== null && (
            <span className="text-xs text-fg-3">{errorKindLabel(attempt.error_kind)}</span>
          )}
          <span className="tabular ml-auto text-xs text-fg-2">{milliseconds(attempt.duration_ms)}</span>
          <time className="tabular text-xs text-fg-3" dateTime={attempt.started_at} title={fullDate(attempt.started_at)}>
            {new Date(attempt.started_at).toLocaleTimeString([], { hourCycle: "h23" })}
          </time>
        </div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-1 border-t border-line px-4 py-2 text-left text-xs text-fg-3 transition-colors hover:bg-hover/50 hover:text-fg-2"
        >
          <ChevronIcon width={12} height={12} className={cx("transition-transform", open && "rotate-90")} />
          {open ? "Hide details" : "Show request and response"}
        </button>
        {open && (
          <div className="grid gap-6 border-t border-line px-4 py-4 lg:grid-cols-2">
            <HeaderList title="Request headers" headers={attempt.request_headers} />
            <div className="min-w-0 space-y-5">
              <HeaderList title="Response headers" headers={attempt.response_headers} />
              <div>
                <h4 className="mb-2 text-xs text-fg-3">
                  Response body (first part)
                </h4>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-canvas p-3 font-mono text-xs text-fg-2">
                  {attempt.response_snippet || "(empty)"}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/** The step still to come, at the end of the timeline. */
function NextStep({ delivery }: { delivery: DeliveryDetail }) {
  if (delivery.status === "succeeded" || delivery.status === "dead") {
    const ok = delivery.status === "succeeded";
    return (
      <li className="relative pl-9">
        <span
          aria-hidden="true"
          className={cx(
            "absolute left-0 top-0 flex h-6 w-6 items-center justify-center rounded-full border text-2xs",
            ok ? "border-ok/40 text-ok" : "border-bad/40 text-bad",
          )}
        >
          {ok ? <CheckIcon width={13} height={13} /> : <CloseIcon width={12} height={12} />}
        </span>
        <p className="pt-0.5 text-[13px] text-fg-2">
          {ok ? "Delivered. Nothing more to do." : "Out of attempts: moved to the dead-letter queue."}
        </p>
      </li>
    );
  }
  return (
    <li className="relative pl-9">
      <span aria-hidden="true" className="absolute left-0 top-0 flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-line-strong">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-3" />
      </span>
      <p className="pt-0.5 text-[13px] text-fg-2">
        {delivery.status === "in_flight"
          ? "Sending now…"
          : `Next attempt ${timeAgo(delivery.next_attempt_at)}`}
        <span className="ml-2 text-xs text-fg-3">{fullDate(delivery.next_attempt_at)}</span>
      </p>
    </li>
  );
}

function Fact({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className={cx("mt-1.5 flex min-w-0 items-center gap-1 text-[13px] text-fg", mono && "font-mono text-xs")}>
        {children}
      </dd>
    </div>
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
    <Link
      to="/deliveries"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-3 transition-colors hover:text-fg"
    >
      <ArrowLeftIcon width={13} height={13} />
      All deliveries
    </Link>
  );

  if (query.isPending) return <LoadingState label="Loading delivery…" />;
  if (query.isError) {
    // 404: no such delivery here. 422: the id in the address is not even an id
    // (a mistyped or truncated link). To the person looking, both mean the same.
    const missing =
      query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 422);
    return (
      <div className="space-y-4">
        {back}
        {missing ? (
          <p className="text-[13px] text-fg-2">
            This delivery does not exist, or belongs to another organisation.
          </p>
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }

  const delivery = query.data;
  const replayable = REPLAYABLE.has(delivery.status);
  const hold = holdReason(delivery);

  return (
    <>
      <div className="mb-5">{back}</div>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-xl font-medium tracking-[-0.02em] text-fg">{delivery.event_type}</h1>
            <DeliveryStatusBadge status={delivery.status} />
          </div>
          <p className="mt-2 flex items-center gap-2 text-[13px] text-fg-3">
            to
            <span className="break-all font-mono text-xs text-fg-2">{delivery.endpoint_url}</span>
          </p>
        </div>
        {canEdit && (
          <div className="text-right">
            <Button
              variant="primary"
              icon={<ReplayIcon width={14} height={14} />}
              busy={replay.isPending}
              disabled={!replayable}
              onClick={() => replay.mutate()}
            >
              Replay
            </Button>
            {!replayable && (
              <p className="mt-1.5 text-xs text-fg-3">Still on its way: nothing to replay yet.</p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-4 empty:hidden">
        {replay.isError && <ErrorState error={replay.error} />}
        {replay.isSuccess && (
          <Notice>Queued for replay. This page updates as the new attempt happens.</Notice>
        )}
        {hold && (
          <p
            role="status"
            className="flex gap-2.5 rounded-lg border border-warn/25 bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-[#f8d59a]"
          >
            <AlertIcon className="mt-0.5 shrink-0 text-warn" />
            <span>
              <strong className="font-medium text-warn">On hold.</strong> {hold}
            </span>
          </p>
        )}
      </div>

      <Card className={cx("overflow-hidden", (hold || replay.isError || replay.isSuccess) && "mt-6")}>
        <dl className="grid divide-line sm:grid-cols-2 sm:divide-x lg:grid-cols-4 max-sm:divide-y">
          <Fact label="Attempts since last replay">
            <span className="tabular">{delivery.attempts}</span>
          </Fact>
          <Fact label="Created">
            <span title={fullDate(delivery.created_at)}>{timeAgo(delivery.created_at)}</span>
          </Fact>
          <Fact label="Message ID (webhook-id)" mono>
            <span className="truncate" title={delivery.event_id}>
              {delivery.event_id}
            </span>
            <CopyButton value={delivery.event_id} label="Copy message ID" />
          </Fact>
          <Fact label="Delivery ID" mono>
            <span className="truncate" title={delivery.id}>
              {delivery.id}
            </span>
            <CopyButton value={delivery.id} label="Copy delivery ID" />
          </Fact>
        </dl>
        {delivery.last_error && (
          <div className="border-t border-line bg-bad-soft/40 px-5 py-3">
            <p className="text-xs text-fg-3">Last error</p>
            <p className="mt-1 text-[13px] text-[#ff9b9b]">{readableError(delivery.last_error)}</p>
          </div>
        )}
      </Card>

      <div className="mt-10 grid gap-10 lg:grid-cols-5 lg:gap-8">
        <section aria-labelledby="attempts-heading" className="lg:col-span-3">
          <SectionTitle id="attempts-heading">Attempts</SectionTitle>
          {delivery.attempt_log.length === 0 ? (
            <Card className="px-5 py-6">
              <p className="text-[13px] text-fg-2">
                No attempt has been made yet. A worker will pick this delivery up shortly.
              </p>
            </Card>
          ) : (
            <ol className="space-y-5">
              {delivery.attempt_log.map((attempt, index) => (
                <AttemptItem
                  key={attempt.id}
                  attempt={attempt}
                  previous={delivery.attempt_log[index - 1]}
                  last={false}
                />
              ))}
              <NextStep delivery={delivery} />
            </ol>
          )}
        </section>
        <section aria-labelledby="payload-heading" className="min-w-0 lg:col-span-2">
          <SectionTitle id="payload-heading">Event payload</SectionTitle>
          <JsonView value={delivery.payload} title="payload.json" />
        </section>
      </div>
    </>
  );
}
