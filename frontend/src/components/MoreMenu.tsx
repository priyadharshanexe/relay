/**
 * "⋯ More": a small menu for actions you rarely need or that can't be undone,
 * kept away from the everyday buttons next to it. It closes on Escape, on a
 * click outside, and after an action is chosen.
 */
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cx } from "./ui";

export interface MoreAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export function MoreMenu({ label, actions }: { label: string; actions: MoreAction[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 items-center gap-1 rounded-[5px] px-2 text-xs font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <circle cx="3.5" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="12.5" cy="8" r="1.4" />
        </svg>
        More
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={id}
            initial={{ opacity: 0, scale: 0.94, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ type: "spring", stiffness: 500, damping: 32 }}
            className="absolute right-0 top-full z-20 mt-1.5 min-w-44 origin-top-right rounded-lg border border-line-strong bg-panel p-1 shadow-pop"
          >
            {actions.map((action, index): ReactNode => (
              <div key={action.label}>
                {/* A rule keeps the destructive action apart from the others. */}
                {action.danger && index > 0 && <div aria-hidden="true" className="my-1 h-px bg-line" />}
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    action.onSelect();
                  }}
                  className={cx(
                    "flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                    action.danger ? "text-bad hover:bg-bad-soft" : "text-fg hover:bg-hover",
                  )}
                >
                  {action.label}
                </button>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
