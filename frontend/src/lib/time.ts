/** 95 -> "1 min 35 s", 7200 -> "2 h". The wait between attempts, i.e. the backoff. */
export function gap(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest && minutes < 10 ? `${minutes} min ${rest} s` : `${Math.round(seconds / 60)} min`;
  }
  const hours = seconds / 3600;
  return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} h`;
}

/** "21:36:01" today; "18 Nov, 21:36:01" on any other day, so a time is never
 *  mistaken for today's. */
export function attemptTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hourCycle: "h23" });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}
