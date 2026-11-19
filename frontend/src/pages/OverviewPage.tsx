import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { DeliveryMap, type MapEndpoint, useTraffic } from "../components/DeliveryMap";
import { AttemptsChart, LatencyChart, Sparkline, StateBreakdown } from "../components/charts";
import { useEndpoints } from "../components/delivery";
import { CheckIcon, ChevronIcon, SendIcon } from "../components/icons";
import { Odometer, RevealText, Stagger, StaggerItem, useSpotlight, useToast } from "../components/motionkit";
import { Button, ErrorState, SectionTitle, Skeleton, cx } from "../components/ui";
import { api } from "../lib/api";
import { milliseconds, percent } from "../lib/format";
import type { Endpoint, EndpointCreated, LiveUpdate, Overview, Receiver } from "../lib/types";
import { useLiveFeed } from "./LivePage";

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

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad" } as const;

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

// ------------------------------------------------------------------ helpers
/** The live stream, where the browser has one (tests and old browsers don't). */
function useOptionalLiveFeed(orgId: string): LiveUpdate[] {
  const available = typeof window !== "undefined" && typeof window.EventSource === "function";
  return available ? useLiveFeedSafe(orgId) : [];
}
function useLiveFeedSafe(orgId: string): LiveUpdate[] {
  return useLiveFeed(orgId).updates;
}

/** True on a narrow screen, where the map is drawn top to bottom. */
function useNarrow(): boolean {
  const query = "(max-width: 639px)";
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

const SIMULATED: MapEndpoint[] = [
  { id: "sim-orders", name: "orders-api (example)", state: "closed", ok: 0, failed: 0 },
  { id: "sim-billing", name: "billing (example)", state: "closed", ok: 0, failed: 0 },
  { id: "sim-crm", name: "crm-sync (example)", state: "half_open", ok: 0, failed: 0 },
];

/**
 * "Send a test event": through an existing endpoint, or, on a brand-new
 * account, through a test receiver and endpoint created for the purpose.
 */
function useSendTestEvent(endpoints: Endpoint[] | undefined) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async () => {
      let target =
        endpoints?.find((e) => e.status === "active" && e.breaker_state === "closed") ?? endpoints?.[0];
      let created = false;
      if (!target) {
        const receiver = await api<Receiver>("/v1/receivers", {
          method: "POST",
          body: { name: "Getting-started receiver" },
        });
        target = await api<EndpointCreated>("/v1/endpoints", {
          method: "POST",
          body: { url: receiver.url, description: "Getting started" },
        });
        created = true;
      }
      await api(`/v1/endpoints/${target.id}/test`, { method: "POST" });
      return { created };
    },
    onSuccess: async ({ created }) => {
      toast(
        created
          ? "Created a test receiver and endpoint, and sent an event. Watch it travel."
          : "Test event sent. Watch it travel.",
      );
      await queryClient.invalidateQueries({ queryKey: ["endpoints"] });
      await queryClient.invalidateQueries({ queryKey: ["receivers"] });
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY }), 2500);
    },
    onError: () => toast("Could not send the test event.", "bad"),
  });
}

// --------------------------------------------------------------------- hero
const BEACON = {
  live: { label: "Live", colour: "text-ok", note: "attempts appear as they happen" },
  simulation: { label: "Simulation", colour: "text-warn", note: "no live traffic yet: example data" },
  quiet: { label: "Live", colour: "text-fg-3", note: "waiting for the next attempt" },
} as const;

function Hero({ data, endpoints }: { data: Overview; endpoints: Endpoint[] | undefined }) {
  const { organization, canEdit } = useAuth();
  const updates = useOptionalLiveFeed(organization.id);
  const narrow = useNarrow();
  const send = useSendTestEvent(endpoints);
  const spotlight = useSpotlight();

  const real: MapEndpoint[] = useMemo(() => {
    const series = new Map(data.endpoints.map((s) => [s.endpoint_id, s]));
    return (endpoints ?? []).map((e) => {
      const s = series.get(e.id);
      return {
        id: e.id,
        name: e.description || new URL(e.url, "http://x").host,
        state: e.status === "paused" ? "paused" : e.breaker_state,
        ok: s ? s.succeeded.reduce((a, b) => a + b, 0) : 0,
        failed: s ? s.failed.reduce((a, b) => a + b, 0) : 0,
      };
    });
  }, [endpoints, data.endpoints]);

  const simulate = data.attempts === 0;
  const base = real.length ? real : SIMULATED;
  const traffic = useTraffic({
    endpointIds: base.map((e) => e.id),
    updates,
    simulate,
  });
  // Node counters move with the packets that land on them (real or example).
  const shownEndpoints = base.map((endpoint, index) => ({
    ...endpoint,
    ok: endpoint.ok + (traffic.tally[index]?.ok ?? 0),
    failed: endpoint.failed + (traffic.tally[index]?.failed ?? 0),
  }));
  const example = traffic.simulating;
  const mode = traffic.simulating ? "simulation" : traffic.live ? "live" : "quiet";
  const beacon = BEACON[mode];
  const counts = data.deliveries_by_status;
  const v = verdict(data);
  const verdictColour = v.tone === "idle" ? "text-fg" : TONE_TEXT[v.tone];

  return (
    <section
      aria-labelledby="hero-heading"
      {...spotlight}
      className="spotlight relative mb-12 overflow-hidden rounded-2xl border border-line bg-panel shadow-pop"
    >
      {/* The map's own texture: a finer dot grid than the page's. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--dot)_1px,transparent_1px)] [background-size:14px_14px] opacity-80" />
      <div className="relative grid gap-8 p-5 sm:p-8 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] lg:gap-10">
        <div className="order-2 min-w-0 lg:order-1">
          <DeliveryMap
            endpoints={shownEndpoints}
            packets={traffic.packets}
            onDone={traffic.done}
            waiting={counts.pending + counts.retrying + counts.in_flight}
            dead={counts.dead + traffic.deadLanded * (traffic.simulating ? 1 : 0)}
            vertical={narrow}
            simulated={example}
          />
        </div>

        <div className="order-1 flex flex-col lg:order-2">
          <p className="flex items-center gap-2.5 text-xs font-medium">
            <span className={cx("beacon relative inline-flex h-2 w-2 rounded-full bg-current", beacon.colour, mode === "quiet" && "[&::before]:hidden [&::after]:hidden")} />
            <span className={beacon.colour}>{beacon.label}</span>
            <span className="text-fg-3">· {beacon.note}</span>
          </p>

          <h2 id="hero-heading" className={cx("mt-5 text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] sm:text-[40px]", verdictColour)}>
            <RevealText>{v.headline}</RevealText>
          </h2>
          <p className="mt-3 text-[15px] leading-relaxed text-fg-2">{v.detail}</p>

          {/* While the simulation runs these are example numbers, and look it:
              dashed, tagged, and never in a state colour. */}
          <dl
            className={cx(
              "mt-7 grid grid-cols-2 overflow-hidden rounded-lg",
              example ? "border border-dashed border-line-strong" : "gap-px border border-line bg-line",
            )}
          >
            <div className={cx("px-4 py-3", example ? "bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--color-hover)_6px_7px)]" : "bg-panel")}>
              <dt className="flex items-center gap-2 text-xs text-fg-3">
                Attempts, last minute
                {example && <span className="rounded-[3px] border border-line-strong px-1 text-2xs uppercase tracking-wide">example</span>}
              </dt>
              <dd className={cx("font-display mt-1 text-[28px] font-semibold leading-none tracking-[-0.03em]", example ? "text-fg-2" : "text-fg")}>
                <Odometer value={String(traffic.perMinute)} />
              </dd>
            </div>
            <div className={cx("px-4 py-3", example ? "bg-[repeating-linear-gradient(135deg,transparent_0_6px,var(--color-hover)_6px_7px)]" : "bg-panel")}>
              <dt className="flex items-center gap-2 text-xs text-fg-3">
                Accepted, last minute
                {example && <span className="rounded-[3px] border border-line-strong px-1 text-2xs uppercase tracking-wide">example</span>}
              </dt>
              <dd
                className={cx(
                  "font-display mt-1 text-[28px] font-semibold leading-none tracking-[-0.03em]",
                  example || traffic.successRate === null
                    ? "text-fg-2"
                    : TONE_TEXT[successTone(traffic.successRate) ?? "ok"],
                )}
              >
                {traffic.successRate === null ? "—" : <Odometer value={`${Math.round(traffic.successRate * 100)}%`} />}
              </dd>
            </div>
          </dl>

          <div className="mt-7 flex flex-wrap items-center gap-3 lg:mt-auto lg:pt-7">
            <Button
              variant="primary"
              className="h-11 px-5 text-[15px]"
              disabled={!canEdit}
              busy={send.isPending}
              icon={
                send.isSuccess ? (
                  <CheckIcon key="ok" className="animate-pop" width={16} height={16} />
                ) : (
                  <SendIcon key="send" width={16} height={16} />
                )
              }
              title={canEdit ? undefined : "Viewers can't send events"}
              onClick={() => send.mutate()}
            >
              Send a test event
            </Button>
            <span className="text-xs text-fg-3">
              {endpoints?.length ? "Goes to your first healthy endpoint." : "Sets up a test receiver for you."}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ figures panel
function Cell({
  label,
  value,
  note,
  tone,
  to,
}: {
  label: string;
  value: ReactNode;
  note: string;
  tone?: "ok" | "warn" | "bad";
  to?: string;
}) {
  const spotlight = useSpotlight();
  const body = (
    <dl>
      <dt className="text-[13px] text-fg-2">{label}</dt>
      <dd className={cx("font-display mt-2 text-[30px] font-semibold leading-none tracking-[-0.03em]", tone ? TONE_TEXT[tone] : "text-fg")}>
        {value}
      </dd>
      <dd className="mt-2 text-xs text-fg-3">{note}</dd>
    </dl>
  );
  const box = "spotlight block h-full rounded-lg border border-line bg-panel p-5 transition-transform duration-200 hover:-translate-y-0.5";
  return to ? (
    <Link to={to} {...spotlight} className={box}>
      {body}
    </Link>
  ) : (
    <div {...spotlight} className={box}>
      {body}
    </div>
  );
}

function Figures({ data }: { data: Overview }) {
  const counts = data.deliveries_by_status;
  const waiting = counts.pending + counts.retrying + counts.in_flight;
  const tone = successTone(data.success_rate);
  return (
    <section aria-label="Key figures" className="mb-14 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      {/* The one number that matters most, printed large. */}
      <dl className="flex flex-col justify-between rounded-lg border border-line bg-sunken/60 p-6">
        <dt className="text-[13px] text-fg-2">Success rate</dt>
        <dd
          className={cx(
            "font-display my-4 text-[72px] font-bold leading-[0.9] tracking-[-0.05em] sm:text-[96px]",
            tone ? TONE_TEXT[tone] : "text-fg-3",
          )}
        >
          {data.success_rate === null ? percent(null) : <Odometer value={percent(data.success_rate)} />}
        </dd>
        <dd className="text-xs text-fg-3">
          {data.attempts
            ? `${data.successes.toLocaleString()} of ${data.attempts.toLocaleString()} attempts`
            : "No attempts yet"}{" "}
          · last 24 hours
        </dd>
      </dl>
      <Stagger className="grid grid-cols-2 gap-4">
        {[
          <StaggerItem key="events" className="h-full">
            <Cell label="Events received" value={<Odometer value={data.events.toLocaleString()} />} note={`${data.attempts.toLocaleString()} delivery attempts`} />
          </StaggerItem>,
          <StaggerItem key="p95" className="h-full">
            <Cell label="p95 latency" value={milliseconds(data.p95_ms)} note="95% of attempts faster than this" />
          </StaggerItem>,
          <StaggerItem key="waiting" className="h-full">
            <Cell
              label="Waiting"
              value={<Odometer value={waiting.toLocaleString()} />}
              note={counts.retrying ? `${counts.retrying.toLocaleString()} retrying` : "Nothing retrying"}
              tone={counts.retrying ? "warn" : undefined}
            />
          </StaggerItem>,
          <StaggerItem key="dead" className="h-full">
            <Cell
              label="Dead letters"
              value={<Odometer value={counts.dead.toLocaleString()} />}
              note={waiting ? `${waiting.toLocaleString()} more still on their way` : "Nothing waiting"}
              tone={counts.dead > 0 ? "bad" : undefined}
              to="/dead-letter"
            />
          </StaggerItem>,
        ]}
      </Stagger>
    </section>
  );
}

// ----------------------------------------------------------- getting started
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
      text: 'Use "Send a test event" above, or POST to /v1/events with an API key.',
      to: hasEndpoint ? "/endpoints" : "/api-keys",
      action: hasEndpoint ? "Send a test event" : "Create an API key",
    },
    {
      done: false,
      title: "Watch it arrive",
      text: "Every attempt travels across the map above and shows up on the live feed.",
      to: "/live",
      action: "Open the live feed",
    },
  ];
  return (
    <section aria-labelledby="start-heading">
      <SectionTitle id="start-heading">Send your first webhook</SectionTitle>
      <Stagger as="ol" className="grid gap-4 md:grid-cols-3">
        {steps.map((step, index) => (
          <StaggerItem key={step.title} as="li" className="h-full">
            <div className="flex h-full flex-col rounded-lg border border-line bg-panel p-5">
              <span
                aria-hidden="true"
                className={cx(
                  "font-display flex h-10 w-10 items-center justify-center rounded-full border text-lg font-bold",
                  step.done ? "border-ok/50 bg-ok-soft text-ok" : "border-line-strong text-fg",
                )}
              >
                {step.done ? <CheckIcon width={16} height={16} /> : index + 1}
              </span>
              <p className={cx("mt-4 text-[15px] font-semibold", step.done ? "text-fg-3 line-through" : "text-fg")}>
                {step.title}
              </p>
              <p className="mt-1 flex-1 text-[13px] text-fg-2">{step.text}</p>
              <Link
                to={step.to}
                className="group mt-4 inline-flex items-center gap-1 self-start text-[13px] font-medium text-accent hover:text-accent-hover"
              >
                {step.action}
                <ChevronIcon width={14} height={14} className="transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading activity…">
      <Skeleton className="mb-12 h-[380px] w-full rounded-2xl" />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.6fr]">
        <Skeleton className="h-48" />
        <div className="grid grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-[100px]" />
          ))}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- page
export function OverviewPage() {
  const overview = useOverview();
  const endpoints = useEndpoints();

  const header = (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <h1 className="text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] text-fg">
        <RevealText>Overview</RevealText>
      </h1>
      <span className="text-xs text-fg-3">Last 24 hours · refreshed every 15 seconds</span>
    </div>
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
      <Hero data={data} endpoints={endpoints.data} />

      {data.attempts === 0 ? (
        <GettingStarted hasEndpoint={(endpoints.data?.length ?? 0) > 0} />
      ) : (
        <>
          <Figures data={data} />
          <div className="space-y-14">
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

            <div className="grid gap-14 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-10">
              <section aria-labelledby="latency-heading">
                <SectionTitle id="latency-heading">p95 latency per hour</SectionTitle>
                <LatencyChart buckets={data.buckets} />
              </section>
              <section aria-labelledby="states-heading">
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
                <Stagger as="ul" className="grid gap-3">
                  {ranked.map((series) => {
                    const endpoint = endpointOf.get(series.endpoint_id);
                    const url = endpoint?.url ?? "(deleted endpoint)";
                    const rate = series.total ? (series.total - series.failures) / series.total : null;
                    return (
                      <StaggerItem key={series.endpoint_id} as="li">
                        <EndpointRow
                          name={endpoint?.description}
                          url={url}
                          series={series}
                          rate={rate}
                        />
                      </StaggerItem>
                    );
                  })}
                </Stagger>
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}

function EndpointRow({
  name,
  url,
  series,
  rate,
}: {
  name?: string;
  url: string;
  series: { succeeded: number[]; failed: number[]; total: number; failures: number };
  rate: number | null;
}) {
  const spotlight = useSpotlight();
  return (
    <motion.div
      {...spotlight}
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className="spotlight flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-panel px-5 py-4"
    >
      {/* On a phone the name takes the whole first line; the numbers follow. */}
      <div className="min-w-0 flex-1 max-sm:basis-full">
        {name && <p className="truncate text-[15px] font-medium text-fg">{name}</p>}
        <p className={cx("truncate font-mono text-xs", name ? "mt-0.5 text-fg-3" : "text-fg")} title={url}>
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
          "tabular font-display w-16 text-right text-lg font-semibold",
          { ok: "text-ok", warn: "text-warn", bad: "text-bad", none: "text-fg-2" }[successTone(rate) ?? "none"],
        )}
      >
        {percent(rate)}
      </span>
    </motion.div>
  );
}
