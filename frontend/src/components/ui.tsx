import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { ApiError, errorMessage } from "../lib/api";
import { useCountUp } from "../lib/motion";
import { useMagnet, useSpotlight } from "./motionkit";
import { CheckIcon, CloseIcon, CopyIcon } from "./icons";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------- Button
type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary:
    "magnetic bg-accent text-on-accent shadow-[0_1px_0_rgb(0_0_0/0.12)] hover:bg-accent-hover hover:shadow-[var(--glow-signal)] disabled:opacity-45 disabled:hover:shadow-none",
  secondary:
    "bg-panel text-fg border border-line-strong shadow-[0_1px_0_rgb(0_0_0/0.04)] hover:bg-hover disabled:text-fg-3 disabled:hover:bg-panel",
  danger: "bg-panel text-bad border border-bad/35 hover:bg-bad-soft disabled:opacity-50",
  ghost: "text-fg-2 hover:bg-hover hover:text-fg disabled:text-fg-3 disabled:hover:bg-transparent",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  busy?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  busy = false,
  icon,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const magnet = useMagnet();
  return (
    <button
      {...(variant === "primary" ? magnet : {})}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        // Presses down a little: feedback you can feel, never a bounce.
        "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] font-medium transition-[background-color,border-color,color,transform,opacity] duration-150 active:translate-y-px active:scale-[0.985] disabled:cursor-not-allowed disabled:active:translate-y-0 disabled:active:scale-100",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-[13px]",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner small /> : icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------- Fields
interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}

/** A label, an input, an optional hint and an error message, wired together so
 *  screen readers announce the hint and the error with the input. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-fg">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-fg-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 animate-fade text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

const INPUT =
  "block h-9 w-full rounded-[5px] border border-line-strong bg-raised px-3 text-[13px] text-fg transition-[border-color,box-shadow] duration-150 placeholder:text-fg-3 hover:border-fg-3/60 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-soft disabled:opacity-60 aria-[invalid=true]:border-bad/70 aria-[invalid=true]:focus:ring-bad-soft";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  // Read-only styling for inputs only: every <select> also matches :read-only.
  return <input className={cx(INPUT, "read-only:bg-hover read-only:text-fg-2", className)} {...rest} />;
}

// A chevron for browsers without the customizable select (it draws its own).
const CHEVRON =
  "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%238a867b' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4.5 6.5 3.5 3.5 3.5-3.5'/%3E%3C/svg%3E\")] bg-[length:16px] bg-[right_0.5rem_center] bg-no-repeat";

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(INPUT, CHEVRON, "cursor-pointer appearance-none pr-8 supports-[appearance:base-select]:pr-2.5", className)}
      {...rest}
    >
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------- Badges
/**
 * green: succeeded / closed / 2xx; amber: retrying / half-open / 4xx;
 * red: dead / open / 5xx; blue: in flight; slate: pending, or not a state.
 */
export type Tone = "green" | "red" | "amber" | "slate" | "blue";

const TONES: Record<Tone, { pill: string; dot: string }> = {
  green: { pill: "bg-ok-soft text-ok", dot: "bg-ok" },
  red: { pill: "bg-bad-soft text-bad", dot: "bg-bad" },
  amber: { pill: "bg-warn-soft text-warn", dot: "bg-warn" },
  slate: { pill: "bg-hover text-fg-2", dot: "bg-pending" },
  blue: { pill: "bg-flight-soft text-flight", dot: "bg-flight" },
};

/** A state chip. When the state changes (pending -> in flight -> succeeded) the
 *  colours cross-fade rather than jump. The label always says the state in
 *  words, so colour is never the only signal. */
export function Badge({
  tone = "slate",
  dot = true,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-[4px] px-2 text-xs font-medium transition-colors duration-300",
        TONES[tone].pill,
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cx("h-1.5 w-1.5 rounded-full transition-colors duration-300", TONES[tone].dot, tone === "blue" && "animate-pulse")}
        />
      )}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------- States
export function Spinner({ small = false }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cx(
        "inline-block animate-spin rounded-full border-[1.5px] border-current border-r-transparent opacity-80",
        small ? "h-3 w-3" : "h-4 w-4",
      )}
    />
  );
}

/** A placeholder shaped like the content on its way, instead of a spinner. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("skeleton block", className)} />;
}

export function LoadingState({ label = "Loading…", rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 py-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 border-b border-line py-3 last:border-0">
          <Skeleton className="h-4 w-20" />
          <Skeleton className={cx("h-4", ["w-2/5", "w-1/3", "w-1/2", "w-1/4"][index % 4])} />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  icon,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="animate-rise rounded-lg border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && (
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-line bg-panel text-fg-2">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold tracking-[-0.01em] text-fg">{title}</h3>
      {children && <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-fg-2">{children}</p>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

/** Shown when a request failed. Includes the request id, which is what support
 *  needs to find this exact request in the server logs. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  // The request id helps support trace a failure that is ours. For an ordinary
  // mistake (wrong password, invalid input) it is only noise.
  const requestId = error instanceof ApiError && error.status >= 500 ? error.requestId : null;
  return (
    <div role="alert" className="animate-fade rounded-[5px] border border-bad/30 border-l-[3px] border-l-bad bg-bad-soft px-3.5 py-3">
      <p className="text-[13px] text-fg">{errorMessage(error)}</p>
      {requestId && <p className="mt-1 font-mono text-2xs text-fg-2">Request ID: {requestId}</p>}
      {onRetry && (
        <Button size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** A short confirmation or explanation inside a page. */
export function Notice({
  tone = "ok",
  children,
}: {
  tone?: "ok" | "warn" | "info";
  children: ReactNode;
}) {
  const styles = {
    ok: "border-l-ok bg-ok-soft",
    warn: "border-l-warn bg-warn-soft",
    info: "border-l-accent bg-accent-soft",
  }[tone];
  return (
    <p
      role="status"
      className={cx("animate-rise rounded-[5px] border-l-[3px] px-3.5 py-2.5 text-[13px] leading-relaxed text-fg", styles)}
    >
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------- Layout
export function PageHeader({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2">{eyebrow}</div>}
        <h1 className="text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] text-fg">{title}</h1>
        {description && (
          <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-fg-2">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/** A section heading sitting on a hairline rule, like a printed report. */
export function SectionTitle({
  children,
  id,
  action,
}: {
  children: ReactNode;
  id?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex min-h-8 items-end justify-between gap-3 border-b border-line pb-2">
      <h2 id={id} className="text-lg font-semibold tracking-[-0.01em] text-fg">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function Card({
  children,
  className,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  /** Lights up under the pointer: for cards you act on. */
  interactive?: boolean;
}) {
  const spotlight = useSpotlight();
  return (
    <div
      {...(interactive ? spotlight : {})}
      className={cx("rounded-lg border border-line bg-panel", interactive && "spotlight", className)}
    >
      {children}
    </div>
  );
}

/** Shared table styling: quiet headers, hairline rows, a hover that only hints. */
export const TABLE = "min-w-full text-[13px]";
export const THEAD = "border-b border-line text-left text-xs text-fg-3";
export const TH = "px-4 py-2.5 font-medium";
export const TBODY = "divide-y divide-line";
export const TR = "transition-colors duration-150 hover:bg-hover/60";
export const TD = "px-4 py-3";

/** A number that counts to its value when it appears or changes. */
export function CountUp({
  value,
  format = (n) => Math.round(n).toLocaleString(),
}: {
  value: number;
  format?: (n: number) => string;
}) {
  // Not a live region, so screen readers read the value when they reach it,
  // never the frames in between.
  return <>{format(useCountUp(value))}</>;
}

/** A key figure: a label above a large value, with an optional note below. */
export function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "ok" | "warn" | "bad";
}) {
  const valueTone = tone ? { ok: "text-ok", warn: "text-warn", bad: "text-bad" }[tone] : "text-fg";
  return (
    <div>
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className={cx("tabular font-display mt-1 text-2xl font-semibold tracking-[-0.02em]", valueTone)}>{value}</dd>
      {note && <dd className="mt-0.5 text-xs text-fg-3">{note}</dd>}
    </div>
  );
}

// ------------------------------------------------------------------ Copyable
/** Copies ``value``; shows a tick for a moment. Clipboard access can be denied,
 *  so the text it belongs to always stays selectable as a fallback. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Denied: the value is still selectable.
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-3 transition-colors hover:bg-hover hover:text-fg active:scale-90"
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={copied ? "done" : "copy"}
          initial={{ scale: 0.4, rotate: -45, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          exit={{ scale: 0.4, rotate: 45, opacity: 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 28 }}
          className="inline-flex"
        >
          {copied ? <CheckIcon className="text-ok" width={14} height={14} /> : <CopyIcon width={14} height={14} />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

/** An identifier, URL or other machine value: monospace, truncated with the
 *  full value on hover, and copyable. */
export function Mono({
  value,
  className,
  copy = false,
}: {
  value: string;
  className?: string;
  copy?: boolean;
}) {
  return (
    <span className={cx("inline-flex min-w-0 max-w-full items-center gap-1", className)}>
      <span className="truncate font-mono text-xs text-fg-2" title={value}>
        {value}
      </span>
      {copy && <CopyButton value={value} label="Copy to clipboard" />}
    </span>
  );
}

// ----------------------------------------------------------------------- Modal
interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  /** false: only a button inside can close it. Use when closing by accident
   *  would lose something, such as a secret that is shown once. */
  dismissible?: boolean;
  children: ReactNode;
}

/** A modal dialog: announced as a dialog to screen readers, closes on Escape or
 *  a click outside, moves focus inside when it opens and back when it closes. */
export function Modal({ title, open, onClose, dismissible = true, children }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(
      "input, select, textarea, button:not([aria-label='Close'])",
    );
    (first ?? panel.current)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissible) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade items-start justify-center overflow-y-auto bg-[rgb(20_19_16/0.45)] px-4 py-[12vh]"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-lg animate-rise rounded-lg border border-line-strong bg-panel shadow-pop focus:outline-none"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id={titleId} className="text-lg font-semibold tracking-[-0.01em] text-fg">
            {title}
          </h2>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1.5 flex h-7 w-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg"
            >
              <CloseIcon width={14} height={14} />
            </button>
          )}
        </div>
        <div className="px-5 pb-5 pt-4 text-[13px] text-fg-2">{children}</div>
      </div>
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  onConfirm,
  onClose,
}: ConfirmProps) {
  return (
    <Modal title={title} open={open} onClose={onClose}>
      <div className="leading-relaxed text-fg-2">{children}</div>
      {error ? (
        <div className="mt-4">
          <ErrorState error={error} />
        </div>
      ) : null}
      <div className="mt-6 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
