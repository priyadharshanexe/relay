/**
 * Behind the sign-in form: a slow, faint dispatch of packets along delivery
 * routes, so the first screen already shows what Relay does. Real SVG geometry,
 * no images. Left out entirely under reduced motion.
 */
import { prefersReducedMotion } from "../lib/motion";

// Routes fan out from a source on the left to destinations on the right.
const ROUTES = [
  "M -40 380 C 260 380 420 140 760 150 S 1240 120 1500 90",
  "M -40 380 C 300 380 460 300 820 300 S 1240 330 1500 300",
  "M -40 380 C 280 380 480 470 840 480 S 1260 560 1500 560",
  "M -40 380 C 320 380 520 640 860 660 S 1260 720 1500 760",
  "M -40 380 C 240 380 380 40 700 20 S 1200 -20 1500 -40",
];

// Each packet: which route, how long a trip takes, when it leaves, its colour.
// Trips of 6–8 s, staggered so three or four are always on their way.
const PACKETS: [number, number, number, string][] = [
  [0, 6.5, 0, "var(--color-ok)"],
  [1, 7, 1.1, "var(--color-ok)"],
  [2, 7.5, 2.3, "var(--color-warn)"],
  [3, 8, 0.6, "var(--color-ok)"],
  [4, 7.5, 3.4, "var(--color-ok)"],
  [1, 7, 4.6, "var(--color-bad)"],
  [2, 7.5, 5.7, "var(--color-ok)"],
  [0, 6.5, 3.2, "var(--color-flight)"],
  [3, 8, 4.8, "var(--color-ok)"],
  [4, 7.5, 6.9, "var(--color-ok)"],
];

export function DispatchBackdrop() {
  if (prefersReducedMotion()) return null;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1440 760"
      preserveAspectRatio="xMidYMid slice"
      className="pointer-events-none absolute inset-0 h-full w-full [mask-image:radial-gradient(ellipse_at_center,rgb(0_0_0/0.25)_18%,black_62%)]"
    >
      <g fill="none" stroke="var(--color-fg-3)" strokeOpacity={0.35} strokeWidth={1.5}>
        {ROUTES.map((d, i) => (
          <path key={i} id={`route-${i}`} d={d} />
        ))}
      </g>
      <g className="flow" fill="none" stroke="var(--color-accent)" strokeWidth={1.5} opacity={0.55}>
        {ROUTES.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </g>
      {PACKETS.map(([route, seconds, delay, colour], i) => (
        <g key={i}>
          <circle r={12} fill={colour} opacity={0.22}>
            <animateMotion dur={`${seconds}s`} begin={`${delay}s`} repeatCount="indefinite" rotate="auto">
              <mpath href={`#route-${route}`} />
            </animateMotion>
          </circle>
          <circle r={5} fill={colour}>
            <animateMotion dur={`${seconds}s`} begin={`${delay}s`} repeatCount="indefinite">
              <mpath href={`#route-${route}`} />
            </animateMotion>
          </circle>
        </g>
      ))}
    </svg>
  );
}
