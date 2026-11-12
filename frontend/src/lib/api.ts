/**
 * The one place that talks to the Relay API.
 *
 * - Sessions live in HttpOnly cookies, so there is no token handling here: the
 *   browser attaches the cookies by itself.
 * - Every failure becomes an `ApiError` carrying the API's error code and its
 *   request id, so the UI can show a useful message and support can find the
 *   request in the logs.
 * - When the short-lived access token has expired, the request is retried once
 *   after a silent refresh. The user never notices.
 */

const ORG_STORAGE_KEY = "relay.orgId";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getCurrentOrgId(): string | null {
  return localStorage.getItem(ORG_STORAGE_KEY);
}

export function setCurrentOrgId(orgId: string | null): void {
  if (orgId) localStorage.setItem(ORG_STORAGE_KEY, orgId);
  else localStorage.removeItem(ORG_STORAGE_KEY);
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      code?: string;
      message?: string;
      details?: unknown;
      request_id?: string | null;
    };
    return new ApiError(
      response.status,
      body.code ?? "unknown_error",
      body.message ?? "Something went wrong.",
      body.details ?? null,
      body.request_id ?? response.headers.get("X-Request-ID"),
    );
  } catch {
    return new ApiError(
      response.status,
      "unknown_error",
      "The server sent an unexpected response.",
      null,
      response.headers.get("X-Request-ID"),
    );
  }
}

// Several requests can fail with 401 at once; they must share one refresh,
// because each refresh token works exactly once.
let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  refreshInFlight ??= fetch("/v1/auth/refresh", { method: "POST", credentials: "same-origin" })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | null | undefined>;
  /** Auth routes must not trigger a refresh-and-retry loop. */
  skipRefresh?: boolean;
}

function buildUrl(path: string, query: RequestOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const orgId = getCurrentOrgId();
  if (orgId) headers["X-Org-ID"] = orgId;
  try {
    return await fetch(buildUrl(path, options.query), {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, "network_error", "Could not reach the server. Check your connection.");
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options);

  if (response.status === 401 && !options.skipRefresh && (await refreshSession())) {
    response = await send(path, options);
  }
  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** A message fit to show to a person, whatever was thrown. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

/** Per-field messages from a 422 response, keyed by the field name. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return {};
  const result: Record<string, string> = {};
  for (const item of error.details as { loc?: unknown[]; msg?: string }[]) {
    const field = item.loc?.[item.loc.length - 1];
    if (typeof field === "string" && item.msg) result[field] = item.msg;
  }
  return result;
}
