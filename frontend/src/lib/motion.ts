/**
 * Motion helpers. Every animation in Relay is short (150–420 ms) and is skipped
 * entirely for people who ask their system for reduced motion; then values
 * simply appear in their final state.
 */
import { useEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  // No matchMedia (some test environments): treat as "reduce", show final values.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * A number that counts to its value: from 0 on first show, and from the old
 * value when it changes later (say 41 -> 43 on a refresh).
 */
export function useCountUp(target: number, durationMs = 600): number {
  const [value, setValue] = useState(() => (prefersReducedMotion() ? target : 0));
  const from = useRef(value);

  useEffect(() => {
    if (prefersReducedMotion()) {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1);
      const next = origin + (target - origin) * easeOut(t);
      setValue(next);
      from.current = next;
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return value;
}
