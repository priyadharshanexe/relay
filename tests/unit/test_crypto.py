import base64

import pytest
from hypothesis import given
from hypothesis import strategies as st

from relay.core.config import DEV_ENCRYPTION_KEY
from relay.core.crypto import DecryptionError, InvalidEncryptionKeyError, SecretBox

KEY = base64.b64encode(b"k" * 32).decode()
OTHER_KEY = base64.b64encode(b"z" * 32).decode()
box = SecretBox(KEY)


@given(plaintext=st.text(max_size=300), context=st.text(max_size=50))
def test_whatever_is_encrypted_decrypts_to_the_same_value(plaintext: str, context: str) -> None:
    assert box.decrypt(box.encrypt(plaintext, context=context), context=context) == plaintext


def test_the_stored_value_does_not_contain_the_secret() -> None:
    token = box.encrypt("whsec_c2VjcmV0", context="endpoint-1")

    assert "whsec_" not in token
    assert b"whsec_" not in base64.b64decode(token.removeprefix("v1:"))


def test_encrypting_twice_gives_different_ciphertexts() -> None:
    """A fresh nonce each time: equal secrets must not look equal in the database."""
    first = box.encrypt("same secret", context="endpoint-1")
    second = box.encrypt("same secret", context="endpoint-1")

    assert first != second


def test_a_different_key_cannot_decrypt() -> None:
    token = box.encrypt("secret", context="endpoint-1")

    with pytest.raises(DecryptionError):
        SecretBox(OTHER_KEY).decrypt(token, context="endpoint-1")


def test_a_ciphertext_moved_to_another_endpoint_does_not_decrypt() -> None:
    token = box.encrypt("secret", context="endpoint-1")

    with pytest.raises(DecryptionError):
        box.decrypt(token, context="endpoint-2")


@given(position=st.integers(0, 39), bit=st.integers(0, 7))
def test_any_bit_flip_is_detected(position: int, bit: int) -> None:
    token = box.encrypt("a signing secret", context="endpoint-1")
    raw = bytearray(base64.b64decode(token.removeprefix("v1:")))
    raw[position % len(raw)] ^= 1 << bit
    tampered = "v1:" + base64.b64encode(bytes(raw)).decode()

    with pytest.raises(DecryptionError):
        box.decrypt(tampered, context="endpoint-1")


@pytest.mark.parametrize("token", ["", "v1:", "v2:abcd", "v1:not base64!", "plain text", "v1:AAAA"])
def test_malformed_stored_values_fail_cleanly(token: str) -> None:
    with pytest.raises(DecryptionError):
        box.decrypt(token, context="endpoint-1")


@pytest.mark.parametrize(
    "key",
    ["", "not base64!!", base64.b64encode(b"short").decode(), base64.b64encode(b"x" * 33).decode()],
)
def test_bad_keys_are_rejected_at_startup(key: str) -> None:
    with pytest.raises(InvalidEncryptionKeyError):
        SecretBox(key)


def test_the_development_key_is_well_formed() -> None:
    SecretBox(DEV_ENCRYPTION_KEY)
