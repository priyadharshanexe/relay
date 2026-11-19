import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useEndpoints } from "../components/delivery";
import { AttemptsChart, LatencyChart, Sparkline, StateBreakdown } from "../components/charts";
import { CheckIcon, ChevronIcon } from "../components/icons";
import { Card, ErrorState, LoadingState, PageHeader, SectionTitle, cx } from "../components/ui";
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

function Figure({
  label,
  value,
  note,
  tone,
  to,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "ok" | "warn" | "bad";
  to?: string;
}) {
  const body = (
    <>
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd
        className={cx(
          "tabular mt-1.5 text-[26px] font-semibold leading-none tracking-[-0.03em]",
          tone ? { ok: "text-ok", warn: "text-warn", bad: "text-bad" }[tone] : "text-fg",
        )}
      >
        {value}
      </dd>
      <dd className="mt-2 text-xs text-fg-3">{note}</dd>
    </>
  );
  const box = "px-5 py-4";
  return to ? (
    <Link to={to} className={cx(box, "group block transition-colors hover:bg-raised/60")}>
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
    <Card className="overflow-hidden">
      <div className="border-b border-line px-6 py-5">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Send your first webhook</h2>
        <p className="mt-1 text-[13px] text-fg-2">
          Nothing has been delivered in the last 24 hours. Three steps and this page fills in.
        </p>
      </div>
      <ol className="divide-y divide-line">
        {steps.map((step, index) => (
          <li key={step.title} className="flex flex-wrap items-center gap-4 px-6 py-4">
            <span
              aria-hidden="true"
              className={cx(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                step.done ? "border-ok/40 bg-ok-soft text-ok" : "border-line-strong text-fg-2",
              )}
            >
              {step.done ? <CheckIcon width={14} height={14} /> : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cx("text-[13px] font-medium", step.done ? "text-fg-3 line-through" : "text-fg")}>
                {step.title}
              </p>
              <p className="mt-0.5 text-xs text-fg-3">{step.text}</p>
            </div>
            <Link
              to={step.to}
              className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:text-accent-hover"
            >
              {step.action}
              <ChevronIcon width={14} height={14} />
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function OverviewPage() {
  const overview = useOverview();
  const endpoints = useEndpoints();

  const header = (
    <PageHeader
      title="Overview"
      description="How your webhooks have been doing over the last 24 hours."
      action={
        <span className="inline-flex h-7 items-center gap-2 rounded-md border border-line px-2.5 text-xs text-fg-2">
          <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-ok" />
          Last 24 hours · updates every 15 s
        </span>
      }
    />
  );

  if (overview.isPending) {
    return (
      <>
        {header}
        <LoadingState label="Loading activity…" />
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
  const busiest = [...data.endpoints]
    .map((series) => ({
      ...series,
      total: series.succeeded.reduce((a, b) => a + b, 0) + series.failed.reduce((a, b) => a + b, 0),
      failures: series.failed.reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total);

  return (
    <>
      {header}

      <Card className="mb-10 overflow-hidden">
        <div className="grid grid-cols-2 divide-line max-lg:[&>*:nth-child(-n+2)]:border-b max-lg:[&>*]:border-line lg:grid-cols-4 lg:divide-x [&>*:nth-child(odd)]:max-lg:border-r">
          <Figure label="Events received" value={data.events.toLocaleString()} note={`${data.attempts.toLocaleString()} delivery attempts`} />
          <Figure
            label="Success rate"
            value={percent(data.success_rate)}
            note={data.attempts ? `${data.successes.toLocaleString()} of ${data.attempts.toLocaleString()} attempts` : "No attempts yet"}
            tone={successTone(data.success_rate)}
          />
          <Figure label="p95 latency" value={milliseconds(data.p95_ms)} note="95% of attempts faster than this" />
          <Figure
            label="Dead letters"
            value={counts.dead.toLocaleString()}
            note={waiting ? `${waiting.toLocaleString()} more still on their way` : "Nothing waiting"}
            tone={counts.dead > 0 ? "bad" : undefined}
            to="/dead-letter"
          />
        </div>
      </Card>

      {data.attempts === 0 ? (
        <GettingStarted hasEndpoint={(endpoints.data?.length ?? 0) > 0} />
      ) : (
        <div className="space-y-10">
          <section aria-labelledby="attempts-heading">
            <SectionTitle
              id="attempts-heading"
              action={
                <div aria-hidden="true" className="flex items-center gap-4 text-xs text-fg-2">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-accent" /> Delivered
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-bad" /> Failed
                  </span>
                </div>
              }
            >
              Delivery attempts per hour
            </SectionTitle>
            <Card className="px-5 pb-4 pt-6">
              <AttemptsChart buckets={data.buckets} />
            </Card>
          </section>

          <div className="grid gap-10 lg:grid-cols-5 lg:gap-6">
            <section aria-labelledby="latency-heading" className="lg:col-span-3">
              <SectionTitle id="latency-heading">p95 latency per hour</SectionTitle>
              <Card className="px-5 pb-4 pt-6">
                <LatencyChart buckets={data.buckets} />
              </Card>
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
              <Card className="p-5">
                <StateBreakdown counts={counts} />
              </Card>
            </section>
          </div>

          {busiest.length > 0 && (
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
              <Card>
                <ul className="divide-y divide-line">
                  {busiest.map((series) => {
                    const endpoint = endpointOf.get(series.endpoint_id);
                    const url = endpoint?.url ?? "(deleted endpoint)";
                    const rate = series.total ? (series.total - series.failures) / series.total : null;
                    return (
                      <li key={series.endpoint_id} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3.5">
                        <div className="min-w-0 flex-1">
                          {endpoint?.description && (
                            <p className="truncate text-[13px] font-medium text-fg">{endpoint.description}</p>
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
                            "tabular w-14 text-right text-[13px] font-medium",
                            { ok: "text-ok", warn: "text-warn", bad: "text-bad", none: "text-fg-2" }[successTone(rate) ?? "none"],
                          )}
                        >
                          {percent(rate)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}
    </>
  );
}
