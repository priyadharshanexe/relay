"""Sending one webhook over HTTP, safely.

Two rules matter here:

* **Connect to the IP that passed the SSRF check, not to the hostname.** The URL's
  host is swapped for the vetted IP, while the original name is still sent as the
  ``Host`` header and used for TLS (SNI and certificate check). If we let the HTTP
  client resolve the name again, an attacker's DNS could answer with a private
  address the second time.
* **Never follow redirects.** A public URL may redirect to an internal one.

Whatever the receiver does (hang, reset, send gigabytes, send garbage), ``send``
returns a ``SendResult`` describing it. It never raises for a delivery failure.
"""

import asyncio
import ipaddress
import socket
import ssl
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import httpx

from relay.domain.enums import ErrorKind
from relay.domain.ssrf import ResolvedTarget, UnresolvableHostError

_MAX_STORED_HEADERS = 40
_MAX_HEADER_VALUE = 300
_SENSITIVE_HEADERS = frozenset({"set-cookie", "authorization", "proxy-authorization", "cookie"})


@dataclass(frozen=True, slots=True)
class SendResult:
    duration_ms: int
    status_code: int | None = None
    error_kind: ErrorKind | None = None
    error_message: str | None = None
    response_snippet: str | None = None
    response_headers: dict[str, str] | None = None
    retry_after: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.error_kind is None


def clean_text(value: str, limit: int | None = None) -> str:
    """Make arbitrary receiver output safe to store: PostgreSQL text cannot hold
    NUL characters, and we never keep more than ``limit`` characters."""
    value = value.replace("\x00", "")
    return value if limit is None else value[:limit]


def mask_headers(headers: Mapping[str, str]) -> dict[str, str]:
    """Headers as stored in the delivery log: bounded, with secrets hidden."""
    stored: dict[str, str] = {}
    for name, value in list(headers.items())[:_MAX_STORED_HEADERS]:
        lowered = name.lower()
        if lowered in _SENSITIVE_HEADERS:
            stored[lowered] = "****"
        elif lowered == "webhook-signature":
            # Keep the version and a few characters so signatures can be told
            # apart in the log, without storing a reusable signature.
            stored[lowered] = " ".join(f"{part[:9]}****" for part in value.split(" "))
        else:
            stored[lowered] = clean_text(value, _MAX_HEADER_VALUE)
    return stored


async def system_resolver(host: str, port: int) -> Sequence[str]:
    """Resolve ``host`` with the operating system's resolver."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise UnresolvableHostError(f"{host} could not be resolved") from exc
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def _caused_by_tls(exc: BaseException) -> bool:
    seen: BaseException | None = exc
    while seen is not None:
        if isinstance(seen, ssl.SSLError):
            return True
        seen = seen.__cause__ or seen.__context__
    return False


class Sender:
    def __init__(self, *, connect_timeout: float, total_timeout: float, snippet_bytes: int) -> None:
        self._total_timeout = total_timeout
        self._snippet_bytes = snippet_bytes
        self._client = httpx.AsyncClient(
            follow_redirects=False,
            trust_env=False,  # ignore HTTP(S)_PROXY: a proxy would bypass IP pinning
            timeout=httpx.Timeout(total_timeout, connect=connect_timeout),
            limits=httpx.Limits(max_connections=200, max_keepalive_connections=0),
        )

    @property
    def client(self) -> httpx.AsyncClient:
        """The underlying client, exposed so tracing can be attached to it."""
        return self._client

    async def aclose(self) -> None:
        await self._client.aclose()

    async def send(
        self, url: str, target: ResolvedTarget, headers: Mapping[str, str], body: bytes
    ) -> SendResult:
        original = httpx.URL(url)
        pinned = original.copy_with(host=target.ip)
        request_headers = {**headers, "host": original.netloc.decode("ascii")}
        extensions: dict[str, str] = {}
        if target.scheme == "https" and not _is_ip_literal(target.host):
            # Present and verify the certificate for the real hostname, even
            # though the TCP connection goes to the pinned IP.
            extensions["sni_hostname"] = target.host

        started = time.perf_counter()

        def elapsed_ms() -> int:
            return int((time.perf_counter() - started) * 1000)

        def failed(kind: ErrorKind, message: str) -> SendResult:
            return SendResult(elapsed_ms(), error_kind=kind, error_message=clean_text(message, 500))

        try:
            # httpx's own timeouts are per phase (connect, each read). This outer
            # one caps the whole exchange, so a receiver that drips one byte at a
            # time cannot hold a worker slot forever.
            async with (
                asyncio.timeout(self._total_timeout),
                self._client.stream(
                    "POST", pinned, headers=request_headers, content=body, extensions=extensions
                ) as response,
            ):
                snippet = await self._read_snippet(response)
                response_headers = mask_headers(response.headers)
                status = response.status_code
        except (TimeoutError, httpx.TimeoutException):
            return failed(ErrorKind.TIMEOUT, "the receiver did not respond in time")
        except httpx.ConnectError as exc:
            if _caused_by_tls(exc):
                return failed(ErrorKind.TLS, f"TLS handshake failed: {exc}")
            return failed(ErrorKind.CONNECT, f"could not connect: {exc}")
        except httpx.HTTPError as exc:
            if _caused_by_tls(exc):
                return failed(ErrorKind.TLS, f"TLS error: {exc}")
            return failed(ErrorKind.OTHER, f"{type(exc).__name__}: {exc}")

        ok = 200 <= status < 300
        return SendResult(
            elapsed_ms(),
            status_code=status,
            error_kind=None if ok else ErrorKind.HTTP_STATUS,
            error_message=None if ok else f"the receiver answered HTTP {status}",
            response_snippet=snippet,
            response_headers=response_headers,
            retry_after=response.headers.get("retry-after"),
        )

    async def _read_snippet(self, response: httpx.Response) -> str:
        """Read at most ``snippet_bytes`` of the body and ignore the rest."""
        collected = bytearray()
        if self._snippet_bytes > 0:
            async for chunk in response.aiter_bytes():
                collected.extend(chunk)
                if len(collected) >= self._snippet_bytes:
                    break
        return clean_text(bytes(collected[: self._snippet_bytes]).decode("utf-8", "replace"))
