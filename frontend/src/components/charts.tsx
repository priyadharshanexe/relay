/**
 * Small, dependency-free charts for the overview.
 *
 * Bars are HTML elements sized in percent, so they stay crisp at any width and
 * need no measuring. Each chart also has a plain-text summary for screen readers,
 * and every bar a tooltip with exact numbers: a chart should never be the only
 * place a number lives.
 */
import { useState } from "react";
import { milliseconds } from "../lib/format";
import type { DeliveryStatus, StatsBucket } from "../lib/types";
import { cx } from "./ui";

function hourLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

/** A round axis maximum: 7 -> 8, 23 -> 25, 140 -> 150. */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

function Tooltip({ children, align }: { children: React.ReactNode; align: "left" | "right" }) {
  return (
    <div
      role="tooltip"
      className={cx(
        "pointer-events-none absolute bottom-full z-10 mb-2 w-max min-w-36 animate-rise rounded-lg border border-line-strong bg-raised px-3 py-2 text-xs shadow-pop",
        align === "left" ? "left-0" : "right-0",
      )}
    >
      {children}
    </div>
  );
}

// ------------------------------------------------------------ attempts chart
/** Successful and failed attempts per hour, stacked. */
export function AttemptsChart({ buckets }: { buckets: StatsBucket[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = niceMax(Math.max(...buckets.map((b) => b.succeeded + b.failed), 0));
  const total = buckets.reduce((sum, b) => sum + b.succeeded + b.failed, 0);
  const failed = buckets.reduce((sum, b) => sum + b.failed, 0);

  return (
    <figure>
      <figcaption className="sr-only">
        {total} delivery attempts in the last 24 hours, {failed} of them failed.
      </figcaption>
      <div className="flex gap-3">
        {/* Y axis */}
        <div aria-hidden="true" className="tabular flex h-48 flex-col justify-between py-px text-right text-2xs text-fg-3">
          <span>{max}</span>
          <span>{max / 2}</span>
          <span>0</span>
        </div>
        <div className="relative h-48 flex-1">
          {/* Gridlines */}
          <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">
            <div className="border-t border-dashed border-line" />
            <div className="border-t border-dashed border-line" />
            <div className="border-t border-line-strong" />
          </div>
          <div className="relative flex h-full items-end gap-[3px]" onMouseLeave={() => setHovered(null)}>
            {buckets.map((bucket, index) => {
              const sum = bucket.succeeded + bucket.failed;
              const active = hovered === index;
              return (
                <div
                  key={bucket.start}
                  className="relative flex h-full flex-1 flex-col justify-end"
                  onMouseEnter={() => setHovered(index)}
                >
                  {active && (
                    <div aria-hidden="true" className="absolute inset-x-[-1.5px] inset-y-0 rounded-sm bg-white/[0.03]" />
                  )}
                  <div
                    className={cx(
                      "relative flex flex-col justify-end overflow-hidden rounded-[3px] transition-opacity",
                      hovered !== null && !active && "opacity-50",
                    )}
                    style={{ height: `${(sum / max) * 100}%`, minHeight: sum ? 2 : 0 }}
                  >
                    {bucket.failed > 0 && (
                      <div className="bg-bad" style={{ height: `${(bucket.failed / sum) * 100}%`, minHeight: 2 }} />
                    )}
                    {bucket.succeeded > 0 && (
                      <div className="flex-1 bg-gradient-to-t from-accent/70 to-accent" />
                    )}
                  </div>
                  {active && (
                    <Tooltip align={index > buckets.length / 2 ? "right" : "left"}>
                      <p className="mb-1.5 font-medium text-fg">{hourLabel(bucket.start)}</p>
                      <p className="flex justify-between gap-4 text-fg-2">
                        <span className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-sm bg-accent" /> Delivered
                        </span>
                        <span className="tabular text-fg">{bucket.succeeded}</span>
                      </p>
                      <p className="flex justify-between gap-4 text-fg-2">
                        <span className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-sm bg-bad" /> Failed
                        </span>
                        <span className="tabular text-fg">{bucket.failed}</span>
                      </p>
                      <p className="mt-1.5 flex justify-between gap-4 border-t border-line pt-1.5 text-fg-3">
                        p95 <span className="tabular text-fg-2">{milliseconds(bucket.p95_ms)}</span>
                      </p>
                    </Tooltip>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <HourAxis buckets={buckets} />
    </figure>
  );
}

function HourAxis({ buckets }: { buckets: StatsBucket[] }) {
  return (
    <div aria-hidden="true" className="mt-2 flex pl-9 text-2xs text-fg-3">
      {buckets.map((bucket, index) => (
        <span key={bucket.start} className="tabular flex-1 text-center">
          {index % 6 === 0 || index === buckets.length - 1 ? hourLabel(bucket.start) : ""}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- latency chart
/** p95 latency per hour, as a line over a soft area. Idle hours are gaps. */
export function LatencyChart({ buckets }: { buckets: StatsBucket[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const values = buckets.map((b) => b.p95_ms);
  const known = values.filter((v): v is number => v !== null);
  const max = niceMax(Math.max(...known, 0));
  const width = 100;
  const height = 40;
  const x = (index: number) => (index / Math.max(buckets.length - 1, 1)) * width;
  const y = (value: number) => height - (value / max) * height;

  // One path segment per run of hours that had attempts.
  const segments: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push({ x: x(index), y: y(value) });
    }
  });
  if (current.length) segments.push(current);

  const line = (points: { x: number; y: number }[]) =>
    points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");

  return (
    <figure>
      <figcaption className="sr-only">
        {known.length
          ? `95th-percentile latency over the last 24 hours, highest ${milliseconds(Math.max(...known))}.`
          : "No attempts in the last 24 hours."}
      </figcaption>
      <div className="flex gap-3">
        <div aria-hidden="true" className="tabular flex h-36 flex-col justify-between text-right text-2xs text-fg-3">
          <span>{milliseconds(max)}</span>
          <span>0</span>
        </div>
        <div className="relative h-36 flex-1" onMouseLeave={() => setHovered(null)}>
          <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">
            <div className="border-t border-dashed border-line" />
            <div className="border-t border-line-strong" />
          </div>
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
          >
            <defs>
              <linearGradient id="latency-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.28" />
                <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {segments.map((points) => (
              <g key={`${points[0]?.x}`}>
                {points.length > 1 && (
                  <path
                    d={`${line(points)} L${points.at(-1)?.x},${height} L${points[0]?.x},${height} Z`}
                    fill="url(#latency-fill)"
                  />
                )}
                <path
                  d={line(points)}
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth="1.75"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
          </svg>
          {/* Hover targets and points, in HTML so they don't stretch. */}
          <div className="absolute inset-0 flex">
            {buckets.map((bucket, index) => (
              <div
                key={bucket.start}
                className="relative h-full flex-1"
                onMouseEnter={() => setHovered(index)}
              >
                {/* Every measured hour gets a point, so an hour on its own
                    (no neighbour to draw a line to) is still visible. */}
                {bucket.p95_ms !== null && hovered !== index && (
                  <span
                    aria-hidden="true"
                    className="absolute left-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
                    style={{ top: `${(y(bucket.p95_ms) / height) * 100}%` }}
                  />
                )}
                {hovered === index && (
                  <>
                    <div aria-hidden="true" className="absolute inset-y-0 left-1/2 border-l border-line-strong" />
                    {bucket.p95_ms !== null && (
                      <span
                        aria-hidden="true"
                        className="absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-canvas"
                        style={{ top: `${(y(bucket.p95_ms) / height) * 100}%` }}
                      />
                    )}
                    <Tooltip align={index > buckets.length / 2 ? "right" : "left"}>
                      <p className="font-medium text-fg">{hourLabel(bucket.start)}</p>
                      <p className="mt-1 text-fg-2">
                        p95 <span className="tabular text-fg">{milliseconds(bucket.p95_ms)}</span>
                      </p>
                    </Tooltip>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <HourAxis buckets={buckets} />
    </figure>
  );
}

// -------------------------------------------------------------- sparkline
/** 24 tiny bars: attempts per hour for one endpoint. Failures show in red. */
export function Sparkline({
  succeeded,
  failed,
  label,
}: {
  succeeded: number[];
  failed: number[];
  label: string;
}) {
  const totals = succeeded.map((value, index) => value + (failed[index] ?? 0));
  const max = Math.max(...totals, 1);
  return (
    <div role="img" aria-label={label} className="flex h-7 w-36 items-end gap-px">
      {totals.map((total, index) => (
        <div
          key={index}
          className={cx(
            "flex-1 rounded-[1px]",
            total === 0 ? "bg-line" : (failed[index] ?? 0) > 0 ? "bg-bad" : "bg-accent/80",
          )}
          style={{ height: total === 0 ? 2 : `${Math.max((total / max) * 100, 12)}%` }}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------- state distribution
const STATE_ORDER: { status: DeliveryStatus; label: string; color: string }[] = [
  { status: "succeeded", label: "Succeeded", color: "bg-ok" },
  { status: "pending", label: "Pending", color: "bg-fg-3" },
  { status: "in_flight", label: "Sending", color: "bg-accent" },
  { status: "retrying", label: "Retrying", color: "bg-warn" },
  { status: "dead", label: "Dead", color: "bg-bad" },
];

/** Where every delivery stands right now, as one segmented bar and a legend. */
export function StateBreakdown({ counts }: { counts: Record<DeliveryStatus, number> }) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return (
    <div>
      <div aria-hidden="true" className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-line">
        {total > 0 &&
          STATE_ORDER.filter(({ status }) => counts[status] > 0).map(({ status, color }) => (
            <div key={status} className={color} style={{ width: `${(counts[status] / total) * 100}%` }} />
          ))}
      </div>
      <dl className="mt-5 space-y-2.5">
        {STATE_ORDER.map(({ status, label, color }) => (
          <div key={status} className="flex items-center justify-between text-[13px]">
            <dt className="flex items-center gap-2 text-fg-2">
              <span aria-hidden="true" className={cx("h-2 w-2 rounded-full", color)} />
              {label}
            </dt>
            <dd className="tabular text-fg">
              {counts[status].toLocaleString()}
              <span className="ml-2 inline-block w-10 text-right text-xs text-fg-3">
                {total ? `${Math.round((counts[status] / total) * 100)}%` : "—"}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
