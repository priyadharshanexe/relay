/**
 * After a bulk replay: one packet per replayed delivery (up to 16) leaves the
 * dead-letter queue, red turning to blue as it heads back out to be delivered.
 */
import { motion } from "motion/react";
import { prefersReducedMotion } from "../lib/motion";

export function ReplayBurst({ count }: { count: number }) {
  if (prefersReducedMotion()) return null;
  const packets = Math.min(count, 16);
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 right-0 overflow-visible">
      {Array.from({ length: packets }, (_, i) => (
        <motion.span
          key={i}
          className="absolute left-4 top-1/2 h-2.5 w-2.5 rounded-full"
          initial={{ x: 0, y: (i % 4) * 4 - 6, opacity: 0, backgroundColor: "var(--color-bad)" }}
          animate={{
            x: [0, 120 + i * 18, 900],
            opacity: [0, 1, 0],
            backgroundColor: ["var(--color-bad)", "var(--color-flight)", "var(--color-flight)"],
          }}
          transition={{ duration: 1.3, delay: i * 0.06, ease: [0.3, 0.6, 0.2, 1] }}
        />
      ))}
    </div>
  );
}
