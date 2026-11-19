import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AttemptsChart, LatencyChart, Sparkline, StateBreakdown } from "../components/charts";
import { useEndpoints } from "../components/delivery";
import { CheckIcon, ChevronIcon } from "../components/icons";
import { CountUp, ErrorState, PageHeader, SectionTitle, Skeleton, cx } from "../components/ui";
import { api } from "../lib/api";
import { milliseconds, percent } from "../lib/format";
import type { Overview } from "../lib/types";

export const OVERVIEW_KEY = ["stats", "overview"] as const;

export function useOverview() {
  return useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => api<Overview>("/v1/stats/overview"),
    refetchInterval: 15_000,
  });
}

function successTone(rate: number | null): "ok" | "warn" | "bad" | undefined {
  if (rate === null) return undefined;
  if (rate >= 0.99) return "ok";
  return rate >= 0.9 ? "warn" : "bad";
}

export interface Verdict {
  tone: "ok" | "warn" | "bad" | "idle";
  headline: string;
  detail: string;
}

/** The one-line answer to "is delivery healthy right now?". */
export function verdict(data: Overview): Verdict {
  const { dead, retrying } = data.deliveries_by_status;
  if (data.attempts === 0) {
    return { tone: "idle", headline: "Nothing delivered yet", detail: "No attempts in the last 24 hours." };
  }
  const rate = percent(data.success_rate);
  const accepted = `${rate} of attempts accepted in the last 24 hours`;
  if (dead > 0 || (data.success_rate ?? 0) < 0.9) {
    const waiting = dead === 1 ? "1 dead letter waiting" : `${dead.toLocaleString()} dead letters waiting`;
    return {
      tone: "bad",
      headline: "Deliveries are failing",
      detail: dead > 0 ? `${accepted}; ${waiting}.` : `${accepted}.`,
    };
  }
  if (retrying > 0 || (data.success_rate ?? 0) < 0.99) {
    return {
      tone: "warn",
      headline: "Delivering, with retries",
      detail: `${accepted}${retrying ? `; ${retrying.toLocaleString()} retrying` : ""}.`,
    };
  }
  return { tone: "ok", headline: "Delivering normally", detail: `${accepted}.` };
}

const VERDICT_STYLE: Record<Verdict["tone"], { bar: string; text: string; dot: string }> = {
  ok: { bar: "border-l-ok bg-ok-soft", text: "text-ok", dot: "bg-ok" },
  warn: { bar: "border-l-warn bg-warn-soft", text: "text-warn", dot: "bg-warn" },
  bad: { bar: "border-l-bad bg-bad-soft", text: "text-bad", dot: "bg-bad" },
  idle: { bar: "border-l-line-strong bg-hover/60", text: "text-fg-2", dot: "bg-pending" },
};

function VerdictLine({ value }: { value: Verdict }) {
  const style = VERDICT_STYLE[value.tone];
  return (
    <p
      role="status"
      className={cx(
        "mb-8 flex animate-rise flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[5px] border-l-[3px] px-4 py-3.5 transition-colors duration-300",
        style.bar,
      )}
    >
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className={cx("h-2 w-2 translate-y-[-1px] rounded-full", style.dot, value.tone === "ok" && "animate-pulse-dot")} />
        <span className={cx("font-display text-lg font-semibold tracking-[-0.01em]", style.text)}>
          {value.headline}
        </span>
      </span>
      <span className="text-[15px] text-fg-2">{value.detail}</span>
    </p>
  );
}

/** One figure in the ledger row: a label, a number that counts up, a note. */
function Figure({
  label,
  children,
  note,
  tone,
  to,
}: {
  label: string;
  children: React.ReactNode;
  note: string;
  tone?: "ok" | "warn" | "bad";
  to?: string;
}) {
  const body = (
    <>
      <dt className="text-[13px] text-fg-2">{label}</dt>
      <dd
        className={cx(
          "tabular font-display mt-1 text-[32px] font-semibold leading-tight tracking-[-0.03em]",
          tone ? { ok: "text-ok", warn: "text-warn", bad: "text-bad" }[tone] : "text-fg",
        )}
      >
        {children}
      </dd>
      <dd className="mt-1 text-xs text-fg-3">{note}</dd>
    </>
  );
  const box = "py-4 sm:px-6 sm:first:pl-0";
  return to ? (
    <Link to={to} className={cx(box, "group block transition-colors hover:[&_dt]:text-accent")}>
      <dl>{body}</dl>
    </Link>
  ) : (
    <dl className={box}>{body}</dl>
  );
}

/** Shown before anything has been delivered: the three steps to a first webhook. */
function GettingStarted({ hasEndpoint }: { hasEndpoint: boolean }) {
  const steps = [
    {
      done: hasEndpoint,
      title: "Point an endpoint at a server",
      text: "No server yet? Create a test receiver and use its one-click endpoint.",
      to: hasEndpoint ? "/endpoints" : "/receivers",
      action: hasEndpoint ? "View endpoints" : "Create a test receiver",
    },
    {
      done: false,
      title: "Send an event",
      text: 'Use "Send test event" on an endpoint, or POST to /v1/events with an API key.',
      to: hasEndpoint ? "/endpoints" : "/api-keys",
      action: hasEndpoint ? "Send a test event" : "Create an API key",
    },
    {
      done: false,
      title: "Watch it arrive",
      text: "Every attempt shows up on the live feed within a moment, then here.",
      to: "/live",
      action: "Open the live feed",
    },
  ];
  return (
    <section aria-labelledby="start-heading">
      <SectionTitle id="start-heading">Send your first webhook</SectionTitle>
      <p className="mb-4 text-[15px] text-fg-2">Three steps and this page fills in.</p>
      <ol className="overflow-hidden rounded-lg border border-line bg-panel">
        {steps.map((step, index) => (
          // On a phone the link goes on its own line under the text; from sm up it sits at the end of the row.
          <li
            key={step.title}
            style={{ animationDelay: `${index * 60}ms` }}
            className="grid animate-rise grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 border-b border-line px-5 py-4 last:border-0 sm:grid-cols-[auto_minmax(0,1fr)_auto] [animation-fill-mode:both]"
          >
            <span
              aria-hidden="true"
              className={cx(
                "font-display flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold",
                step.done ? "border-ok/40 bg-ok-soft text-ok" : "border-line-strong text-fg-2",
              )}
            >
              {step.done ? <CheckIcon width={14} height={14} /> : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cx("text-[15px] font-medium", step.done ? "text-fg-3 line-through" : "text-fg")}>
                {step.title}
              </p>
              <p className="mt-0.5 text-[13px] text-fg-2">{step.text}</p>
            </div>
            <Link
              to={step.to}
              className="group col-start-2 inline-flex items-center gap-1 justify-self-start text-[13px] font-medium text-accent hover:text-accent-hover sm:col-start-auto"
            >
              {step.action}
              <ChevronIcon width={14} height={14} className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading activity…">
      <Skeleton className="mb-8 h-14 w-full" />
      <div className="mb-12 grid grid-cols-2 gap-6 border-y border-line py-5 lg:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

export function OverviewPage() {
  const overview = useOverview();
  const endpoints = useEndpoints();

  const header = (
    <PageHeader
      title="Overview"
      description="How your webhooks have been doing over the last 24 hours."
      action={<span className="text-xs text-fg-3">Refreshed every 15 seconds</span>}
    />
  );

  if (overview.isPending) {
    return (
      <>
        {header}
        <OverviewSkeleton />
      </>
    );
  }
  if (overview.isError) {
    return (
      <>
        {header}
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      </>
    );
  }

  const data = overview.data;
  const counts = data.deliveries_by_status;
  const waiting = counts.pending + counts.retrying + counts.in_flight;
  const endpointOf = new Map(endpoints.data?.map((endpoint) => [endpoint.id, endpoint]));
  // Endpoints needing attention first: most failures, then busiest.
  const ranked = [...data.endpoints]
    .map((series) => ({
      ...series,
      total: series.succeeded.reduce((a, b) => a + b, 0) + series.failed.reduce((a, b) => a + b, 0),
      failures: series.failed.reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.failures - a.failures || b.total - a.total);

  return (
    <>
      {header}

      <VerdictLine value={verdict(data)} />

      {/* The ledger row: four figures on one rule-separated line. */}
      <div className="mb-12 grid grid-cols-2 border-y border-line lg:grid-cols-4 lg:divide-x lg:divide-line max-lg:[&>*:nth-child(-n+2)]:border-b max-lg:[&>*:nth-child(-n+2)]:border-line max-sm:[&>*:nth-child(even)]:pl-4 max-sm:[&>*:nth-child(odd)]:border-r max-sm:[&>*:nth-child(odd)]:border-line">
        <Figure label="Events received" note={`${data.attempts.toLocaleString()} delivery attempts`}>
          <CountUp value={data.events} />
        </Figure>
        <Figure
          label="Success rate"
          note={
            data.attempts
              ? `${data.successes.toLocaleString()} of ${data.attempts.toLocaleString()} attempts`
              : "No attempts yet"
          }
          tone={successTone(data.success_rate)}
        >
          {data.success_rate === null ? percent(null) : <CountUp value={data.success_rate} format={(n) => percent(n)} />}
        </Figure>
        <Figure label="p95 latency" note="95% of attempts faster than this">
          {data.p95_ms === null ? milliseconds(null) : <CountUp value={data.p95_ms} format={(n) => milliseconds(Math.round(n))} />}
        </Figure>
        <Figure
          label="Dead letters"
          note={waiting ? `${waiting.toLocaleString()} more still on their way` : "Nothing waiting"}
          tone={counts.dead > 0 ? "bad" : undefined}
          to="/dead-letter"
        >
          <CountUp value={counts.dead} />
        </Figure>
      </div>

      {data.attempts === 0 ? (
        <GettingStarted hasEndpoint={(endpoints.data?.length ?? 0) > 0} />
      ) : (
        <div className="space-y-12">
          <section aria-labelledby="attempts-heading">
            <SectionTitle
              id="attempts-heading"
              action={
                <div aria-hidden="true" className="flex items-center gap-4 text-xs text-fg-2">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-[2px] bg-ok" /> Delivered
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-[2px] bg-bad" /> Failed
                  </span>
                </div>
              }
            >
              Delivery attempts per hour
            </SectionTitle>
            <AttemptsChart buckets={data.buckets} />
          </section>

          <div className="grid gap-12 lg:grid-cols-5 lg:gap-10">
            <section aria-labelledby="latency-heading" className="lg:col-span-3">
              <SectionTitle id="latency-heading">p95 latency per hour</SectionTitle>
              <LatencyChart buckets={data.buckets} />
            </section>
            <section aria-labelledby="states-heading" className="lg:col-span-2">
              <SectionTitle
                id="states-heading"
                action={
                  <Link to="/deliveries" className="text-xs font-medium text-accent hover:text-accent-hover">
                    All deliveries
                  </Link>
                }
              >
                Where deliveries stand
              </SectionTitle>
              <StateBreakdown counts={counts} />
            </section>
          </div>

          {ranked.length > 0 && (
            <section aria-labelledby="busiest-heading">
              <SectionTitle
                id="busiest-heading"
                action={
                  <Link to="/endpoints" className="text-xs font-medium text-accent hover:text-accent-hover">
                    Manage endpoints
                  </Link>
                }
              >
                Endpoints by activity
              </SectionTitle>
              <ul className="divide-y divide-line">
                {ranked.map((series, index) => {
                  const endpoint = endpointOf.get(series.endpoint_id);
                  const url = endpoint?.url ?? "(deleted endpoint)";
                  const rate = series.total ? (series.total - series.failures) / series.total : null;
                  return (
                    <li
                      key={series.endpoint_id}
                      style={{ animationDelay: `${index * 50}ms` }}
                      className="flex animate-rise flex-wrap items-center gap-x-6 gap-y-2 py-3.5 [animation-fill-mode:both]"
                    >
                      {/* On a phone the name takes the whole first line; the numbers follow. */}
                      <div className="min-w-0 flex-1 max-sm:basis-full">
                        {endpoint?.description && (
                          <p className="truncate text-[15px] font-medium text-fg">{endpoint.description}</p>
                        )}
                        <p
                          className={cx("truncate font-mono text-xs", endpoint?.description ? "mt-0.5 text-fg-3" : "text-fg")}
                          title={url}
                        >
                          {url}
                        </p>
                      </div>
                      <Sparkline
                        succeeded={series.succeeded}
                        failed={series.failed}
                        label={`${series.total} attempts in 24 hours, ${series.failures} failed`}
                      />
                      <span className="tabular w-20 text-right text-[13px] text-fg-2">
                        {series.total.toLocaleString()} <span className="text-fg-3">sent</span>
                      </span>
                      <span
                        className={cx(
                          "tabular font-display w-16 text-right text-[15px] font-semibold",
                          { ok: "text-ok", warn: "text-warn", bad: "text-bad", none: "text-fg-2" }[successTone(rate) ?? "none"],
                        )}
                      >
                        {percent(rate)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}
