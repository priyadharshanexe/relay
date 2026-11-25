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
        "pointer-events-none absolute bottom-full z-10 mb-2 w-max min-w-36 animate-fade rounded-md border border-line-strong bg-panel px-3 py-2 text-xs shadow-pop",
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
  const max = axisTop(buckets.map((b) => b.succeeded + b.failed));
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
                    <div aria-hidden="true" className="absolute inset-x-[-1.5px] inset-y-0 rounded-sm bg-hover/70" />
                  )}
                  <div
                    className={cx(
                      // Each bar grows up from the baseline, left to right.
                      "relative flex origin-bottom animate-grow flex-col justify-end overflow-hidden rounded-[2px] transition-opacity",
                      hovered !== null && !active && "opacity-45",
                    )}
                    style={{
                      height: `${(sum / max) * 100}%`,
                      minHeight: sum ? 2 : 0,
                      animationDelay: `${index * 18}ms`,
                    }}
                  >
                    {bucket.failed > 0 && (
                      <div className="bg-bad" style={{ height: `${(bucket.failed / sum) * 100}%`, minHeight: 2 }} />
                    )}
                    {bucket.succeeded > 0 && (
                      <div className="flex-1 bg-ok" />
                    )}
                  </div>
                  {active && (
                    <Tooltip align={index > buckets.length / 2 ? "right" : "left"}>
                      <p className="mb-1.5 font-medium text-fg">{hourLabel(bucket.start)}</p>
                      <p className="flex justify-between gap-4 text-fg-2">
                        <span className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-sm bg-ok" /> Delivered
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

function HourAxis({ buckets, offset = "pl-9" }: { buckets: StatsBucket[]; offset?: string }) {
  return (
    <div aria-hidden="true" className={cx("mt-2 flex text-2xs text-fg-3", offset)}>
      {buckets.map((bucket, index) => (
        <span key={bucket.start} className="tabular flex-1 text-center">
          {index % 6 === 0 || index === buckets.length - 1 ? hourLabel(bucket.start) : ""}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- latency chart
/** The top of a value axis: the largest value plus 15% headroom, rounded, so
 *  the tallest mark never touches the top of the plot. */
export function axisTop(values: number[]): number {
  return niceMax(Math.max(...values, 0) * 1.15);
}

/**
 * p95 latency per hour, one bar per hour that had attempts. An hour without
 * attempts has no latency to show, so it is drawn as an empty slot marked on
 * the baseline rather than joined across with a line that would invent values.
 */
export function LatencyChart({ buckets }: { buckets: StatsBucket[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const known = buckets.map((b) => b.p95_ms).filter((v): v is number => v !== null);
  const max = axisTop(known);

  return (
    <figure>
      <figcaption className="sr-only">
        {known.length
          ? `95th-percentile latency over the last 24 hours, highest ${milliseconds(Math.max(...known))}; ${
              buckets.length - known.length
            } hours had no attempts.`
          : "No attempts in the last 24 hours."}
      </figcaption>
      <div className="flex gap-3">
        <div aria-hidden="true" className="tabular flex h-40 w-12 flex-col justify-between py-px text-right text-2xs text-fg-3">
          <span>{milliseconds(max)}</span>
          <span>{milliseconds(max / 2)}</span>
          <span>0</span>
        </div>
        <div className="relative h-40 flex-1">
          <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">
            <div className="border-t border-dashed border-line" />
            <div className="border-t border-dashed border-line" />
            <div className="border-t border-line-strong" />
          </div>
          <div className="relative flex h-full items-end gap-[3px]" onMouseLeave={() => setHovered(null)}>
            {buckets.map((bucket, index) => {
              const value = bucket.p95_ms;
              const active = hovered === index;
              return (
                <div
                  key={bucket.start}
                  className="relative flex h-full flex-1 flex-col justify-end"
                  onMouseEnter={() => setHovered(index)}
                >
                  {active && (
                    <div aria-hidden="true" className="absolute inset-x-[-1.5px] inset-y-0 rounded-sm bg-hover/70" />
                  )}
                  {value === null ? (
                    // No attempts this hour: a small mark on the baseline, not a bar.
                    <div aria-hidden="true" className="relative mx-auto mb-[-1px] h-[3px] w-1 rounded-full bg-line-strong" />
                  ) : (
                    <div
                      className={cx(
                        "relative origin-bottom animate-grow rounded-t-[2px] bg-fg-2/70 transition-opacity",
                        hovered !== null && !active && "opacity-45",
                      )}
                      style={{
                        height: `${(value / max) * 100}%`,
                        minHeight: 2,
                        animationDelay: `${index * 18}ms`,
                      }}
                    />
                  )}
                  {active && (
                    <Tooltip align={index > buckets.length / 2 ? "right" : "left"}>
                      <p className="font-medium text-fg">{hourLabel(bucket.start)}</p>
                      <p className="mt-1 text-fg-2">
                        {value === null ? (
                          "No attempts this hour"
                        ) : (
                          <>
                            p95 <span className="tabular text-fg">{milliseconds(value)}</span>
                          </>
                        )}
                      </p>
                    </Tooltip>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <HourAxis buckets={buckets} offset="pl-[3.75rem]" />
      <p className="mt-2 flex items-center gap-1.5 text-2xs text-fg-3">
        <span aria-hidden="true" className="inline-block h-[3px] w-1 rounded-full bg-line-strong" />
        no attempts that hour
      </p>
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
    <div role="img" aria-label={label} className="flex h-7 w-36 items-end gap-px max-sm:w-24">
      {totals.map((total, index) => (
        <div
          key={index}
          className={cx(
            "flex-1 rounded-[1px]",
            total === 0 ? "bg-line" : (failed[index] ?? 0) > 0 ? "bg-bad" : "bg-ok/80",
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
  { status: "pending", label: "Pending", color: "bg-pending" },
  { status: "in_flight", label: "Sending", color: "bg-flight" },
  { status: "retrying", label: "Retrying", color: "bg-warn" },
  { status: "dead", label: "Dead", color: "bg-bad" },
];

/** Where every delivery stands right now, as one segmented bar and a legend. */
export function StateBreakdown({ counts }: { counts: Record<DeliveryStatus, number> }) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return (
    <div>
      <div aria-hidden="true" className="flex h-2.5 animate-reveal gap-0.5 overflow-hidden rounded-[3px] bg-line">
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
