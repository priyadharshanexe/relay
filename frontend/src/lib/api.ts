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

interface ValidationDetail {
  loc?: unknown[];
  msg?: string;
  type?: string;
}

const LOCATIONS = new Set(["body", "query", "path", "header"]);

/** The server's validator speaks to developers ("String should have at least 1
 *  character"). Say the same thing the way a person would. */
function friendlyMessage(detail: ValidationDetail): string {
  const message = detail.msg ?? "This value is not valid.";
  const number = (pattern: RegExp) => pattern.exec(message)?.[1];
  switch (detail.type) {
    case "missing":
      return "This is required.";
    case "string_too_short": {
      const least = number(/at least (\d+)/);
      return least && least !== "1" ? `Use at least ${least} characters.` : "This is required.";
    }
    case "string_too_long": {
      const most = number(/at most (\d+)/);
      return most ? `Use at most ${most} characters.` : "This is too long.";
    }
    case "string_pattern_mismatch":
      return "This contains characters that are not allowed. Use letters, numbers, dots, dashes and underscores.";
    case "greater_than_equal": {
      const least = number(/equal to (-?\d+)/);
      return least ? `Enter ${least} or more.` : message;
    }
    case "less_than_equal": {
      const most = number(/equal to (-?\d+)/);
      return most ? `Enter ${most} or less.` : message;
    }
    case "int_parsing":
    case "int_type":
    case "int_from_float":
      return "Enter a whole number.";
    case "too_long":
      return "There are too many items.";
    case "value_error":
      return /email/i.test(message)
        ? "Enter a valid email address, like name@example.com."
        : message.replace(/^Value error, /, "");
    default:
      return message;
  }
}

/** Per-field messages from a 422 response, keyed by the field name. An error on
 *  one item of a list (loc: body, event_types, 1) belongs to the list's field. */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return {};
  const result: Record<string, string> = {};
  for (const item of error.details as ValidationDetail[]) {
    const field = item.loc?.find(
      (part): part is string => typeof part === "string" && !LOCATIONS.has(part),
    );
    if (field && !(field in result)) result[field] = friendlyMessage(item);
  }
  return result;
}
