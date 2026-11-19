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
import { ApiError, errorMessage } from "../lib/api";
import { CheckIcon, CloseIcon, CopyIcon } from "./icons";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------- Button
type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANTS: Record<Variant, string> = {
  // A faint top highlight gives the accent button a little depth.
  primary:
    "bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] hover:bg-accent-hover disabled:bg-accent/40 disabled:text-white/60",
  secondary:
    "bg-raised text-fg border border-line-strong hover:bg-hover hover:border-[#3d3e47] disabled:text-fg-3 disabled:hover:bg-raised",
  danger:
    "bg-bad-soft text-bad border border-bad/30 hover:bg-bad/20 hover:border-bad/50 disabled:opacity-50",
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
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
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
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-fg-2">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-fg-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

const INPUT =
  "block h-9 w-full rounded-md border border-line-strong bg-raised px-3 text-[13px] text-fg transition-colors placeholder:text-fg-3 hover:border-[#3d3e47] focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-soft read-only:bg-panel read-only:text-fg-2 disabled:opacity-60 aria-[invalid=true]:border-bad/70 aria-[invalid=true]:focus:ring-bad-soft";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(INPUT, className)} {...rest} />;
}

// A chevron drawn in the field's muted text colour.
const CHEVRON =
  "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%236c6d77' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4.5 6.5 3.5 3.5 3.5-3.5'/%3E%3C/svg%3E\")] bg-[length:16px] bg-[right_0.5rem_center] bg-no-repeat";

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(INPUT, CHEVRON, "cursor-pointer appearance-none pr-8 supports-[appearance:base-select]:pr-2.5", className)} {...rest}>
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------- Badges
export type Tone = "green" | "red" | "amber" | "slate" | "blue";

const TONES: Record<Tone, { pill: string; dot: string }> = {
  green: { pill: "bg-ok-soft text-ok", dot: "bg-ok" },
  red: { pill: "bg-bad-soft text-bad", dot: "bg-bad" },
  amber: { pill: "bg-warn-soft text-warn", dot: "bg-warn" },
  slate: { pill: "bg-hover text-fg-2", dot: "bg-fg-3" },
  blue: { pill: "bg-accent-soft text-[#8fb6ff]", dot: "bg-accent" },
};

/** A status pill. The dot repeats the colour, so the state still reads for
 *  people who can't tell the colours apart: the label always says it in words. */
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
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-2xs font-medium",
        TONES[tone].pill,
      )}
    >
      {dot && <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", TONES[tone].dot)} />}
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

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-20 text-[13px] text-fg-3">
      <Spinner />
      {label}
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
    <div className="rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && (
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-raised text-fg-2">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-medium text-fg">{title}</h3>
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
    <div role="alert" className="rounded-lg border border-bad/25 bg-bad-soft px-3.5 py-3">
      <p className="text-[13px] text-[#ff9b9b]">{errorMessage(error)}</p>
      {requestId && <p className="mt-1 font-mono text-2xs text-bad/70">Request ID: {requestId}</p>}
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
    ok: "border-ok/25 bg-ok-soft text-[#8fe8bb]",
    warn: "border-warn/25 bg-warn-soft text-[#f8d59a]",
    info: "border-accent-line bg-accent-soft text-[#a9c7ff]",
  }[tone];
  return (
    <p role="status" className={cx("animate-rise rounded-lg border px-3.5 py-2.5 text-[13px] leading-relaxed", styles)}>
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
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-fg">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-fg-2">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

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
    <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
      <h2 id={id} className="text-[13px] font-medium text-fg">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-xl border border-line bg-panel", className)}>{children}</div>
  );
}

/** Shared table styling: quiet headers, hairline rows, a hover that only hints. */
export const TABLE = "min-w-full text-[13px]";
export const THEAD =
  "border-b border-line text-left text-xs text-fg-3";
export const TH = "px-4 py-2.5 font-normal";
export const TBODY = "divide-y divide-line";
export const TR = "transition-colors hover:bg-raised/60";
export const TD = "px-4 py-3";

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
      <dd className={cx("tabular mt-1 text-[22px] font-semibold tracking-[-0.02em]", valueTone)}>
        {value}
      </dd>
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
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-3 transition-colors hover:bg-hover hover:text-fg"
    >
      {copied ? <CheckIcon className="text-ok" width={14} height={14} /> : <CopyIcon width={14} height={14} />}
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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 px-4 py-[12vh]"
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
        className="w-full max-w-lg animate-rise rounded-xl border border-line-strong bg-panel shadow-pop focus:outline-none"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 id={titleId} className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
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
        <div className="px-5 pb-5 pt-3 text-[13px] text-fg-2">{children}</div>
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
