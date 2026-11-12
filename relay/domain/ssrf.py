"""SSRF guard: never let a customer point us at our own network.

A customer chooses the URL we send to. Without this guard they could register
``http://169.254.169.254/`` (cloud metadata, which hands out credentials) or
``http://10.0.0.5:5432/`` and use our servers to reach places they can't.

The defence has three parts:

1. Validate the URL: http(s) only, no embedded credentials.
2. Resolve the hostname and check **every** address it resolves to. A name that
   resolves to one public and one private address is refused outright.
3. Return the checked IP so the caller connects to exactly that address (keeping
   the original Host header and TLS name). If the caller resolved the name again,
   an attacker's DNS server could answer differently the second time ("DNS
   rebinding") and slip past the check.

Redirects are not followed, for the same reason: a public URL could redirect to a
private one. That is enforced where the HTTP request is made.

This module does no network I/O itself: the DNS lookup is passed in as a function.
"""

import ipaddress
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from urllib.parse import urlsplit

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

# (hostname, port) -> the IP addresses it resolves to, as strings.
Resolver = Callable[[str, int], Awaitable[Sequence[str]]]

_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_DEFAULT_PORTS = {"http": 80, "https": 443}


class SsrfError(Exception):
    """Base class: the destination was refused."""


class InvalidUrlError(SsrfError):
    """The URL itself is not acceptable (scheme, credentials, port, ...)."""


class BlockedAddressError(SsrfError):
    """The URL points at an address we refuse to connect to."""


class UnresolvableHostError(SsrfError):
    """The hostname did not resolve to any address."""


@dataclass(frozen=True, slots=True)
class Target:
    scheme: str
    host: str  # as written in the URL: used for the Host header and TLS name
    port: int


@dataclass(frozen=True, slots=True)
class ResolvedTarget:
    scheme: str
    host: str
    port: int
    ip: str  # the vetted address to connect to


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """IPv6 forms that are really an IPv4 address in disguise.

    ``::ffff:127.0.0.1`` reaches loopback just as ``127.0.0.1`` does, so the IPv4
    address inside must be checked too.
    """
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip.teredo is not None:
        return ip.teredo[1]
    if ip in _NAT64:
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def _block_reason(ip: IPAddress) -> str | None:
    if ip.is_loopback:
        return "loopback address"
    if ip.is_link_local:
        return "link-local address (includes cloud metadata)"
    if ip.is_multicast:
        return "multicast address"
    if ip.is_unspecified:
        return "unspecified address"
    if ip.is_private:
        return "private network address"
    if ip.is_reserved:
        return "reserved address"
    if not ip.is_global:
        return "not a public address"  # e.g. carrier-grade NAT, 100.64.0.0/10
    return None


@dataclass(frozen=True, slots=True)
class AddressPolicy:
    """Which destination addresses are allowed.

    ``allow_private_networks`` exists for local development and the test suite,
    where the receiver runs on localhost or a private network. It must be off in
    production. Even when it is on, link-local addresses (which include the cloud
    metadata endpoint), multicast and the unspecified address stay blocked.
    """

    allow_private_networks: bool = False

    def _reason(self, ip: IPAddress) -> str | None:
        if not self.allow_private_networks:
            return _block_reason(ip)
        # Development needs loopback and private ranges (a receiver on this
        # machine or on the Docker network). It never needs these:
        if ip.is_link_local:
            return "link-local address (includes cloud metadata)"
        if ip.is_multicast:
            return "multicast address"
        if ip.is_unspecified:
            return "unspecified address"
        return None

    def check(self, address: str | IPAddress) -> IPAddress:
        """Return the parsed address if it is allowed; raise ``BlockedAddressError`` if not."""
        try:
            ip = ipaddress.ip_address(address) if isinstance(address, str) else address
        except ValueError as exc:
            raise BlockedAddressError(f"not an IP address: {address!r}") from exc
        reason = self._reason(ip)
        if reason is None and isinstance(ip, ipaddress.IPv6Address):
            embedded = _embedded_ipv4(ip)
            if embedded is not None:
                reason = self._reason(embedded)
        if reason is not None:
            raise BlockedAddressError(f"{ip} is blocked: {reason}")
        return ip


def parse_target(url: str, *, require_https: bool) -> Target:
    """Validate the URL's shape and pull out scheme, host and port."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise InvalidUrlError("the URL is malformed") from exc

    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS:
        raise InvalidUrlError("the URL must start with http:// or https://")
    if require_https and scheme != "https":
        raise InvalidUrlError("the URL must use https")
    if parts.username is not None or parts.password is not None:
        raise InvalidUrlError("the URL must not contain a username or password")
    host = parts.hostname
    if not host:
        raise InvalidUrlError("the URL has no host")
    if port == 0:
        raise InvalidUrlError("port 0 is not valid")
    return Target(scheme, host, port if port is not None else _DEFAULT_PORTS[scheme])


async def resolve_and_check(
    url: str,
    policy: AddressPolicy,
    resolver: Resolver,
    *,
    require_https: bool,
) -> ResolvedTarget:
    """Validate ``url`` and return the vetted IP address to connect to."""
    target = parse_target(url, require_https=require_https)

    try:
        literal: IPAddress | None = ipaddress.ip_address(target.host)
    except ValueError:
        literal = None

    if literal is not None:
        addresses: Sequence[str] = [str(literal)]
    else:
        addresses = await resolver(target.host, target.port)
        if not addresses:
            raise UnresolvableHostError(f"{target.host} did not resolve to any address")

    # Every address must pass, not just the one we would pick.
    checked = [policy.check(address) for address in addresses]
    return ResolvedTarget(target.scheme, target.host, target.port, str(checked[0]))
