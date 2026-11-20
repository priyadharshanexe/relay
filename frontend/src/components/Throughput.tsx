/**
 * Attempts per second over the last minute, as a strip of bars that scrolls
 * left as time passes: new seconds enter on the right. Failures sit on top in
 * red. The total per minute is printed beside it.
 */
import { useEffect, useState } from "react";
import type { LiveUpdate } from "../lib/types";
import { Odometer } from "./motionkit";
import { cx } from "./ui";

const SECONDS = 60;

export function bucketsOf(updates: LiveUpdate[], now: number): { ok: number; failed: number }[] {
  const buckets = Array.from({ length: SECONDS }, () => ({ ok: 0, failed: 0 }));
  for (const update of updates) {
    const age = Math.floor((now - new Date(update.at).getTime()) / 1000);
    if (age < 0 || age >= SECONDS) continue;
    const bucket = buckets[SECONDS - 1 - age];
    if (!bucket) continue;
    if (update.error_kind === null) bucket.ok += 1;
    else bucket.failed += 1;
  }
  return buckets;
}

export function Throughput({ updates }: { updates: LiveUpdate[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const buckets = bucketsOf(updates, now);
  const max = Math.max(...buckets.map((b) => b.ok + b.failed), 1);
  const total = buckets.reduce((sum, b) => sum + b.ok + b.failed, 0);

  return (
    <figure className="mb-6 flex items-end gap-5 rounded-xl border border-line bg-panel px-5 py-4">
      <div className="shrink-0">
        <figcaption className="text-xs text-fg-3">Attempts, last minute</figcaption>
        <p className="font-display mt-1 text-[32px] font-semibold leading-none tracking-[-0.03em] text-fg">
          <Odometer value={String(total)} />
        </p>
      </div>
      <div aria-hidden="true" className="flex h-12 flex-1 items-end gap-[2px] overflow-hidden">
        {buckets.map((bucket, index) => {
          const sum = bucket.ok + bucket.failed;
          return (
            <div
              // Keyed by absolute second, so bars slide left instead of re-drawing.
              key={Math.floor(now / 1000) - (SECONDS - 1 - index)}
              className={cx("flex flex-1 flex-col justify-end", sum === 0 && "opacity-60")}
              style={{ height: "100%" }}
            >
              {sum === 0 ? (
                <div className="h-[2px] rounded-full bg-line" />
              ) : (
                <div
                  className="flex origin-bottom animate-grow flex-col overflow-hidden rounded-[2px]"
                  style={{ height: `${Math.max((sum / max) * 100, 10)}%` }}
                >
                  {bucket.failed > 0 && <div className="bg-bad" style={{ flex: bucket.failed }} />}
                  {bucket.ok > 0 && <div className="bg-ok" style={{ flex: bucket.ok }} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </figure>
  );
}
