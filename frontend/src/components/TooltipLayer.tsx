/**
 * One tooltip for the whole app, in place of the browser's own.
 *
 * Pages keep using the plain `title` attribute (on truncated URLs, ids, dates
 * and icon buttons). When the pointer or keyboard focus reaches such an element,
 * this layer moves the title into `data-tip` (so the browser's grey box never
 * appears) and shows a styled tooltip above it instead. Without JavaScript the
 * browser's tooltip still works, so nothing depends on this.
 */
import { useEffect, useRef, useState } from "react";

interface Tip {
  text: string;
  x: number;
  y: number;
  below: boolean;
}

const DELAY_MS = 350;
const GAP = 8;

function withTip(node: Element): HTMLElement | null {
  return node.closest<HTMLElement>("[title], [data-tip]");
}

/** The element whose tip applies at this point. A table row's link is
 *  stretched over the whole row to make it clickable, so the cell under the
 *  pointer (a truncated URL, say) is beneath the link: look through the stack. */
function tipAt(event: Event): HTMLElement | null {
  let element: HTMLElement | null = null;
  if (event instanceof PointerEvent) {
    for (const node of document.elementsFromPoint(event.clientX, event.clientY)) {
      element = withTip(node);
      if (element) break;
    }
  } else if (event.target instanceof Element) {
    element = withTip(event.target);
  }
  if (!element) return null;
  const title = element.getAttribute("title");
  if (title) {
    element.dataset.tip = title;
    element.removeAttribute("title");
  }
  return element.dataset.tip ? element : null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function show(element: HTMLElement) {
      const text = element.dataset.tip ?? "";
      // A title that only repeats what is already fully visible adds nothing.
      if (!text || (element.textContent?.trim() === text && element.scrollWidth <= element.clientWidth)) return;
      const box = element.getBoundingClientRect();
      const below = box.top < 48;
      setTip({
        text,
        x: Math.min(Math.max(box.left + box.width / 2, 12), window.innerWidth - 12),
        y: below ? box.bottom + GAP : box.top - GAP,
        below,
      });
    }

    function enter(event: Event) {
      const element = tipAt(event);
      if (element === current.current) return;
      current.current = element;
      clearTimeout(timer.current);
      setTip(null);
      if (element) timer.current = setTimeout(() => show(element), event.type === "focusin" ? 0 : DELAY_MS);
    }

    function leave() {
      current.current = null;
      clearTimeout(timer.current);
      setTip(null);
    }

    // pointermove, not pointerover: moving between cells under one stretched
    // link never leaves the link, so pointerover would not fire again.
    let frame = 0;
    function move(event: PointerEvent) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => enter(event));
    }
    document.addEventListener("pointermove", move);
    document.addEventListener("focusin", enter);
    document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", leave);
    window.addEventListener("scroll", leave, true);
    return () => {
      clearTimeout(timer.current);
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("focusin", enter);
      document.removeEventListener("focusout", leave);
      document.removeEventListener("pointerdown", leave);
      window.removeEventListener("scroll", leave, true);
    };
  }, []);

  if (!tip) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[70] max-w-[min(28rem,calc(100vw-24px))] animate-fade break-all rounded-md border border-line-strong bg-raised px-2 py-1 text-xs text-fg shadow-pop"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
      }}
    >
      {tip.text}
    </div>
  );
}
