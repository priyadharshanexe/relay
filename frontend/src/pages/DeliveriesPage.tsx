import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { DeliveryTable, STATUS_OPTIONS, useEndpoints } from "../components/delivery";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from "../components/ui";
import { api } from "../lib/api";
import type { Delivery, Page } from "../lib/types";

const FILTER_KEYS = ["status", "endpoint_id", "event_type", "from", "to"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Partial<Record<FilterKey, string>>;

/**
 * The filters live in the URL's query string, not in component state. That makes
 * a filtered view shareable (copy the address bar) and makes Back and Forward
 * work as people expect.
 */
function useFilters(fixed: Filters = {}) {
  const [params, setParams] = useSearchParams();
  const filters: Filters = { ...fixed };
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value && !(key in fixed)) filters[key] = value;
  }

  function setFilter(key: FilterKey, value: string) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }
  const active = FILTER_KEYS.some((key) => !(key in fixed) && params.has(key));
  return { filters, setFilter, clear: () => setParams({}, { replace: true }), active };
}

/** <input type="datetime-local"> gives local time without a zone; the API wants ISO. */
function toIso(local: string | undefined): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function useDeliveries(filters: Filters) {
  return useInfiniteQuery({
    queryKey: ["deliveries", filters],
    queryFn: ({ pageParam }) =>
      api<Page<Delivery>>("/v1/deliveries", {
        query: {
          ...filters,
          from: toIso(filters.from),
          to: toIso(filters.to),
          cursor: pageParam,
          limit: 25,
        },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    refetchInterval: 10_000,
  });
}

function FilterBar({
  filters,
  setFilter,
  showStatus,
}: {
  filters: Filters;
  setFilter: (key: FilterKey, value: string) => void;
  showStatus: boolean;
}) {
  const endpoints = useEndpoints();
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {showStatus && (
        <Field label="Status">
          {(props) => (
            <Select
              {...props}
              value={filters.status ?? ""}
              onChange={(event) => setFilter("status", event.target.value)}
            >
              <option value="">Any status</option>
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label="Endpoint">
        {(props) => (
          <Select
            {...props}
            value={filters.endpoint_id ?? ""}
            onChange={(event) => setFilter("endpoint_id", event.target.value)}
          >
            <option value="">Any endpoint</option>
            {endpoints.data?.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.url}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Event type">
        {(props) => (
          <Input
            {...props}
            placeholder="order.paid"
            value={filters.event_type ?? ""}
            onChange={(event) => setFilter("event_type", event.target.value.trim())}
          />
        )}
      </Field>
      <Field label="From">
        {(props) => (
          <Input
            {...props}
            type="datetime-local"
            value={filters.from ?? ""}
            onChange={(event) => setFilter("from", event.target.value)}
          />
        )}
      </Field>
      <Field label="To">
        {(props) => (
          <Input
            {...props}
            type="datetime-local"
            value={filters.to ?? ""}
            onChange={(event) => setFilter("to", event.target.value)}
          />
        )}
      </Field>
    </div>
  );
}

function DeliveryList({
  filters,
  active,
  onClear,
  emptyTitle,
  emptyText,
}: {
  filters: Filters;
  active: boolean;
  onClear: () => void;
  emptyTitle: string;
  emptyText: string;
}) {
  const query = useDeliveries(filters);
  const deliveries = query.data?.pages.flatMap((page) => page.items) ?? [];

  if (query.isPending) return <LoadingState label="Loading deliveries…" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (deliveries.length === 0) {
    return active ? (
      <EmptyState title="Nothing matches these filters" action={<Button onClick={onClear}>Clear filters</Button>}>
        Try a wider time range or a different status.
      </EmptyState>
    ) : (
      <EmptyState title={emptyTitle}>{emptyText}</EmptyState>
    );
  }
  return (
    <>
      <DeliveryTable deliveries={deliveries} />
      <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
        <span>
          Showing {deliveries.length} deliver{deliveries.length === 1 ? "y" : "ies"}
        </span>
        {query.hasNextPage && (
          <Button busy={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            Load more
          </Button>
        )}
      </div>
    </>
  );
}

export function DeliveriesPage() {
  const { filters, setFilter, clear, active } = useFilters();
  return (
    <>
      <PageHeader
        title="Deliveries"
        description="Every webhook Relay has tried to deliver. Open one to see each attempt and what came back."
        action={active ? <Button onClick={clear}>Clear filters</Button> : undefined}
      />
      <FilterBar filters={filters} setFilter={setFilter} showStatus />
      <DeliveryList
        filters={filters}
        active={active}
        onClear={clear}
        emptyTitle="No deliveries yet"
        emptyText="Deliveries appear here as soon as you send an event that an endpoint subscribes to."
      />
    </>
  );
}

/** The dead-letter queue: deliveries that used up every attempt. */
export function DeadLetterPage() {
  const { canEdit } = useAuth();
  const queryClient = useQueryClient();
  const { filters, setFilter, clear, active } = useFilters({ status: "dead" });
  const [confirming, setConfirming] = useState(false);
  const [replayed, setReplayed] = useState<number | null>(null);

  const replay = useMutation({
    mutationFn: () =>
      api<{ replayed: number }>("/v1/deliveries/replay", {
        method: "POST",
        body: {
          status: "dead",
          endpoint_id: filters.endpoint_id ?? null,
          event_type: filters.event_type ?? null,
          from: toIso(filters.from) ?? null,
          to: toIso(filters.to) ?? null,
        },
      }),
    onSuccess: async (result) => {
      setConfirming(false);
      setReplayed(result.replayed);
      await queryClient.invalidateQueries({ queryKey: ["deliveries"] });
    },
  });

  return (
    <>
      <PageHeader
        title="Dead-letter queue"
        description="Deliveries that failed every attempt. Once the receiving server is fixed, replay them and Relay sends them again with a fresh retry schedule."
        action={
          canEdit && (
            <Button variant="primary" onClick={() => setConfirming(true)}>
              {active ? "Replay matching" : "Replay all"}
            </Button>
          )
        }
      />
      {replayed !== null && (
        <p role="status" className="mb-4 rounded-md bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          {replayed === 0
            ? "Nothing to replay."
            : `${replayed} deliver${replayed === 1 ? "y" : "ies"} queued for replay.`}
        </p>
      )}
      <FilterBar filters={filters} setFilter={setFilter} showStatus={false} />
      <DeliveryList
        filters={filters}
        active={active}
        onClear={clear}
        emptyTitle="The dead-letter queue is empty"
        emptyText="Good news: no delivery has run out of attempts."
      />
      <ConfirmDialog
        open={confirming}
        title={active ? "Replay the matching dead deliveries?" : "Replay every dead delivery?"}
        confirmLabel="Replay"
        busy={replay.isPending}
        error={replay.isError ? replay.error : undefined}
        onConfirm={() => replay.mutate()}
        onClose={() => setConfirming(false)}
      >
        {active
          ? "Every dead delivery matching the current filters will be sent again."
          : "Every dead delivery in this organisation will be sent again."}{" "}
        Make sure the receiving servers are ready: they may get a burst of requests.
      </ConfirmDialog>
    </>
  );
}
