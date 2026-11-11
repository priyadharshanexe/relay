"""The fixed sets of values used across the system.

They live in ``domain`` because they are business vocabulary; the database enforces
the same values with CHECK constraints built from these enums.
"""

from enum import StrEnum


class Role(StrEnum):
    OWNER = "owner"
    DEVELOPER = "developer"
    VIEWER = "viewer"


class EndpointStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"  # paused by the customer
    DISABLED = "disabled"  # disabled by the system


class BreakerState(StrEnum):
    CLOSED = "closed"  # healthy: deliveries flow
    OPEN = "open"  # failing: deliveries wait
    HALF_OPEN = "half_open"  # cooling down is over: one probe is allowed


class DeliveryStatus(StrEnum):
    PENDING = "pending"  # never attempted
    IN_FLIGHT = "in_flight"  # claimed by a worker
    RETRYING = "retrying"  # failed, waiting for next_attempt_at
    SUCCEEDED = "succeeded"
    DEAD = "dead"  # out of attempts: in the dead-letter queue


class ErrorKind(StrEnum):
    TIMEOUT = "timeout"
    DNS = "dns"
    TLS = "tls"
    CONNECT = "connect"
    HTTP_STATUS = "http_status"
    SSRF_BLOCKED = "ssrf_blocked"
    OTHER = "other"
