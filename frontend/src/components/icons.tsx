/**
 * A small set of 16px line icons, drawn for Relay on one grid with one stroke
 * width so they sit together evenly. Decorative: always aria-hidden, the text
 * next to them carries the meaning.
 */
import type { ReactNode, SVGProps } from "react";

function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement>;

export const OverviewIcon = (p: P) => (
  <Icon {...p}>
    <rect x="2" y="2" width="5" height="5" rx="1.2" />
    <rect x="9" y="2" width="5" height="5" rx="1.2" />
    <rect x="2" y="9" width="5" height="5" rx="1.2" />
    <path d="M9 13.5 11 11l1.5 1.5L14 10" />
  </Icon>
);
export const EndpointsIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="3.5" cy="8" r="1.5" />
    <circle cx="12.5" cy="3.5" r="1.5" />
    <circle cx="12.5" cy="12.5" r="1.5" />
    <path d="M5 8h2.5c1.4 0 2-1 2.5-2l.9-1.6M7.5 8c1.4 0 2 1 2.5 2l.9 1.6" />
  </Icon>
);
export const DeliveriesIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2 8h9M8 4.5 11.5 8 8 11.5" />
    <path d="M14 3v10" />
  </Icon>
);
export const DeadLetterIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2 9.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V9.5" />
    <path d="M2 9.5 4 3h8l2 6.5h-3.5l-1 1.5h-3l-1-1.5H2Z" />
  </Icon>
);
export const LiveIcon = (p: P) => (
  <Icon {...p}>
    <path d="M1.5 8h2.5l2-4.5 3.5 9 2-4.5h3" />
  </Icon>
);
export const ReceiverIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <circle cx="8" cy="8" r="3" />
    <circle cx="8" cy="8" r="0.6" fill="currentColor" />
  </Icon>
);
export const KeyIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="5.5" cy="10.5" r="3" />
    <path d="m7.7 8.3 5.8-5.8M11.5 4.5l1.5 1.5M10 6l1.2 1.2" />
  </Icon>
);
export const TeamIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="6" cy="5.5" r="2.5" />
    <path d="M1.5 13.5c.6-2.3 2.3-3.5 4.5-3.5s3.9 1.2 4.5 3.5" />
    <path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 10.3c1.2.5 2 1.6 2.5 3.2" />
  </Icon>
);
export const LogoutIcon = (p: P) => (
  <Icon {...p}>
    <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6" />
    <path d="M10.5 11 13.5 8l-3-3M13.5 8H6" />
  </Icon>
);
export const CopyIcon = (p: P) => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </Icon>
);
export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <path d="m3 8.5 3 3 7-7" />
  </Icon>
);
export const PlusIcon = (p: P) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);
export const CloseIcon = (p: P) => (
  <Icon {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);
export const MenuIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Icon>
);
export const ChevronIcon = (p: P) => (
  <Icon {...p}>
    <path d="m6 4 4 4-4 4" />
  </Icon>
);
export const ArrowLeftIcon = (p: P) => (
  <Icon {...p}>
    <path d="M13 8H3M7 4 3 8l4 4" />
  </Icon>
);
export const ReplayIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.7-4" />
    <path d="M2.5 2.5v3h3" />
  </Icon>
);
export const PauseIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5.5 3.5v9M10.5 3.5v9" />
  </Icon>
);
export const PlayIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5 3.2v9.6L12.5 8 5 3.2Z" />
  </Icon>
);
export const SendIcon = (p: P) => (
  <Icon {...p}>
    <path d="m2.5 7.5 11-5-4.5 11-2-4.5-4.5-1.5ZM7 9l3-3" />
  </Icon>
);
export const ClockIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Icon>
);
export const AlertIcon = (p: P) => (
  <Icon {...p}>
    <path d="M8 2 14.5 13.5h-13L8 2Z" />
    <path d="M8 6.5v3M8 11.5v.01" />
  </Icon>
);
export const ShieldIcon = (p: P) => (
  <Icon {...p}>
    <path d="M8 1.8 13 3.5v4c0 3.2-2.1 5.6-5 6.7-2.9-1.1-5-3.5-5-6.7v-4L8 1.8Z" />
  </Icon>
);

export const SunIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
  </Icon>
);
export const MoonIcon = (p: P) => (
  <Icon {...p}>
    <path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1Z" />
  </Icon>
);
export const SystemIcon = (p: P) => (
  <Icon {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.3" />
    <path d="M5.5 13.8h5M8 11.2v2.6" />
  </Icon>
);

/**
 * Relay's mark, "Retry loop": a delivery arrow that loops back once (the retry)
 * and carries on to its destination. The line takes the text colour, so it
 * works on both themes; the start point and arrowhead are signal orange.
 */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 64 64" width="28" height="28" className={className}>
      <path
        d="M8 40 H 26 C 40 40 42 18 30 18 C 18 18 20 40 34 40 H 52"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M45 33 L53 40 L45 47"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="40" r="5" fill="var(--color-accent)" />
    </svg>
  );
}
