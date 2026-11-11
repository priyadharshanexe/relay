"""Webhook signatures in the Standard Webhooks format (https://www.standardwebhooks.com).

Every delivery carries three headers:

* ``webhook-id``         unique per message; receivers use it to drop duplicates
* ``webhook-timestamp``  seconds since the epoch, when this attempt was signed
* ``webhook-signature``  ``v1,<base64 HMAC-SHA256>``; several, space-separated,
                         while a secret is being rotated

The signed content is ``{id}.{timestamp}.{body}``. Including the timestamp is what
stops replay attacks: a captured request stops verifying once it is older than the
receiver's tolerance (five minutes by default).
"""

import base64
import binascii
import hashlib
import hmac
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

SECRET_PREFIX = "whsec_"  # noqa: S105 - a public format prefix, not a secret
SIGNATURE_VERSION = "v1"
DEFAULT_TOLERANCE = timedelta(minutes=5)

HEADER_ID = "webhook-id"
HEADER_TIMESTAMP = "webhook-timestamp"
HEADER_SIGNATURE = "webhook-signature"

# The spec asks for keys of 24 to 64 bytes.
_MIN_KEY_BYTES = 24
_MAX_KEY_BYTES = 64


class InvalidSecretError(ValueError):
    """The secret is not in ``whsec_<base64>`` form or has the wrong length."""


class VerificationError(Exception):
    """The request did not come from us, or was altered, or is too old."""


def generate_secret() -> str:
    """A new random signing secret: 32 bytes, shown as ``whsec_<base64>``."""
    return SECRET_PREFIX + base64.b64encode(secrets.token_bytes(32)).decode()


def _decode_secret(secret: str) -> bytes:
    if not secret.startswith(SECRET_PREFIX):
        raise InvalidSecretError(f"a signing secret must start with {SECRET_PREFIX!r}")
    try:
        key = base64.b64decode(secret.removeprefix(SECRET_PREFIX), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidSecretError("a signing secret must be valid base64") from exc
    if not _MIN_KEY_BYTES <= len(key) <= _MAX_KEY_BYTES:
        raise InvalidSecretError(
            f"a signing secret must decode to {_MIN_KEY_BYTES}-{_MAX_KEY_BYTES} bytes"
        )
    return key


def _require_aware(moment: datetime) -> None:
    if moment.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")


def _signature(key: bytes, message_id: str, timestamp: int, body: bytes) -> str:
    signed_content = f"{message_id}.{timestamp}.".encode() + body
    digest = hmac.new(key, signed_content, hashlib.sha256).digest()
    return base64.b64encode(digest).decode()


@dataclass(frozen=True, slots=True)
class SignedHeaders:
    webhook_id: str
    webhook_timestamp: str
    webhook_signature: str

    def as_dict(self) -> dict[str, str]:
        return {
            HEADER_ID: self.webhook_id,
            HEADER_TIMESTAMP: self.webhook_timestamp,
            HEADER_SIGNATURE: self.webhook_signature,
        }


class Signer:
    """Signs outgoing messages with every currently active secret.

    Normally that is one secret. During a rotation it is two (new and old), so a
    receiver still checking with the old secret keeps working until it expires.
    """

    def __init__(self, secrets: Sequence[str]) -> None:
        if not secrets:
            raise InvalidSecretError("at least one signing secret is required")
        self._keys = [_decode_secret(secret) for secret in secrets]

    def sign(self, message_id: str, timestamp: datetime, body: bytes) -> SignedHeaders:
        if not message_id:
            raise ValueError("message_id must not be empty")
        _require_aware(timestamp)
        seconds = int(timestamp.timestamp())
        signatures = " ".join(
            f"{SIGNATURE_VERSION},{_signature(key, message_id, seconds, body)}"
            for key in self._keys
        )
        return SignedHeaders(message_id, str(seconds), signatures)


class Verifier:
    """What a receiver does. Used by the built-in test receiver and by the tests."""

    def __init__(self, secret: str, tolerance: timedelta = DEFAULT_TOLERANCE) -> None:
        self._key = _decode_secret(secret)
        self._tolerance = tolerance

    def verify(self, headers: Mapping[str, str], body: bytes, *, now: datetime) -> None:
        """Return normally if the request is genuine; raise ``VerificationError`` if not."""
        _require_aware(now)
        lowered = {name.lower(): value for name, value in headers.items()}
        message_id = lowered.get(HEADER_ID)
        raw_timestamp = lowered.get(HEADER_TIMESTAMP)
        signatures = lowered.get(HEADER_SIGNATURE)
        if not message_id or not raw_timestamp or not signatures:
            raise VerificationError("missing required webhook headers")

        if not (raw_timestamp.isascii() and raw_timestamp.isdigit()):
            raise VerificationError("webhook-timestamp is not a whole number of seconds")
        timestamp = int(raw_timestamp)
        age_seconds = now.timestamp() - timestamp
        if age_seconds > self._tolerance.total_seconds():
            raise VerificationError("message timestamp is too old")
        if age_seconds < -self._tolerance.total_seconds():
            raise VerificationError("message timestamp is too far in the future")

        expected = _signature(self._key, message_id, timestamp, body).encode()
        for candidate in signatures.split(" "):
            version, _, value = candidate.partition(",")
            if version != SIGNATURE_VERSION:
                continue
            # Constant-time comparison: timing must not reveal how many leading
            # characters of a forged signature were right.
            if hmac.compare_digest(value.encode(), expected):
                return
        raise VerificationError("no matching signature")
