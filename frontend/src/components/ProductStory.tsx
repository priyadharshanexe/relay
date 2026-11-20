/**
 * What Relay is, told beside the sign-in form: a headline, one plain sentence,
 * four proof points that are real features, each with a small glyph drawn in
 * the same packet-and-route language as the rest of the app, and a ticker of
 * sample deliveries (clearly marked as samples).
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../lib/motion";

const animated = () => !prefersReducedMotion();

/** A signed packet: the seal stamps onto it. */
function SignedGlyph() {
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10" aria-hidden="true">
      <rect x="6" y="10" width="22" height="20" rx="3" fill="none" stroke="var(--color-fg-3)" strokeWidth="1.6" />
      <path d="M10 16h14M10 21h10" stroke="var(--color-fg-3)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="28" cy="27" r="7" fill="var(--color-ok)">
        {animated() && <animate attributeName="r" values="7;8.5;7" dur="2.4s" repeatCount="indefinite" />}
      </circle>
      <path d="m24.8 27 2.2 2.2 4-4.2" fill="none" stroke="var(--color-panel)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A retry: the packet runs out, bounces back, waits, runs again and lands. */
function RetryGlyph() {
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10" aria-hidden="true">
      <path id="g-retry" d="M5 20h30" stroke="var(--color-fg-3)" strokeWidth="1.6" strokeDasharray="2 3" />
      <rect x="31" y="14" width="5" height="12" rx="1.5" fill="var(--color-fg-3)" />
      <circle r="3.5" cy="20" cx="5" fill="var(--color-warn)">
        {animated() && (
          <>
            <animate attributeName="cx" values="5;28;12;12;28;28" keyTimes="0;0.25;0.45;0.6;0.85;1" dur="3s" repeatCount="indefinite" />
            <animate attributeName="fill" values="var(--color-flight);var(--color-warn);var(--color-warn);var(--color-flight);var(--color-ok);var(--color-ok)" keyTimes="0;0.25;0.45;0.6;0.85;1" dur="3s" repeatCount="indefinite" />
          </>
        )}
      </circle>
    </svg>
  );
}

/** A circuit breaker: the line opens while the endpoint is failing, then closes. */
function BreakerGlyph() {
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10" aria-hidden="true">
      <path d="M4 24h11M25 24h11" stroke="var(--color-fg-3)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="15" cy="24" r="2" fill="var(--color-fg-3)" />
      <circle cx="25" cy="24" r="2" fill="var(--color-fg-3)" />
      <line x1="15" y1="24" x2="25" y2="24" stroke="var(--color-bad)" strokeWidth="2" strokeLinecap="round">
        {animated() && (
          <>
            <animate attributeName="y2" values="24;14;14;24;24" keyTimes="0;0.2;0.6;0.8;1" dur="3.2s" repeatCount="indefinite" />
            <animate attributeName="stroke" values="var(--color-ok);var(--color-bad);var(--color-bad);var(--color-ok);var(--color-ok)" keyTimes="0;0.2;0.6;0.8;1" dur="3.2s" repeatCount="indefinite" />
          </>
        )}
      </line>
    </svg>
  );
}

/** Replay: a dead packet comes out of the tray and goes round again. */
function ReplayGlyph() {
  return (
    <svg viewBox="0 0 40 40" className="h-10 w-10" aria-hidden="true">
      <path id="g-loop" d="M20 8a12 12 0 1 1-11.3 8" fill="none" stroke="var(--color-fg-3)" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5.5 11.5 8.7 16l4.6-2.6" fill="none" stroke="var(--color-fg-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle r="3.2" fill="var(--color-accent)">
        {animated() ? (
          <animateMotion dur="2.6s" repeatCount="indefinite">
            <mpath href="#g-loop" />
          </animateMotion>
        ) : null}
      </circle>
      {!animated() && <circle cx="20" cy="8" r="3.2" fill="var(--color-accent)" />}
    </svg>
  );
}

const POINTS = [
  { glyph: SignedGlyph, title: "Signed", text: "Standard Webhooks HMAC-SHA256, so receivers can prove it came from you." },
  { glyph: RetryGlyph, title: "Retried", text: "Up to 7 attempts with exponential backoff, from seconds to a day." },
  { glyph: BreakerGlyph, title: "Protected", text: "A circuit breaker per endpoint stops hammering a server that is down." },
  { glyph: ReplayGlyph, title: "Replayable", text: "Failed deliveries wait in a dead-letter queue until you replay them." },
];

const SAMPLES: [string, string, number, number][] = [
  ["order.paid", "api.acme.dev", 200, 41],
  ["invoice.finalized", "billing.globex.io", 200, 87],
  ["user.created", "crm.initech.com", 503, 1204],
  ["order.refunded", "api.acme.dev", 200, 39],
  ["subscription.renewed", "hooks.umbrella.co", 429, 12],
  ["user.created", "crm.initech.com", 200, 64],
];

function statusTone(code: number): string {
  if (code < 300) return "text-ok";
  return code < 500 ? "text-warn" : "text-bad";
}

/** Sample deliveries rolling past, newest on top. Marked as samples. */
function SampleTicker() {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!animated()) return;
    const timer = setInterval(() => setOffset((n) => n + 1), 1800);
    return () => clearInterval(timer);
  }, []);
  const rows = [0, 1, 2].map((i) => {
    const index = (offset + i) % SAMPLES.length;
    return { key: offset + i, sample: SAMPLES[index] ?? SAMPLES[0]! };
  });
  return (
    <div className="mt-8 max-w-md overflow-hidden rounded-lg border border-line bg-panel/80">
      <p className="flex items-center justify-between border-b border-line px-3.5 py-2 text-2xs text-fg-3">
        <span>Sample deliveries</span>
        <span className="font-mono">example data</span>
      </p>
      <ul className="relative h-[96px] font-mono text-xs">
        <AnimatePresence initial={false}>
          {rows.map(({ key, sample: [type, host, code, ms] }, position) => (
            <motion.li
              key={key}
              layout
              initial={{ opacity: 0, y: -16 }}
              animate={{ opacity: 1 - position * 0.25, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="flex h-8 items-center gap-3 px-3.5"
            >
              <span className="w-[9.5rem] min-w-0 shrink truncate text-fg">{type}</span>
              <span className="min-w-0 flex-1 truncate text-fg-3">→ {host}</span>
              <span className={statusTone(code)}>{code}</span>
              <span className="w-14 text-right text-fg-3">{ms} ms</span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

export function ProductStory() {
  return (
    <section aria-labelledby="story-heading" className="max-w-xl">
      <h2 id="story-heading" className="font-display text-[40px] font-bold leading-[1.02] tracking-[-0.04em] text-fg min-[1100px]:text-[48px]">
        Webhooks that arrive.
        <span className="block text-accent">Signed, retried, never lost.</span>
      </h2>
      <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-fg-2">
        Relay takes events from your app and delivers them to your customers&apos; endpoints, with
        retries, a dead-letter queue and replay.
      </p>
      <ul className="mt-7 grid gap-x-6 gap-y-5 sm:grid-cols-2">
        {POINTS.map(({ glyph: Glyph, title, text }) => (
          <li key={title} className="flex gap-3">
            <span className="shrink-0 self-start rounded-lg border border-line bg-panel/80 p-1">
              <Glyph />
            </span>
            <span>
              <span className="block text-[14px] font-semibold text-fg">{title}</span>
              <span className="mt-0.5 block text-[13px] leading-snug text-fg-2">{text}</span>
            </span>
          </li>
        ))}
      </ul>
      <SampleTicker />
    </section>
  );
}
