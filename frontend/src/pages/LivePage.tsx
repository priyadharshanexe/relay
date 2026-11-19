import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { endSessionLocally, useAuth } from "../auth/AuthProvider";
import { DeliveryStatusBadge, errorKindLabel, useEndpoints } from "../components/delivery";
import { LiveIcon, PauseIcon, PlayIcon } from "../components/icons";
import { Badge, Button, Card, EmptyState, PageHeader, TABLE, TBODY, TD, TH, THEAD, cx } from "../components/ui";
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

const CONNECTION: Record<Connection, { label: string; dot: string }> = {
  live: { label: "Live", dot: "bg-ok animate-pulse-dot" },
  connecting: { label: "Connecting…", dot: "bg-fg-3" },
  reconnecting: { label: "Reconnecting…", dot: "bg-warn" },
};

export function LivePage() {
  const { organization } = useAuth();
  const { updates, connection, paused, setPaused, clear } = useLiveFeed(organization.id);
  const state = paused ? { label: "Paused", dot: "bg-fg-3" } : CONNECTION[connection];
  const failures = updates.filter((update) => update.error_kind !== null).length;
  // The feed carries endpoint ids; the list we already have turns them into URLs.
  const endpoints = useEndpoints();
  const urlOf = new Map(endpoints.data?.map((endpoint) => [endpoint.id, endpoint.url]));

  return (
    <>
      <PageHeader
        title="Live feed"
        description="Attempts as they happen. This view keeps nothing; the full history is under Deliveries."
        action={
          <div className="flex items-center gap-2">
            <span
              role="status"
              className="mr-1 inline-flex h-8 items-center gap-2 rounded-md border border-line px-3 text-xs font-medium text-fg-2"
            >
              <span aria-hidden="true" className={cx("h-1.5 w-1.5 rounded-full", state.dot)} />
              {state.label}
            </span>
            <Button
              icon={paused ? <PlayIcon width={13} height={13} /> : <PauseIcon width={13} height={13} />}
              onClick={() => setPaused(!paused)}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button variant="ghost" onClick={clear} disabled={updates.length === 0}>
              Clear
            </Button>
          </div>
        }
      />

      {updates.length === 0 ? (
        <EmptyState title="Waiting for deliveries…" icon={<LiveIcon />}>
          Send an event, or use "Send test event" on an endpoint, and it will show up here within a
          moment.
        </EmptyState>
      ) : (
        <>
          <p className="mb-3 text-xs text-fg-3">
            <span className="tabular text-fg-2">{updates.length}</span> attempt{updates.length === 1 ? "" : "s"} since
            you opened this page
            {failures > 0 && (
              <>
                {" · "}
                <span className="tabular text-bad">{failures}</span> failed
              </>
            )}
          </p>
          <Card className="overflow-x-auto">
            <table className={TABLE}>
              <thead className={THEAD}>
                <tr>
                  <th scope="col" className={TH}>Time</th>
                  <th scope="col" className={TH}>Event</th>
                  <th scope="col" className={TH}>Endpoint</th>
                  <th scope="col" className={cx(TH, "text-right")}>Attempt</th>
                  <th scope="col" className={TH}>Result</th>
                  <th scope="col" className={cx(TH, "text-right")}>Duration</th>
                  <th scope="col" className={TH}>Delivery is now</th>
                </tr>
              </thead>
              <tbody className={TBODY}>
                {updates.map((update) => (
                  // New rows slide in from the top; existing rows keep their key and stay put.
                  <tr key={`${update.delivery_id}-${update.attempt}-${update.at}`} className="animate-slide-in">
                    <td className={cx(TD, "tabular whitespace-nowrap font-mono text-xs text-fg-3")}>
                      {new Date(update.at).toLocaleTimeString([], { hourCycle: "h23" })}
                    </td>
                    <td className={TD}>
                      <Link
                        to={`/deliveries/${update.delivery_id}`}
                        className="font-mono text-xs font-medium text-fg transition-colors hover:text-accent"
                      >
                        {update.event_type}
                      </Link>
                    </td>
                    <td
                      className={cx(TD, "max-w-xs truncate font-mono text-xs text-fg-3")}
                      title={urlOf.get(update.endpoint_id)}
                    >
                      {urlOf.get(update.endpoint_id) ?? "(deleted endpoint)"}
                    </td>
                    <td className={cx(TD, "tabular text-right text-fg-2")}>#{update.attempt}</td>
                    <td className={TD}>
                      <Badge tone={update.error_kind === null ? "green" : "red"}>
                        {update.status_code !== null
                          ? `HTTP ${update.status_code}`
                          : errorKindLabel(update.error_kind)}
                      </Badge>
                    </td>
                    <td className={cx(TD, "tabular text-right text-fg-2")}>{milliseconds(update.duration_ms)}</td>
                    <td className={TD}>
                      <DeliveryStatusBadge status={update.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}
