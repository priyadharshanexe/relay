import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { endSessionLocally, useAuth } from "../auth/AuthProvider";
import { DeliveryStatusBadge, errorKindLabel, useEndpoints } from "../components/delivery";
import { Badge, Button, Card, EmptyState, PageHeader } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { milliseconds } from "../lib/format";
import type { LiveUpdate } from "../lib/types";

const MAX_ROWS = 200;
const RECONNECT_MS = 3_000;

type Connection = "connecting" | "live" | "reconnecting";

/**
 * Subscribes to the server's event stream (Server-Sent Events) and keeps the
 * most recent updates.
 *
 * `EventSource` reconnects by itself after a network blip, but it gives up for
 * good on an HTTP error. The usual one here is 401, when the 15-minute session
 * token expires while the tab is open. So on a closed stream we refresh the
 * session with an ordinary API call and open a new stream.
 */
export function useLiveFeed(orgId: string) {
  const [updates, setUpdates] = useState<LiveUpdate[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [paused, setPaused] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (paused) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect() {
      source = new EventSource(`/v1/stream/deliveries?org_id=${encodeURIComponent(orgId)}`);
      source.onopen = () => setConnection("live");
      source.addEventListener("delivery.attempt", (event) => {
        try {
          const update = JSON.parse((event as MessageEvent<string>).data) as LiveUpdate;
          setUpdates((current) => [update, ...current].slice(0, MAX_ROWS));
        } catch {
          // A malformed message is not worth breaking the feed for.
        }
      });
      source.onerror = () => {
        setConnection("reconnecting");
        if (source?.readyState !== EventSource.CLOSED) return; // the browser is retrying
        source.close();
        retry = setTimeout(() => {
          // Refreshes the session cookie if it expired, then reconnects.
          api("/v1/auth/me").then(
            () => {
              if (!stopped) connect();
            },
            (error: unknown) => {
              if (stopped) return;
              // The session is really over (logged out elsewhere, or expired
              // for good): stop, and let the app show the login page.
              if (error instanceof ApiError && error.status === 401) endSessionLocally(queryClient);
              else connect(); // a network blip: keep trying
            },
          );
        }, RECONNECT_MS);
      };
    }

    setConnection("connecting");
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [orgId, paused, queryClient]);

  return { updates, connection, paused, setPaused, clear: () => setUpdates([]) };
}

const CONNECTION: Record<Connection, { label: string; tone: "green" | "amber" | "slate" }> = {
  live: { label: "Live", tone: "green" },
  connecting: { label: "Connecting…", tone: "slate" },
  reconnecting: { label: "Reconnecting…", tone: "amber" },
};

export function LivePage() {
  const { organization } = useAuth();
  const { updates, connection, paused, setPaused, clear } = useLiveFeed(organization.id);
  const state = paused ? { label: "Paused", tone: "slate" as const } : CONNECTION[connection];
  // The feed carries endpoint ids; the list we already have turns them into URLs.
  const endpoints = useEndpoints();
  const urlOf = new Map(endpoints.data?.map((endpoint) => [endpoint.id, endpoint.url]));

  return (
    <>
      <PageHeader
        title="Live feed"
        description="Delivery attempts as they happen. Nothing here is stored in your browser: open Deliveries for the full history."
        action={
          <div className="flex items-center gap-3">
            <span role="status">
              <Badge tone={state.tone}>{state.label}</Badge>
            </span>
            <Button onClick={() => setPaused(!paused)}>{paused ? "Resume" : "Pause"}</Button>
            <Button onClick={clear} disabled={updates.length === 0}>
              Clear
            </Button>
          </div>
        }
      />

      {updates.length === 0 ? (
        <EmptyState title="Waiting for deliveries…">
          Send an event, or use "Send test event" on an endpoint, and it will show up here within a
          moment.
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">Time</th>
                <th scope="col" className="px-4 py-3">Event</th>
                <th scope="col" className="px-4 py-3">Endpoint</th>
                <th scope="col" className="px-4 py-3">Attempt</th>
                <th scope="col" className="px-4 py-3">Result</th>
                <th scope="col" className="px-4 py-3">Duration</th>
                <th scope="col" className="px-4 py-3">Delivery is now</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {updates.map((update) => (
                <tr key={`${update.delivery_id}-${update.attempt}-${update.at}`}>
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-600">
                    {new Date(update.at).toLocaleTimeString()}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      to={`/deliveries/${update.delivery_id}`}
                      className="font-mono text-xs font-medium text-brand-700 hover:underline"
                    >
                      {update.event_type}
                    </Link>
                  </td>
                  <td
                    className="max-w-xs truncate px-4 py-2 font-mono text-xs text-slate-600"
                    title={urlOf.get(update.endpoint_id)}
                  >
                    {urlOf.get(update.endpoint_id) ?? "(deleted endpoint)"}
                  </td>
                  <td className="px-4 py-2 text-slate-700">#{update.attempt}</td>
                  <td className="px-4 py-2">
                    <Badge tone={update.error_kind === null ? "green" : "red"}>
                      {update.status_code !== null
                        ? `HTTP ${update.status_code}`
                        : errorKindLabel(update.error_kind)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-slate-700">{milliseconds(update.duration_ms)}</td>
                  <td className="px-4 py-2">
                    <DeliveryStatusBadge status={update.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
