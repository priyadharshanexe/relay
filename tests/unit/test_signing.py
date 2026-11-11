import base64
from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st
from standardwebhooks import Webhook
from standardwebhooks.webhooks import WebhookVerificationError

from relay.domain.signing import (
    InvalidSecretError,
    Signer,
    VerificationError,
    Verifier,
    generate_secret,
)

NOW = datetime(2026, 11, 11, 12, 0, 0, tzinfo=UTC)
SECRET = "whsec_" + base64.b64encode(b"k" * 32).decode()
OTHER_SECRET = "whsec_" + base64.b64encode(b"z" * 32).decode()
BODY = b'{"type":"order.paid","data":{"order_id":42}}'

message_ids = st.text(
    alphabet=st.characters(min_codepoint=33, max_codepoint=126), min_size=1, max_size=64
)
bodies = st.binary(max_size=2048)
keys = st.binary(min_size=24, max_size=64)


def secret_from(key: bytes) -> str:
    return "whsec_" + base64.b64encode(key).decode()


# --------------------------------------------------- agreement with the official library
def test_signature_matches_the_official_standard_webhooks_library() -> None:
    ours = Signer([SECRET]).sign("msg_1", NOW, BODY)
    theirs = Webhook(SECRET).sign("msg_1", NOW, BODY.decode())

    assert ours.webhook_signature == theirs
    assert ours.webhook_timestamp == str(int(NOW.timestamp()))
    assert ours.webhook_id == "msg_1"


def test_official_library_accepts_what_we_sign() -> None:
    now = datetime.now(UTC)  # the official verifier reads the real clock
    headers = Signer([SECRET]).sign("msg_1", now, BODY).as_dict()

    assert Webhook(SECRET).verify(BODY, headers) == {"type": "order.paid", "data": {"order_id": 42}}


def test_official_library_rejects_a_tampered_body() -> None:
    headers = Signer([SECRET]).sign("msg_1", datetime.now(UTC), BODY).as_dict()

    with pytest.raises(WebhookVerificationError):
        Webhook(SECRET).verify(BODY.replace(b"42", b"43"), headers)


def test_we_accept_what_the_official_library_signs() -> None:
    headers = {
        "webhook-id": "msg_1",
        "webhook-timestamp": str(int(NOW.timestamp())),
        "webhook-signature": Webhook(SECRET).sign("msg_1", NOW, BODY.decode()),
    }

    Verifier(SECRET).verify(headers, BODY, now=NOW)


@given(key=keys, message_id=message_ids, body=st.text(max_size=500))
def test_always_agrees_with_the_official_library(key: bytes, message_id: str, body: str) -> None:
    secret = secret_from(key)

    ours = Signer([secret]).sign(message_id, NOW, body.encode())

    assert ours.webhook_signature == Webhook(secret).sign(message_id, NOW, body)


# ------------------------------------------------------------------ properties
@given(key=keys, message_id=message_ids, body=bodies)
def test_whatever_we_sign_verifies(key: bytes, message_id: str, body: bytes) -> None:
    secret = secret_from(key)
    headers = Signer([secret]).sign(message_id, NOW, body).as_dict()

    Verifier(secret).verify(headers, body, now=NOW)


@given(body=st.binary(min_size=1, max_size=512), data=st.data())
def test_changing_any_byte_of_the_body_breaks_the_signature(
    body: bytes, data: st.DataObject
) -> None:
    headers = Signer([SECRET]).sign("msg_1", NOW, body).as_dict()
    position = data.draw(st.integers(0, len(body) - 1))
    flipped = body[:position] + bytes([body[position] ^ 0x01]) + body[position + 1 :]

    with pytest.raises(VerificationError, match="no matching signature"):
        Verifier(SECRET).verify(headers, flipped, now=NOW)


@given(message_id=message_ids, other_id=message_ids)
def test_changing_the_message_id_breaks_the_signature(message_id: str, other_id: str) -> None:
    if message_id == other_id:
        return
    headers = Signer([SECRET]).sign(message_id, NOW, BODY).as_dict()
    headers["webhook-id"] = other_id

    with pytest.raises(VerificationError):
        Verifier(SECRET).verify(headers, BODY, now=NOW)


@given(shift=st.integers(-299, 299).filter(lambda seconds: seconds != 0))
def test_changing_the_timestamp_breaks_the_signature(shift: int) -> None:
    headers = Signer([SECRET]).sign("msg_1", NOW, BODY).as_dict()
    headers["webhook-timestamp"] = str(int(NOW.timestamp()) + shift)

    with pytest.raises(VerificationError, match="no matching signature"):
        Verifier(SECRET).verify(headers, BODY, now=NOW)


# --------------------------------------------------------------- replay window
def test_a_message_just_inside_the_tolerance_is_accepted() -> None:
    headers = Signer([SECRET]).sign("msg_1", NOW, BODY).as_dict()

    Verifier(SECRET).verify(headers, BODY, now=NOW + timedelta(minutes=5))
    Verifier(SECRET).verify(headers, BODY, now=NOW - timedelta(minutes=5))


def test_a_replayed_old_message_is_rejected() -> None:
    headers = Signer([SECRET]).sign("msg_1", NOW, BODY).as_dict()

    with pytest.raises(VerificationError, match="too old"):
        Verifier(SECRET).verify(headers, BODY, now=NOW + timedelta(minutes=5, seconds=1))


def test_a_message_from_the_future_is_rejected() -> None:
    headers = Signer([SECRET]).sign("msg_1", NOW, BODY).as_dict()

    with pytest.raises(VerificationError, match="future"):
        Verifier(SECRET).verify(headers, BODY, now=NOW - timedelta(minutes=5, seconds=1))


# -------------------------------------------------------------------- rotation
def test_during_rotation_both_old_and_new_secrets_verify() -> None:
    headers = Signer([OTHER_SECRET, SECRET]).sign("msg_1", NOW, BODY).as_dict()

    assert len(headers["webhook-signature"].split(" ")) == 2
    Verifier(SECRET).verify(headers, BODY, now=NOW)
    Verifier(OTHER_SECRET).verify(headers, BODY, now=NOW)


def test_after_rotation_ends_the_old_secret_stops_verifying() -> None:
    headers = Signer([OTHER_SECRET]).sign("msg_1", NOW, BODY).as_dict()

    with pytest.raises(VerificationError, match="no matching signature"):
        Verifier(SECRET).verify(headers, BODY, now=NOW)


# ----------------------------------------------------------- malformed input
def test_header_names_are_case_insensitive() -> None:
    signed = Signer([SECRET]).sign("msg_1", NOW, BODY)
    headers = {
        "Webhook-Id": signed.webhook_id,
        "WEBHOOK-TIMESTAMP": signed.webhook_timestamp,
        "Webhook-Signature": signed.webhook_signature,
    }

    Verifier(SECRET).verify(headers, BODY, now=NOW)


@pytest.mark.parametrize("missing", ["webhook-id", "webhook-timestamp", "webhook-signature"])
def test_a_missing_header_is_rejected(missing: str) -> None:
    headers = Signer([SECRET]).sign("msg_1", NOW, BODY).as_dict()
    del headers[missing]

    with pytest.raises(VerificationError, match="missing"):
        Verifier(SECRET).verify(headers, BODY, now=NOW)


@pytest.mark.parametrize("timestamp", ["yesterday", "12.5", "-5", "", "1e9", "١٢"])
def test_a_malformed_timestamp_is_rejected(timestamp: str) -> None:
    headers = Signer([SECRET]).sign("msg_1", NOW, BODY).as_dict()
    headers["webhook-timestamp"] = timestamp

    with pytest.raises(VerificationError):
        Verifier(SECRET).verify(headers, BODY, now=NOW)


@pytest.mark.parametrize("signature", ["garbage", "v1,", "v2,abc", "v1,not-base64!!", ",", "v1"])
def test_a_malformed_signature_is_rejected_without_crashing(signature: str) -> None:
    headers = Signer([SECRET]).sign("msg_1", NOW, BODY).as_dict()
    headers["webhook-signature"] = signature

    with pytest.raises(VerificationError, match="no matching signature"):
        Verifier(SECRET).verify(headers, BODY, now=NOW)


def test_unknown_signature_versions_are_skipped_not_fatal() -> None:
    headers = Signer([SECRET]).sign("msg_1", NOW, BODY).as_dict()
    headers["webhook-signature"] = "v1a,publickeysig " + headers["webhook-signature"]

    Verifier(SECRET).verify(headers, BODY, now=NOW)


# ---------------------------------------------------------------------- secrets
def test_generated_secrets_are_valid_and_unique() -> None:
    first, second = generate_secret(), generate_secret()

    assert first != second
    assert first.startswith("whsec_")
    assert len(base64.b64decode(first.removeprefix("whsec_"))) == 32
    Signer([first])  # accepted


@pytest.mark.parametrize(
    "bad_secret",
    [
        "no-prefix",
        "whsec_",
        "whsec_!!!not-base64!!!",
        "whsec_" + base64.b64encode(b"short").decode(),
        "whsec_" + base64.b64encode(b"x" * 65).decode(),
    ],
)
def test_bad_secrets_are_rejected(bad_secret: str) -> None:
    with pytest.raises(InvalidSecretError):
        Signer([bad_secret])


def test_signer_needs_at_least_one_secret() -> None:
    with pytest.raises(InvalidSecretError):
        Signer([])


def test_naive_datetimes_are_refused() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        Signer([SECRET]).sign("msg_1", datetime(2026, 11, 11, 12, 0, 0), BODY)


def test_empty_message_id_is_refused() -> None:
    with pytest.raises(ValueError, match="message_id"):
        Signer([SECRET]).sign("", NOW, BODY)
