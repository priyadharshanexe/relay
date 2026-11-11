"""Encryption at rest for endpoint signing secrets.

Signing secrets can't be hashed like passwords: to compute an HMAC we need the
original value back. So they are encrypted with AES-256-GCM using a key that lives
only in the environment, never in the database. A stolen database dump alone
reveals no secret.

GCM is *authenticated* encryption: tampering with the stored value makes decryption
fail instead of returning garbage. Each value is also bound to a ``context`` (the
endpoint id), so a ciphertext copied onto another endpoint's row won't decrypt.
"""

import base64
import binascii
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_VERSION = "v1"
_NONCE_BYTES = 12
_KEY_BYTES = 32


class InvalidEncryptionKeyError(ValueError):
    """The configured key is not 32 bytes of base64."""


class DecryptionError(Exception):
    """The stored value is corrupt, was tampered with, or the key/context is wrong."""


class SecretBox:
    def __init__(self, key_base64: str) -> None:
        try:
            key = base64.b64decode(key_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise InvalidEncryptionKeyError("the encryption key must be base64") from exc
        if len(key) != _KEY_BYTES:
            raise InvalidEncryptionKeyError(
                f"the encryption key must decode to exactly {_KEY_BYTES} bytes"
            )
        self._aead = AESGCM(key)

    def encrypt(self, plaintext: str, *, context: str) -> str:
        # A fresh random nonce per message: reusing one with the same key breaks GCM.
        nonce = os.urandom(_NONCE_BYTES)
        ciphertext = self._aead.encrypt(nonce, plaintext.encode(), context.encode())
        return f"{_VERSION}:{base64.b64encode(nonce + ciphertext).decode()}"

    def decrypt(self, token: str, *, context: str) -> str:
        version, _, encoded = token.partition(":")
        if version != _VERSION:
            raise DecryptionError("unknown ciphertext version")
        try:
            raw = base64.b64decode(encoded, validate=True)
            nonce, ciphertext = raw[:_NONCE_BYTES], raw[_NONCE_BYTES:]
            return self._aead.decrypt(nonce, ciphertext, context.encode()).decode()
        except (InvalidTag, binascii.Error, ValueError) as exc:
            raise DecryptionError("could not decrypt the stored secret") from exc
