/** Shapes returned by the Relay API. They mirror the backend's response models. */

export type Role = "owner" | "developer" | "viewer";

export interface User {
  id: string;
  email: string;
}

export interface Organization {
  id: string;
  name: string;
  role: Role;
}

export interface Session {
  user: User;
  organizations: Organization[];
}

export type EndpointStatus = "active" | "paused" | "disabled";
export type BreakerState = "closed" | "open" | "half_open";

export interface Endpoint {
  id: string;
  url: string;
  description: string;
  event_types: string[];
  status: EndpointStatus;
  rate_limit_per_sec: number | null;
  breaker_state: BreakerState;
  created_at: string;
  updated_at: string;
}

export interface EndpointCreated extends Endpoint {
  secret: string;
}

export interface EndpointHealth {
  endpoint_id: string;
  attempts: number;
  successes: number;
  success_rate: number | null;
  p95_ms: number | null;
}

export interface RotatedSecret {
  secret: string;
  previous_secret_expires_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ApiKeyCreated extends ApiKey {
  key: string;
}

export type ReceiverMode = "ok" | "error" | "rate_limit" | "slow" | "timeout";

export interface Receiver {
  id: string;
  name: string;
  url: string;
  mode: ReceiverMode;
  status_code: number;
  delay_ms: number;
  retry_after_seconds: number;
  requests_received: number;
  last_received_at: string | null;
  created_at: string;
}
