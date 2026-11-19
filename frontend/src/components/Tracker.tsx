/**
 * A delivery's journey drawn like a parcel tracker: a line from "created" to
 * "delivered" (or to the next attempt, or the dead-letter queue), with a stop
 * for every attempt.
 *
 * Stops sit at their real time after creation, on a square-root scale: retries
 * back off from seconds to hours, and on a linear scale the early attempts would
 * pile up at the start. The waits between stops are written on the line, so the
 * backoff schedule reads directly.
 */
import { useEffect, useRef, useState } from "react";
import { fullDate } from "../lib/format";
import type { DeliveryDetail } from "../lib/types";
import { gap } from "../lib/time";
import { cx } from "./ui";

interface Stop {
  key: string;
  at: number; // ms since creation
  kind: "created" | "ok" | "failed" | "next" | "delivered" | "dead";
  label: string;
  title: string;
}

// Room needed, in pixels, for a stop label and for a wait written on the line.
const LABEL_PX = 56;
const GAP_PX = 64;

/** Which stops get a label: each one far enough from the last labelled stop,
 *  and always the final stop (its neighbour gives way if they would touch). */
export function labelled(positions: number[], minLabel = 6): boolean[] {
  const shown = positions.map(() => false);
  let lastShown = -Infinity;
  let lastIndex = -1;
  positions.forEach((position, index) => {
    const final = index === positions.length - 1;
    if (position - lastShown >= minLabel) {
      shown[index] = true;
      lastShown = position;
      lastIndex = index;
    } else if (final) {
      if (lastIndex > 0) shown[lastIndex] = false;
      shown[index] = true;
    }
  });
  return shown;
}

export function stopsOf(delivery: DeliveryDetail, now = Date.now()): Stop[] {
  const created = new Date(delivery.created_at).getTime();
  const stops: Stop[] = [
    { key: "created", at: 0, kind: "created", label: "Created", title: fullDate(delivery.created_at) },
  ];
  for (const attempt of delivery.attempt_log) {
    const ok = attempt.error_kind === null;
    stops.push({
      key: attempt.id,
      at: Math.max(new Date(attempt.started_at).getTime() - created, 0),
      kind: ok ? "ok" : "failed",
      label: `#${attempt.attempt_number}`,
      title: `Attempt ${attempt.attempt_number}: ${
        attempt.status_code !== null ? `HTTP ${attempt.status_code}` : (attempt.error_kind ?? "failed")
      }, ${fullDate(attempt.started_at)}`,
    });
  }
  const last = stops.at(-1)?.at ?? 0;
  if (delivery.status === "pending" || delivery.status === "retrying") {
    const next = new Date(delivery.next_attempt_at).getTime() - created;
    stops.push({
      key: "next",
      at: Math.max(next, last, now - created),
      kind: "next",
      label: "Next",
      title: `Next attempt ${fullDate(delivery.next_attempt_at)}`,
    });
  } else if (delivery.status === "dead") {
    stops.push({ key: "end", at: last, kind: "dead", label: "Dead letter", title: "Out of attempts" });
  }
  return stops;
}

const DOT: Record<Stop["kind"], string> = {
  created: "border-fg-3 bg-panel",
  ok: "border-ok bg-ok",
  failed: "border-bad bg-panel",
  next: "border-warn border-dashed bg-panel",
  delivered: "border-ok bg-ok",
  dead: "border-bad bg-bad",
};

/** The track's width in pixels, followed as the window changes size. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width || 800));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function Tracker({ delivery }: { delivery: DeliveryDetail }) {
  const [track, width] = useWidth();
  const minLabel = (LABEL_PX / width) * 100;
  const minGap = (GAP_PX / width) * 100;
  const stops = stopsOf(delivery);
  const span = Math.max(...stops.map((stop) => stop.at), 1);
  // Square-root scale; the final stop sits at the right end.
  const position = (at: number) => (Math.sqrt(at) / Math.sqrt(span)) * 100;
  const finished = delivery.status === "succeeded" || delivery.status === "dead";
  const lastPosition = position(stops.at(-1)?.at ?? 0);
  const showLabel = labelled(stops.map((stop) => position(stop.at)), minLabel);

  return (
    <figure className="mb-10">
      <figcaption className="sr-only">
        {delivery.attempt_log.length} attempt{delivery.attempt_log.length === 1 ? "" : "s"} so far.
      </figcaption>
      <div ref={track} aria-hidden="true" className="relative mx-3 h-16">
        {/* The route: solid where the delivery has been, dashed where it is still going. */}
        <div className="absolute inset-x-0 top-[22px] h-0.5 bg-line" />
        <div
          className={cx("absolute left-0 top-[22px] h-0.5 animate-reveal", finished ? (delivery.status === "dead" ? "bg-bad/60" : "bg-ok/70") : "bg-fg-3/50")}
          style={{ width: `${lastPosition}%` }}
        />
        {stops.map((stop, index) => {
          const left = position(stop.at);
          const previous = stops[index - 1];
          const between = previous ? left - position(previous.at) : 0;
          return (
            <div key={stop.key}>
              {/* The wait since the previous stop, written on the line. */}
              {previous && between >= minGap && stop.kind !== "dead" && (
                <span
                  className="tabular absolute top-0 -translate-x-1/2 animate-fade whitespace-nowrap font-mono text-2xs text-fg-3 [animation-fill-mode:both]"
                  style={{ left: `${position(previous.at) + between / 2}%`, animationDelay: `${300 + index * 110}ms` }}
                >
                  +{gap(Math.round((stop.at - previous.at) / 1000))}
                </span>
              )}
              <span
                title={stop.title}
                className={cx(
                  "absolute top-4 h-3.5 w-3.5 -translate-x-1/2 animate-pop rounded-full border-2",
                  DOT[stop.kind],
                  stop.kind === "next" && "animate-pulse",
                )}
                style={{ left: `${left}%`, animationDelay: `${index * 110}ms` }}
              />
              {showLabel[index] && (
              <span
                className={cx(
                  "absolute top-9 -translate-x-1/2 animate-fade whitespace-nowrap text-2xs [animation-fill-mode:both]",
                  stop.kind === "failed" || stop.kind === "dead" ? "text-bad" : stop.kind === "ok" ? "text-ok" : "text-fg-3",
                  // The first and last labels hug the ends instead of overflowing.
                  index === 0 && "translate-x-[-6px]",
                  index === stops.length - 1 && index > 0 && "-translate-x-[calc(100%-6px)]",
                )}
                style={{ left: `${left}%`, animationDelay: `${index * 110 + 80}ms` }}
              >
                {stop.label}
              </span>
              )}
            </div>
          );
        })}
      </div>
    </figure>
  );
}
