/**
 * Shared motion pieces. Every one of them has a still version that shows the
 * same information, used when the person asks for reduced motion (and in tests,
 * where there is no matchMedia).
 */
import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { prefersReducedMotion } from "../lib/motion";
import { cx } from "./ui";

const SPRING = { type: "spring", stiffness: 380, damping: 32, mass: 0.8 } as const;

// ------------------------------------------------------------------ odometer
/**
 * A number whose digits roll into place like a mechanical counter. Each digit
 * is a column 0–9 that springs to its value; when the value changes (41 -> 43)
 * only the digits that change move.
 */
export function Odometer({ value, className }: { value: string; className?: string }) {
  if (prefersReducedMotion()) return <span className={className}>{value}</span>;
  const chars = value.split("");
  return (
    <span className={cx("inline-flex overflow-hidden tabular", className)} aria-label={value} role="img">
      {chars.map((char, index) => {
        const position = chars.length - index; // keyed from the right, so units stay units
        if (!/\d/.test(char)) {
          return (
            <span key={`s${position}`} aria-hidden="true">
              {char}
            </span>
          );
        }
        const digit = Number(char);
        return (
          <span key={`d${position}`} aria-hidden="true" className="relative inline-block h-[1.1em] w-[0.62em] overflow-hidden leading-[1.1em]">
            <motion.span
              className="absolute inset-x-0 top-0 flex flex-col items-center"
              initial={{ y: "0em" }}
              animate={{ y: `${-digit * 1.1}em` }}
              transition={{ ...SPRING, delay: index * 0.04 }}
            >
              {Array.from({ length: 10 }, (_, n) => (
                <span key={n} className="h-[1.1em]">
                  {n}
                </span>
              ))}
            </motion.span>
          </span>
        );
      })}
    </span>
  );
}

// -------------------------------------------------------------------- toasts
type ToastTone = "ok" | "info" | "bad";
interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
}

const ToastContext = createContext<(text: string, tone?: ToastTone) => void>(() => {});

/** Show a short message that springs in at the bottom and leaves by itself. */
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const show = useCallback((text: string, tone: ToastTone = "ok") => {
    const id = next.current++;
    setToasts((current) => [...current.slice(-2), { id, tone, text }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3600);
  }, []);
  const dot = { ok: "bg-ok", info: "bg-accent", bad: "bg-bad" };
  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* A polite live region (no status role, which pages use for their own state). */}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-5 z-[80] flex flex-col items-center gap-2 px-4"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 28, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96, transition: { duration: 0.15 } }}
              transition={SPRING}
              className="pointer-events-auto flex max-w-md items-center gap-2.5 rounded-full border border-line-strong bg-panel px-4 py-2.5 text-[13px] text-fg shadow-pop"
            >
              <span aria-hidden="true" className={cx("h-2 w-2 shrink-0 rounded-full", dot[toast.tone])} />
              {toast.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

// ------------------------------------------------------- pointer interactions
/** Pointer handlers that move a CSS spotlight (--sx, --sy) to follow the cursor
 *  over a card. The light itself is drawn by the .spotlight class. */
export function useSpotlight() {
  return useMemo(
    () => ({
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const box = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty("--sx", `${event.clientX - box.left}px`);
        event.currentTarget.style.setProperty("--sy", `${event.clientY - box.top}px`);
      },
    }),
    [],
  );
}

/** Pointer handlers that pull an element a few pixels towards the cursor, and
 *  let it spring back when the cursor leaves. */
export function useMagnet(strength = 0.18, max = 6) {
  return useMemo(
    () => ({
      onPointerMove(event: PointerEvent<HTMLElement>) {
        if (prefersReducedMotion() || event.pointerType !== "mouse") return;
        const box = event.currentTarget.getBoundingClientRect();
        const clamp = (n: number) => Math.max(-max, Math.min(max, n));
        const x = clamp((event.clientX - (box.left + box.width / 2)) * strength);
        const y = clamp((event.clientY - (box.top + box.height / 2)) * strength);
        event.currentTarget.style.setProperty("--mx", `${x}px`);
        event.currentTarget.style.setProperty("--my", `${y}px`);
      },
      onPointerLeave(event: PointerEvent<HTMLElement>) {
        event.currentTarget.style.setProperty("--mx", "0px");
        event.currentTarget.style.setProperty("--my", "0px");
      },
    }),
    [strength, max],
  );
}

// ---------------------------------------------------------------- reveals
/** A heading that rises out of a mask instead of fading in. */
export function RevealText({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  if (prefersReducedMotion()) return <>{children}</>;
  return (
    <span className="inline-block overflow-hidden pb-[0.08em] align-bottom">
      <motion.span
        className="inline-block"
        initial={{ y: "105%" }}
        animate={{ y: "0%" }}
        transition={{ type: "spring", stiffness: 260, damping: 30, delay }}
      >
        {children}
      </motion.span>
    </span>
  );
}

/** Children appear one after another, each rising a little and un-blurring. */
export function Stagger({
  children,
  className,
  step = 0.06,
  as = "div",
}: {
  children: ReactNode[];
  className?: string;
  step?: number;
  as?: "div" | "ul" | "ol" | "dl";
}) {
  if (prefersReducedMotion()) {
    const Tag = as;
    return <Tag className={className}>{children}</Tag>;
  }
  const Tag = motion[as];
  return (
    <Tag
      className={className}
      initial="hidden"
      animate="shown"
      variants={{ shown: { transition: { staggerChildren: step } } }}
    >
      {children}
    </Tag>
  );
}

/** One item inside <Stagger>. */
export function StaggerItem({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li";
}) {
  if (prefersReducedMotion()) {
    const Tag = as;
    return <Tag className={className}>{children}</Tag>;
  }
  const Tag = motion[as];
  return (
    <Tag
      className={className}
      variants={{
        hidden: { opacity: 0, y: 14, filter: "blur(6px)" },
        shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: SPRING },
      }}
    >
      {children}
    </Tag>
  );
}

export { SPRING };

// ------------------------------------------------------------------ decode
const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789_-";

/**
 * Text that decodes into place: characters resolve left to right out of
 * random glyphs. Used when a secret or id is revealed, so the reveal reads as
 * the value arriving rather than just appearing.
 */
export function ScrambleText({ text, durationMs = 700 }: { text: string; durationMs?: number }) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? text : ""));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(text);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min((now - start) / durationMs, 1);
      const settled = Math.floor(t * text.length);
      let out = text.slice(0, settled);
      for (let i = settled; i < text.length; i++) {
        out += text[i] === " " ? " " : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setShown(out);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text, durationMs]);
  return <>{shown}</>;
}
