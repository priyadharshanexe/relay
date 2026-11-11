"""Passwords, session tokens and API keys.

Three kinds of secret, three different treatments:

* **Passwords** are low-entropy (people choose them), so they are hashed with
  Argon2id: deliberately slow and memory-hungry, which makes guessing expensive.
* **Refresh tokens and API keys** are long random strings we generate. Guessing
  them is hopeless, so a fast SHA-256 is enough, and it keeps every authenticated
  request cheap. Only the hash is stored: a database leak reveals no usable key.
* **Access tokens** are short-lived signed JWTs, checked without a database
  lookup for the token itself.
"""

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta
from functools import lru_cache

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, InvalidHashError

_JWT_ALGORITHM = "HS256"
_JWT_ISSUER = "relay"
_ACCESS_TOKEN_TYPE = "access"  # noqa: S105 - a token type label, not a secret

API_KEY_MARKER = "rly_"
_API_KEY_PREFIX_LENGTH = 17  # "rly_live_" + 8 characters

_password_hasher = PasswordHasher()


class InvalidTokenError(Exception):
    """The access token is missing, malformed, expired or not signed by us."""


# -------------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    return _password_hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _password_hasher.verify(password_hash, password)
    except (Argon2Error, InvalidHashError):
        return False


@lru_cache(maxsize=1)
def dummy_password_hash() -> str:
    """Verified against when the email is unknown, so that "no such user" takes as
    long as "wrong password" and timing does not reveal which emails exist."""
    return hash_password(secrets.token_urlsafe(16))


# ---------------------------------------------------------------- access tokens
def create_access_token(user_id: uuid.UUID, *, secret: str, ttl: timedelta, now: datetime) -> str:
    claims = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
        "iss": _JWT_ISSUER,
        "typ": _ACCESS_TOKEN_TYPE,
    }
    return jwt.encode(claims, secret, algorithm=_JWT_ALGORITHM)


def decode_access_token(token: str, *, secret: str) -> uuid.UUID:
    """Return the user id inside a valid token; raise ``InvalidTokenError`` otherwise."""
    try:
        claims = jwt.decode(
            token,
            secret,
            # Pinning the algorithm blocks "alg: none" and algorithm-swap attacks.
            algorithms=[_JWT_ALGORITHM],
            issuer=_JWT_ISSUER,
            options={"require": ["sub", "iat", "exp", "iss"]},
        )
        if claims.get("typ") != _ACCESS_TOKEN_TYPE:
            raise InvalidTokenError("wrong token type")
        return uuid.UUID(claims["sub"])
    except (jwt.PyJWTError, ValueError, TypeError) as exc:
        raise InvalidTokenError(str(exc)) from exc


# ------------------------------------------------- refresh tokens and API keys
def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_refresh_token() -> tuple[str, str]:
    """Return ``(token, token_hash)``. The token goes to the browser, the hash to the DB."""
    token = secrets.token_urlsafe(48)
    return token, hash_token(token)


def new_api_key(*, live: bool) -> tuple[str, str, str]:
    """Return ``(key, prefix, key_hash)``.

    The key looks like ``rly_live_Ab12Cd34...``. The prefix (first 17 characters)
    is stored in the clear so the dashboard can show which key is which.
    """
    key = f"{API_KEY_MARKER}{'live' if live else 'test'}_{secrets.token_urlsafe(32)}"
    return key, key[:_API_KEY_PREFIX_LENGTH], hash_token(key)
