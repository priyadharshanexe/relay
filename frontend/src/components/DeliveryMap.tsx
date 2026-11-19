/**
 * The delivery map: your app -> Relay -> each endpoint, with a dead-letter tray,
 * drawn from the organisation's real endpoints. Every delivery attempt on the
 * live stream sends a packet along the paths:
 *
 * - it leaves your app in flight (blue) and reaches Relay;
 * - Relay sends it to the endpoint; on arrival it shows the outcome:
 *   accepted (green) lands and the endpoint pulses;
 *   failed with retries left (amber) comes back and circles Relay, waiting;
 *   failed for good (red) comes back and drops into the dead-letter tray.
 *
 * With no traffic yet the map can run a simulation, clearly labelled as one.
 * Under reduced motion it is a still diagram with the same numbers on it.
 */
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotion } from "../lib/motion";
import type { LiveUpdate } from "../lib/types";

export type Outcome = "ok" | "retry" | "dead";

export interface MapEndpoint {
  id: string;
  name: string;
  /** closed / half_open / open breaker, or paused. */
  state: "closed" | "half_open" | "open" | "paused";
  ok: number;
  failed: number;
}

export interface Packet {
  id: number;
  endpoint: number; // index into the endpoints shown
  outcome: Outcome;
}

/** Outcome of a live attempt, as the map shows it. */
export function outcomeOf(update: Pick<LiveUpdate, "error_kind" | "status">): Outcome {
  if (update.error_kind === null) return "ok";
  return update.status === "dead" ? "dead" : "retry";
}

// ------------------------------------------------------------------ geometry
interface Point {
  x: number;
  y: number;
}
export interface Layout {
  vertical: boolean;
  width: number;
  height: number;
  app: Point;
  hub: Point;
  tray: Point;
  endpoints: Point[];
  feed: string;
  routes: string[];
  drop: string;
}

/** Where everything sits: across on a wide screen, top to bottom on a phone. */
export function layoutFor(count: number, vertical: boolean): Layout {
  const n = Math.max(count, 1);
  if (!vertical) {
    const app = { x: 72, y: 160 };
    const hub = { x: 300, y: 160 };
    const tray = { x: 300, y: 312 };
    const endpoints = Array.from({ length: n }, (_, i) => ({
      x: 648,
      y: n === 1 ? 160 : 34 + (252 / (n - 1)) * i,
    }));
    return {
      vertical,
      width: 760,
      height: 350,
      app,
      hub,
      tray,
      endpoints,
      feed: `M ${app.x + 64} ${app.y} L ${hub.x - 64} ${hub.y}`,
      routes: endpoints.map(
        (e) => `M ${hub.x + 64} ${hub.y} C ${hub.x + 150} ${hub.y} ${e.x - 200} ${e.y} ${e.x - 106} ${e.y}`,
      ),
      drop: `M ${hub.x} ${hub.y + 38} L ${tray.x} ${tray.y - 26}`,
    };
  }
  const app = { x: 150, y: 46 };
  const hub = { x: 150, y: 196 };
  const tray = { x: 300, y: 196 };
  const endpoints = Array.from({ length: n }, (_, i) => ({
    x: n === 1 ? 180 : 62 + (236 / (n - 1)) * i,
    y: 410,
  }));
  return {
    vertical,
    width: 360,
    height: 470,
    app,
    hub,
    tray,
    endpoints,
    feed: `M ${app.x} ${app.y + 26} L ${hub.x} ${hub.y - 38}`,
    routes: endpoints.map(
      (e) => `M ${hub.x} ${hub.y + 38} C ${hub.x} ${hub.y + 130} ${e.x} ${e.y - 130} ${e.x} ${e.y - 30}`,
    ),
    drop: `M ${hub.x + 62} ${hub.y} L ${tray.x - 40} ${tray.y}`,
  };
}

/** The midpoint of a "M x y C x1 y1 x2 y2 x y" curve: (P0 + 3P1 + 3P2 + P3) / 8. */
export function curveMidpoint(d: string): Point {
  const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = n;
  return { x: (x0 + 3 * x1 + 3 * x2 + x3) / 8, y: (y0 + 3 * y1 + 3 * y2 + y3) / 8 };
}

// ------------------------------------------------------------------- traffic
interface Recent {
  at: number;
  outcome: Outcome;
}

/**
 * Packets in flight, and the last minute's numbers. Fed by live attempts; when
 * `simulate` is on and nothing real has arrived, it makes up plausible traffic.
 */
export function useTraffic({
  endpointIds,
  updates,
  simulate,
}: {
  endpointIds: string[];
  updates: LiveUpdate[];
  simulate: boolean;
}) {
  const [packets, setPackets] = useState<Packet[]>([]);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [deadLanded, setDeadLanded] = useState(0);
  const next = useRef(1);
  const seen = useRef(new Set<string>());
  const [live, setLive] = useState(false);

  const spawn = useCallback((endpoint: number, outcome: Outcome) => {
    const id = next.current++;
    setPackets((current) => [...current.slice(-23), { id, endpoint, outcome }]);
    setRecent((current) => [...current.filter((r) => r.at > Date.now() - 60_000), { at: Date.now(), outcome }]);
  }, []);

  // Real attempts, newest first in `updates`: send each one once.
  useEffect(() => {
    for (const update of [...updates].reverse()) {
      const key = `${update.delivery_id}-${update.attempt}-${update.at}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      setLive(true);
      const index = endpointIds.indexOf(update.endpoint_id);
      spawn(index >= 0 ? index : Math.max(endpointIds.length - 1, 0), outcomeOf(update));
    }
  }, [updates, endpointIds, spawn]);

  // Simulated traffic, only until something real arrives.
  const simulating = simulate && !live && !prefersReducedMotion();
  useEffect(() => {
    if (!simulating) return;
    const count = Math.max(endpointIds.length, 1);
    const timer = setInterval(() => {
      const roll = Math.random();
      spawn(Math.floor(Math.random() * count), roll < 0.76 ? "ok" : roll < 0.93 ? "retry" : "dead");
    }, 900);
    return () => clearInterval(timer);
  }, [simulating, endpointIds.length, spawn]);

  const done = useCallback((packet: Packet) => {
    setPackets((current) => current.filter((p) => p.id !== packet.id));
    if (packet.outcome === "dead") setDeadLanded((n) => n + 1);
  }, []);

  const lastMinute = recent.filter((r) => r.at > Date.now() - 60_000);
  const accepted = lastMinute.filter((r) => r.outcome === "ok").length;
  return {
    packets,
    done,
    live,
    simulating,
    deadLanded,
    perMinute: lastMinute.length,
    successRate: lastMinute.length ? accepted / lastMinute.length : null,
  };
}

// -------------------------------------------------------------------- packet
const LEG_MS = { feed: 420, route: 700, back: 520, orbit: 700, drop: 460 };
const COLOUR: Record<Outcome | "flight", string> = {
  flight: "var(--color-flight)",
  ok: "var(--color-ok)",
  retry: "var(--color-warn)",
  dead: "var(--color-bad)",
};

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

type Leg =
  | { kind: "path"; path: SVGPathElement; reverse?: boolean; ms: number; colour: string }
  | { kind: "orbit"; centre: Point; ms: number; colour: string };

/** One packet: a dot with a short glowing trail, moved along its legs every frame. */
function PacketDot({
  packet,
  paths,
  hub,
  onArrive,
  onDone,
}: {
  packet: Packet;
  paths: { feed: SVGPathElement | null; routes: (SVGPathElement | null)[]; drop: SVGPathElement | null };
  hub: Point;
  onArrive: (packet: Packet) => void;
  onDone: (packet: Packet) => void;
}) {
  const dot = useRef<SVGCircleElement>(null);
  const halo = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const route = paths.routes[packet.endpoint];
    if (!paths.feed || !route || !paths.drop) {
      onDone(packet);
      return;
    }
    const tone = COLOUR[packet.outcome];
    const legs: Leg[] = [
      { kind: "path", path: paths.feed, ms: LEG_MS.feed, colour: COLOUR.flight },
      { kind: "path", path: route, ms: LEG_MS.route, colour: COLOUR.flight },
    ];
    if (packet.outcome !== "ok") {
      legs.push({ kind: "path", path: route, reverse: true, ms: LEG_MS.back, colour: tone });
      legs.push(
        packet.outcome === "retry"
          ? { kind: "orbit", centre: hub, ms: LEG_MS.orbit, colour: tone }
          : { kind: "path", path: paths.drop, ms: LEG_MS.drop, colour: tone },
      );
    }
    const total = legs.reduce((sum, leg) => sum + leg.ms, 0);
    const start = performance.now();
    let arrived = false;
    let frame = 0;

    const step = (now: number) => {
      let elapsed = now - start;
      if (elapsed >= total) {
        onDone(packet);
        return;
      }
      let index = 0;
      while (index < legs.length - 1 && elapsed > (legs[index]?.ms ?? 0)) {
        elapsed -= legs[index]?.ms ?? 0;
        index += 1;
      }
      const leg = legs[index];
      if (!leg) return;
      // A failed packet has reached the endpoint once it starts back.
      if (!arrived && index >= 2) {
        arrived = true;
        onArrive(packet);
      }
      const t = ease(Math.min(elapsed / leg.ms, 1));
      let point: Point;
      if (leg.kind === "path") {
        const length = leg.path.getTotalLength();
        const at = leg.reverse ? (1 - t) * length : t * length;
        const p = leg.path.getPointAtLength(at);
        point = { x: p.x, y: p.y };
      } else {
        const angle = -Math.PI / 2 + t * Math.PI * 2;
        point = { x: leg.centre.x + Math.cos(angle) * 54, y: leg.centre.y + Math.sin(angle) * 44 };
      }
      // In flight it is blue; nearing the endpoint it takes the outcome's colour.
      const colour = index === 1 && t > 0.85 ? tone : leg.colour;
      for (const element of [dot.current, halo.current]) {
        element?.setAttribute("cx", String(point.x));
        element?.setAttribute("cy", String(point.y));
        element?.setAttribute("fill", colour);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    // An "ok" packet lands at the end of its route.
    const landing =
      packet.outcome === "ok" ? setTimeout(() => onArrive(packet), LEG_MS.feed + LEG_MS.route - 20) : undefined;
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(landing);
    };
    // The packet's path is fixed when it is sent; it never re-plans.
  }, []);

  return (
    <g>
      <circle ref={halo} r={11} opacity={0.22} cx={-20} cy={-20} />
      <circle ref={dot} r={5} cx={-20} cy={-20} />
    </g>
  );
}

// ----------------------------------------------------------------------- map
const STATE_DOT: Record<MapEndpoint["state"], string> = {
  closed: "var(--color-ok)",
  half_open: "var(--color-warn)",
  open: "var(--color-bad)",
  paused: "var(--color-pending)",
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface Flash {
  key: number;
  endpoint: number;
  outcome: Outcome;
}

export function DeliveryMap({
  endpoints,
  packets,
  onDone,
  waiting,
  dead,
  vertical,
  simulated,
}: {
  endpoints: MapEndpoint[];
  packets: Packet[];
  onDone: (packet: Packet) => void;
  waiting: number;
  dead: number;
  vertical: boolean;
  simulated: boolean;
}) {
  const shown = endpoints.slice(0, vertical ? 3 : 5);
  const layout = useMemo(() => layoutFor(shown.length, vertical), [shown.length, vertical]);
  const feed = useRef<SVGPathElement>(null);
  const drop = useRef<SVGPathElement>(null);
  const routes = useRef<(SVGPathElement | null)[]>([]);
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const [trayBump, setTrayBump] = useState(0);
  const reduced = prefersReducedMotion();

  const arrive = useCallback((packet: Packet) => {
    const key = packet.id * 10 + 1;
    setFlashes((current) => [...current.slice(-8), { key, endpoint: packet.endpoint, outcome: packet.outcome }]);
    setTimeout(() => setFlashes((current) => current.filter((f) => f.key !== key)), 900);
  }, []);
  const finish = useCallback(
    (packet: Packet) => {
      if (packet.outcome === "dead") setTrayBump((n) => n + 1);
      onDone(packet);
    },
    [onDone],
  );

  const draw = (delay: number) =>
    reduced
      ? {}
      : {
          initial: { pathLength: 0, opacity: 0 },
          animate: { pathLength: 1, opacity: 1 },
          transition: { duration: 0.9, delay, ease: [0.2, 0.7, 0.2, 1] as const },
        };
  const nodeIn = (delay: number) =>
    reduced
      ? {}
      : {
          initial: { opacity: 0, scale: 0.85 },
          animate: { opacity: 1, scale: 1 },
          transition: { type: "spring" as const, stiffness: 260, damping: 22, delay },
        };

  const { app, hub, tray } = layout;
  const nodeW = vertical ? 92 : 212;

  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={`Delivery map: your app sends events to Relay, which delivers them to ${shown.length} endpoint${
        shown.length === 1 ? "" : "s"
      }. ${waiting} waiting, ${dead} in the dead-letter queue.${simulated ? " Showing simulated traffic." : ""}`}
      className="h-auto w-full select-none overflow-visible"
    >
      <defs>
        <filter id="map-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* Paths: drawn in, then dashes flow along them in the direction of travel. */}
      <g fill="none" strokeLinecap="round">
        <motion.path ref={feed} d={layout.feed} stroke="var(--color-line-strong)" strokeWidth={2} {...draw(0.1)} />
        {layout.routes.map((d, i) => {
          // An open circuit breaker cuts the line: Relay has stopped sending there.
          const cut = shown[i]?.state === "open";
          return (
            <motion.path
              key={`r${i}`}
              ref={(element) => {
                routes.current[i] = element;
              }}
              d={d}
              stroke={cut ? "var(--color-bad)" : "var(--color-line-strong)"}
              strokeOpacity={cut ? 0.7 : 1}
              strokeDasharray={cut ? "6 5" : undefined}
              strokeWidth={2}
              {...draw(0.35 + i * 0.08)}
            />
          );
        })}
        <motion.path ref={drop} d={layout.drop} stroke="var(--color-line-strong)" strokeWidth={2} strokeDasharray="4 6" {...draw(0.6)} />
        <g className="flow" stroke="var(--color-accent)" strokeWidth={2} opacity={0.55}>
          <path d={layout.feed} />
          {layout.routes.map((d, i) => (shown[i]?.state === "open" ? null : <path key={`f${i}`} d={d} />))}
        </g>
        {/* Where a breaker is open, the route breaks with a gap and a cross. */}
        {layout.routes.map((_, i) => {
          if (shown[i]?.state !== "open") return null;
          const mid = curveMidpoint(layout.routes[i] ?? "");
          return (
            <g key={`cut${i}`} transform={`translate(${mid.x} ${mid.y})`}>
              <circle r={11} fill="var(--color-panel)" stroke="var(--color-bad)" strokeWidth={1.5} />
              <path d="M -4 -4 L 4 4 M 4 -4 L -4 4" stroke="var(--color-bad)" strokeWidth={2} strokeLinecap="round" />
            </g>
          );
        })}
      </g>

      {/* Your app */}
      <motion.g {...nodeIn(0)} style={{ transformOrigin: `${app.x}px ${app.y}px` }}>
        <rect x={app.x - 64} y={app.y - 26} width={128} height={52} rx={10} fill="var(--color-panel)" stroke="var(--color-line-strong)" />
        <text x={app.x} y={app.y + 6} textAnchor="middle" fontSize={17} fontWeight={600} fill="var(--color-fg)" style={{ fontFamily: "var(--font-display)" }}>
          Your app
        </text>
      </motion.g>

      {/* Relay, the hub */}
      <motion.g {...nodeIn(0.15)} style={{ transformOrigin: `${hub.x}px ${hub.y}px` }}>
        <rect x={hub.x - 64} y={hub.y - 38} width={128} height={76} rx={14} fill="var(--color-accent)" filter="url(#map-glow)" opacity={0.35} />
        <rect x={hub.x - 64} y={hub.y - 38} width={128} height={76} rx={14} fill="var(--color-accent)" />
        <text x={hub.x} y={hub.y - 2} textAnchor="middle" fontSize={23} fontWeight={700} fill="var(--color-on-accent)" style={{ fontFamily: "var(--font-display)" }}>
          Relay
        </text>
        <text x={hub.x} y={hub.y + 21} textAnchor="middle" fontSize={13} fill="var(--color-on-accent)" opacity={0.8}>
          {waiting} waiting
        </text>
      </motion.g>

      {/* Dead-letter tray */}
      <motion.g
        key={`tray-${trayBump}`}
        initial={reduced || trayBump === 0 ? false : { scale: 1.15 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 14 }}
        style={{ transformOrigin: `${tray.x}px ${tray.y}px` }}
      >
        <rect x={tray.x - 40} y={tray.y - 24} width={80} height={48} rx={8} fill="var(--color-bad-soft)" stroke="var(--color-bad)" strokeDasharray="4 3" />
        <text x={tray.x} y={tray.y - 1} textAnchor="middle" fontSize={18} fontWeight={700} fill="var(--color-bad)" style={{ fontFamily: "var(--font-display)" }}>
          {dead}
        </text>
        <text x={tray.x} y={tray.y + 15} textAnchor="middle" fontSize={11} fill="var(--color-fg-2)">
          dead letters
        </text>
      </motion.g>

      {/* Endpoints */}
      {shown.map((endpoint, i) => {
        const point = layout.endpoints[i];
        if (!point) return null;
        const flash = flashes.filter((f) => f.endpoint === i).at(-1);
        return (
          <motion.g key={endpoint.id} {...nodeIn(0.45 + i * 0.07)} style={{ transformOrigin: `${point.x}px ${point.y}px` }}>
            <AnimatePresence>
              {flash && !reduced && (
                <motion.rect
                  key={flash.key}
                  x={point.x - nodeW / 2}
                  y={point.y - 22}
                  width={nodeW}
                  height={44}
                  rx={10}
                  fill="none"
                  stroke={COLOUR[flash.outcome]}
                  strokeWidth={2}
                  initial={{ opacity: 0.9, scale: 1 }}
                  animate={{ opacity: 0, scale: 1.18 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.7, ease: "easeOut" }}
                  style={{ transformOrigin: `${point.x}px ${point.y}px` }}
                />
              )}
            </AnimatePresence>
            <rect
              x={point.x - nodeW / 2}
              y={point.y - 22}
              width={nodeW}
              height={44}
              rx={10}
              fill="var(--color-panel)"
              stroke={flash ? COLOUR[flash.outcome] : "var(--color-line-strong)"}
              style={{ transition: "stroke 300ms" }}
            />
            <circle cx={point.x - nodeW / 2 + 14} cy={point.y - (vertical ? 6 : 0)} r={4} fill={STATE_DOT[endpoint.state]} />
            <text
              x={point.x - nodeW / 2 + 26}
              y={point.y + (vertical ? -2 : -2)}
              fontSize={vertical ? 11 : 15}
              fontWeight={600}
              fill="var(--color-fg)"
            >
              {truncate(endpoint.name, vertical ? 10 : 21)}
            </text>
            <text x={point.x - nodeW / 2 + (vertical ? 10 : 26)} y={point.y + 15} fontSize={vertical ? 10 : 12} fill="var(--color-fg-3)" style={{ fontFamily: "var(--font-mono)" }}>
              {vertical ? `${endpoint.ok}✓ ${endpoint.failed}✕` : `${endpoint.ok} ok · ${endpoint.failed} failed`}
            </text>
          </motion.g>
        );
      })}

      {/* Packets */}
      {!reduced &&
        packets.map((packet) => (
          <PacketDot
            key={packet.id}
            packet={packet}
            hub={hub}
            paths={{ feed: feed.current, routes: routes.current, drop: drop.current }}
            onArrive={arrive}
            onDone={finish}
          />
        ))}
    </svg>
  );
}
