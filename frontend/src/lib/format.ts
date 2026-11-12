const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const ABSOLUTE = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "3 minutes ago", "in 2 hours", "just now". */
export function timeAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  if (Math.abs(seconds) < 45) return "just now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return RELATIVE.format(Math.round(seconds / 60), "minute");
}

export function fullDate(iso: string | null): string {
  return iso ? ABSOLUTE.format(new Date(iso)) : "";
}

/** 0.9731 -> "97.3%". null (no attempts yet) -> "—". */
export function percent(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(rate === 1 || rate === 0 ? 0 : 1)}%`;
}

export function milliseconds(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}
