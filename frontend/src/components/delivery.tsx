import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { fullDate, timeAgo } from "../lib/format";
import type { Delivery, DeliveryStatus, Endpoint, ErrorKind } from "../lib/types";
import { Badge, Card, cx, TABLE, TBODY, TD, TH, THEAD, TR } from "./ui";

const STATUS: Record<DeliveryStatus, { label: string; tone: "green" | "red" | "amber" | "slate" | "blue" }> = {
  pending: { label: "Pending", tone: "slate" },
  in_flight: { label: "Sending", tone: "blue" },
  retrying: { label: "Retrying", tone: "amber" },
  succeeded: { label: "Succeeded", tone: "green" },
  dead: { label: "Dead", tone: "red" },
};

export const STATUS_OPTIONS = Object.entries(STATUS).map(([value, { label }]) => ({
  value: value as DeliveryStatus,
  label,
}));

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const { label, tone } = STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}

const ERROR_KINDS: Record<ErrorKind, string> = {
  timeout: "Timed out",
  dns: "DNS lookup failed",
  tls: "TLS error",
  connect: "Could not connect",
  http_status: "Error response",
  ssrf_blocked: "Blocked address",
  other: "Error",
};

export function errorKindLabel(kind: ErrorKind | null): string {
  return kind ? ERROR_KINDS[kind] : "OK";
}

/** "http_status: the receiver answered HTTP 500" -> "The receiver answered HTTP 500".
 *  The stored text starts with an internal error code that means nothing to a user. */
export function readableError(lastError: string | null): string {
  if (!lastError) return "";
  const text = lastError.replace(/^[a-z_]+:\s*/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Endpoints, for filter dropdowns. Shares its cache with the Endpoints page. */
export function useEndpoints() {
  return useQuery({
    queryKey: ["endpoints"],
    queryFn: () => api<Endpoint[]>("/v1/endpoints"),
    // A breaker opening or closing changes what the list should show.
    refetchInterval: 10_000,
  });
}

export function DeliveryTable({ deliveries }: { deliveries: Delivery[] }) {
  return (
    <Card className="overflow-x-auto">
      <table className={TABLE}>
        <thead className={THEAD}>
          <tr>
            <th scope="col" className={cx(TH, "w-32")}>Status</th>
            <th scope="col" className={TH}>Event</th>
            <th scope="col" className={TH}>Endpoint</th>
            <th scope="col" className={cx(TH, "text-right")}>Attempts</th>
            <th scope="col" className={cx(TH, "text-right")}>Created</th>
          </tr>
        </thead>
        <tbody className={TBODY}>
          {deliveries.map((delivery) => (
            <tr key={delivery.id} className={cx(TR, "group relative")}>
              <td className={cx(TD, "whitespace-nowrap")}>
                <DeliveryStatusBadge status={delivery.status} />
              </td>
              <td className={cx(TD, "max-w-sm")}>
                <Link
                  to={`/deliveries/${delivery.id}`}
                  className="font-mono text-xs font-medium text-fg transition-colors after:absolute after:inset-0 group-hover:text-accent"
                >
                  {delivery.event_type}
                </Link>
                {delivery.last_error && (
                  <p className="mt-1 truncate text-xs text-bad/90" title={readableError(delivery.last_error)}>
                    {readableError(delivery.last_error)}
                  </p>
                )}
              </td>
              <td className={cx(TD, "max-w-xs truncate font-mono text-xs text-fg-3")} title={delivery.endpoint_url}>
                {delivery.endpoint_url}
              </td>
              <td className={cx(TD, "tabular text-right text-fg-2")}>{delivery.attempts}</td>
              <td className={cx(TD, "tabular whitespace-nowrap text-right text-fg-3")} title={fullDate(delivery.created_at)}>
                {timeAgo(delivery.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
