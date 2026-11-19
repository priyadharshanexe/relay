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
