/**
 * A delivery's journey drawn like a parcel tracker: a line from "created" to
 * the end (delivered, the dead-letter queue, or the next scheduled attempt),
 * with a stop for every attempt.
 *
 * Stops sit at their real time after creation, on a square-root scale: retries
 * back off from seconds to hours, and on a linear scale the early attempts would
 * pile up at the start. Stops closer together than a fingertip are merged into
 * one ("#1–#4"); the full list is right below the tracker.
 *
 * While a delivery is still on its way, a "now" tick sits on the line and the
 * last stretch says when the next attempt is due, counted from now, from the
 * same next_attempt_at the page shows in words. If the endpoint is holding
 * deliveries back, the stretch says "on hold".
 */
import { useEffect, useRef, useState } from "react";
import { fullDate } from "../lib/format";
import { gap } from "../lib/time";
import type { DeliveryDetail } from "../lib/types";
import { cx } from "./ui";

export interface Stop {
  key: string;
  at: number; // ms since creation
  kind: "created" | "ok" | "failed" | "next" | "dead";
  label: string;
  title: string;
}

/** Stops closer than this many pixels are drawn as one, so every stop that is
 *  drawn has room for its label (a merged one reads "#1–#4"). */
export const MERGE_PX = 44;
const LABEL_PX = 44; // room a stop label needs
const NOTE_PX = 96; // room a note on the line needs

/** Endpoint states in which deliveries wait without being attempted. */
export function onHold(delivery: DeliveryDetail): boolean {
  return (
    (delivery.status === "pending" || delivery.status === "retrying") &&
    (delivery.endpoint_status !== "active" || delivery.endpoint_breaker_state !== "closed")
  );
}

export function stopsOf(delivery: DeliveryDetail, now = Date.now()): Stop[] {
  const created = new Date(delivery.created_at).getTime();
  const stops: Stop[] = [
    { key: "created", at: 0, kind: "created", label: "Created", title: `Created ${fullDate(delivery.created_at)}` },
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
      // Never before now: an attempt that is due is about to happen.
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

export interface Group {
  stops: Stop[];
  position: number; // percent along the line
  kind: Stop["kind"];
  label: string;
  title: string;
}

/**
 * Stops within `mergePercent` of a group's first stop join that group. The end
 * stop (next attempt, dead letter) always stays on its own, so where the
 * delivery stands is never hidden in a group.
 */
export function groupStops(stops: Stop[], positions: number[], mergePercent: number): Group[] {
  const groups: Group[] = [];
  stops.forEach((stop, index) => {
    const position = positions[index] ?? 0;
    const current = groups.at(-1);
    const isEnd = stop.kind === "next" || stop.kind === "dead";
    if (current && !isEnd && current.kind !== "next" && position - current.position < mergePercent) {
      current.stops.push(stop);
      return;
    }
    groups.push({ stops: [stop], position, kind: stop.kind, label: stop.label, title: stop.title });
  });
  groups.forEach(relabel);
  return groups;
}

/** A merged group's dot colour, label ("#1–#4") and hover text. */
function relabel(group: Group): void {
  if (group.stops.length === 1) return;
  const attempts = group.stops.filter((stop) => stop.kind === "ok" || stop.kind === "failed");
  group.kind = attempts.some((stop) => stop.kind === "failed") ? "failed" : attempts.length ? "ok" : group.kind;
  group.label =
    attempts.length > 1
      ? `${attempts[0]?.label}–${attempts.at(-1)?.label}`
      : (attempts[0]?.label ?? group.label);
  group.title = group.stops.map((stop) => stop.title).join("\n");
}

// Estimated width of a stop label at text-2xs: wide enough to be safe.
const CHAR_PX = 6.5;
const LABEL_GAP_PX = 6;

/** Where a group's label sits, in pixels: the first hugs the left end, the
 *  last the right end, the others are centred under their stop. */
export function labelBox(group: Group, index: number, count: number, widthPx: number): [number, number] {
  const x = (group.position / 100) * widthPx;
  const w = group.label.length * CHAR_PX + 4;
  if (index === 0) return [x - 6, x - 6 + w];
  if (index === count - 1) return [x - w + 6, x + 6];
  return [x - w / 2, x + w / 2];
}

/**
 * Merge neighbouring groups whose labels would run into each other, until none
 * do. Stops that are far enough apart as dots can still have labels too wide
 * for the space between them ("#1–#2" next to "#3–#4"). The end stop (next
 * attempt, dead letter) is never merged; the label pass gives way for it.
 */
export function mergeCollidingLabels(groups: Group[], widthPx: number): Group[] {
  const result = groups.map((group) => ({ ...group, stops: [...group.stops] }));
  for (let index = 1; index < result.length; ) {
    const previous = result[index - 1];
    const current = result[index];
    if (!previous || !current) break;
    const isEnd = current.kind === "next" || current.kind === "dead";
    const [, previousEnd] = labelBox(previous, index - 1, result.length, widthPx);
    const [currentStart] = labelBox(current, index, result.length, widthPx);
    if (!isEnd && previousEnd + LABEL_GAP_PX > currentStart) {
      previous.stops.push(...current.stops);
      relabel(previous);
      result.splice(index, 1);
      index = Math.max(index - 1, 1); // the grown label may now touch its other neighbour
    } else {
      index += 1;
    }
  }
  return result;
}

/** Which groups get a label: each far enough from the last labelled one, and
 *  always the final group (its neighbour gives way if they would touch). */
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

/** The note on the last stretch: when the next attempt is due, from now. */
export function nextNote(delivery: DeliveryDetail, now = Date.now()): string | null {
  if (delivery.status !== "pending" && delivery.status !== "retrying") return null;
  const seconds = Math.round((new Date(delivery.next_attempt_at).getTime() - now) / 1000);
  const when = seconds > 0 ? `next in ${gap(seconds)}` : "next attempt due now";
  return onHold(delivery) ? `on hold · ${when}` : when;
}

const DOT: Record<Stop["kind"], string> = {
  created: "border-fg-3 bg-panel",
  ok: "border-ok bg-ok",
  failed: "border-bad bg-panel",
  next: "border-warn border-dashed bg-panel",
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
  const now = Date.now();
  const stops = stopsOf(delivery, now);
  const span = Math.max(...stops.map((stop) => stop.at), 1);
  // Square-root scale; the final stop sits at the right end.
  const position = (at: number) => (Math.sqrt(Math.max(at, 0)) / Math.sqrt(span)) * 100;
  const groups = mergeCollidingLabels(
    groupStops(stops, stops.map((stop) => position(stop.at)), (MERGE_PX / width) * 100),
    width,
  );
  const showLabel = labelled(groups.map((group) => group.position), (LABEL_PX / width) * 100);
  const minNote = (NOTE_PX / width) * 100;

  const finished = delivery.status === "succeeded" || delivery.status === "dead";
  const nowPosition = finished ? null : position(now - new Date(delivery.created_at).getTime());
  const travelled = nowPosition ?? groups.at(-1)?.position ?? 0;
  const note = nextNote(delivery, now);

  return (
    <figure className="mb-10">
      <figcaption className="sr-only">
        {delivery.attempt_log.length} attempt{delivery.attempt_log.length === 1 ? "" : "s"} so far
        {note ? `; ${note}` : ""}.
      </figcaption>
      <div ref={track} aria-hidden="true" className="relative mx-3 h-16">
        {/* The route: solid up to now, dashed for what is still to come. */}
        <div className="absolute inset-x-0 top-[22px] border-t-2 border-dashed border-line-strong" />
        <div
          className={cx(
            "absolute left-0 top-[22px] h-0.5 animate-reveal",
            finished ? (delivery.status === "dead" ? "bg-bad/60" : "bg-ok/70") : "bg-fg-3/60",
          )}
          style={{ width: `${travelled}%` }}
        />

        {/* Waits between stops, written on the line. */}
        {groups.map((group, index) => {
          const previous = groups[index - 1];
          if (!previous || group.kind === "next" || group.kind === "dead") return null;
          const between = group.position - previous.position;
          if (between < minNote) return null;
          const wait = (group.stops[0]?.at ?? 0) - (previous.stops.at(-1)?.at ?? 0);
          return (
            <span
              key={`wait-${group.stops[0]?.key}`}
              className="tabular absolute top-0 -translate-x-1/2 animate-fade whitespace-nowrap font-mono text-2xs text-fg-3 [animation-fill-mode:both]"
              style={{ left: `${previous.position + between / 2}%`, animationDelay: `${300 + index * 110}ms` }}
            >
              +{gap(Math.max(Math.round(wait / 1000), 0))}
            </span>
          );
        })}

        {/* Now, and the note on the last stretch. */}
        {nowPosition !== null && (
          <span
            className="absolute top-[14px] h-[18px] w-0.5 -translate-x-1/2 animate-fade rounded-full bg-fg [animation-fill-mode:both]"
            style={{ left: `${nowPosition}%`, animationDelay: `${groups.length * 110}ms` }}
          />
        )}
        {note && nowPosition !== null && (
          <span
            className={cx(
              "absolute top-0 animate-fade whitespace-nowrap font-mono text-2xs [animation-fill-mode:both]",
              onHold(delivery) ? "text-warn" : "text-fg-3",
              // Centred on the stretch when it is wide enough; otherwise right-aligned.
              100 - nowPosition >= minNote ? "-translate-x-1/2" : "right-0",
            )}
            style={{
              left: 100 - nowPosition >= minNote ? `${(nowPosition + 100) / 2}%` : undefined,
              animationDelay: `${groups.length * 110 + 120}ms`,
            }}
          >
            {note}
          </span>
        )}

        {groups.map((group, index) => (
          <div key={group.stops[0]?.key}>
            <span
              title={group.title}
              className={cx(
                "absolute top-4 h-3.5 w-3.5 -translate-x-1/2 animate-pop rounded-full border-2",
                DOT[group.kind],
                group.stops.length > 1 && "ring-2 ring-panel ring-offset-0 outline outline-1 outline-offset-2 outline-current",
                group.kind === "next" && "animate-pulse",
                group.kind === "failed" ? "text-bad/40" : group.kind === "ok" ? "text-ok/40" : "",
              )}
              style={{ left: `${group.position}%`, animationDelay: `${index * 110}ms` }}
            />
            {showLabel[index] && (
              <span
                className={cx(
                  "absolute top-9 -translate-x-1/2 animate-fade whitespace-nowrap text-2xs [animation-fill-mode:both]",
                  group.kind === "failed" || group.kind === "dead"
                    ? "text-bad"
                    : group.kind === "ok"
                      ? "text-ok"
                      : "text-fg-3",
                  // The first and last labels hug the ends instead of overflowing.
                  index === 0 && "translate-x-[-6px]",
                  index === groups.length - 1 && index > 0 && "-translate-x-[calc(100%-6px)]",
                )}
                style={{ left: `${group.position}%`, animationDelay: `${index * 110 + 80}ms` }}
              >
                {group.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </figure>
  );
}
