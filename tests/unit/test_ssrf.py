import ipaddress
from collections.abc import Sequence

import pytest
from hypothesis import given
from hypothesis import strategies as st

from relay.domain.ssrf import (
    AddressPolicy,
    BlockedAddressError,
    InvalidUrlError,
    ResolvedTarget,
    Resolver,
    UnresolvableHostError,
    parse_target,
    resolve_and_check,
)

policy = AddressPolicy()


def resolves_to(*addresses: str) -> Resolver:
    async def resolver(host: str, port: int) -> Sequence[str]:
        return list(addresses)

    return resolver


async def must_not_resolve(host: str, port: int) -> Sequence[str]:
    raise AssertionError(f"DNS should not have been consulted for {host}")


# ------------------------------------------------------------- blocked ranges
@pytest.mark.parametrize(
    "address",
    [
        # the ranges listed in the design
        "10.0.0.1",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "127.0.0.1",
        "127.255.255.254",
        "169.254.169.254",  # cloud metadata endpoint
        "169.254.0.1",
        "100.64.0.1",  # carrier-grade NAT
        "100.127.255.255",
        "0.0.0.0",  # noqa: S104
        "0.1.2.3",
        "::1",
        "fc00::1",
        "fdff:ffff::1",
        "fe80::1",
        # extra ranges that are just as dangerous
        "::",
        "224.0.0.1",  # multicast
        "ff02::1",
        "255.255.255.255",
        "240.0.0.1",  # reserved
        "192.0.2.1",  # documentation range
        "198.18.0.1",  # benchmarking range
        # IPv4 addresses hiding inside IPv6
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:169.254.169.254",
        "64:ff9b::7f00:1",  # NAT64 form of 127.0.0.1
        "64:ff9b::a9fe:a9fe",  # NAT64 form of 169.254.169.254
        "2002:7f00:1::",  # 6to4 form of 127.0.0.1
        "2002:c0a8:101::",  # 6to4 form of 192.168.1.1
    ],
)
def test_internal_addresses_are_blocked(address: str) -> None:
    with pytest.raises(BlockedAddressError):
        policy.check(address)


@pytest.mark.parametrize(
    "address",
    ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"],
)
def test_public_addresses_are_allowed(address: str) -> None:
    assert str(policy.check(address)) == address


def test_garbage_is_not_an_address() -> None:
    with pytest.raises(BlockedAddressError, match="not an IP address"):
        policy.check("example.com")


def test_development_mode_allows_local_addresses() -> None:
    assert str(AddressPolicy(allow_private_networks=True).check("127.0.0.1")) == "127.0.0.1"


@given(ip=st.ip_addresses(v=4))
def test_every_allowed_ipv4_address_is_public(ip: ipaddress.IPv4Address) -> None:
    try:
        policy.check(ip)
    except BlockedAddressError:
        return
    assert ip.is_global
    assert not ip.is_private
    assert not ip.is_loopback
    assert not ip.is_link_local
    assert not ip.is_multicast


@given(ip=st.ip_addresses(v=4))
def test_wrapping_an_ipv4_address_in_ipv6_never_changes_the_verdict(
    ip: ipaddress.IPv4Address,
) -> None:
    def allowed(address: str) -> bool:
        try:
            policy.check(address)
        except BlockedAddressError:
            return False
        return True

    plain = allowed(str(ip))
    if not plain:
        assert not allowed(f"::ffff:{ip}")
        assert not allowed(str(ipaddress.IPv6Address((0x64FF9B << 96) | int(ip))))
        assert not allowed(str(ipaddress.IPv6Address((0x2002 << 112) | (int(ip) << 80))))


# ---------------------------------------------------------------- URL parsing
def test_parses_scheme_host_and_default_ports() -> None:
    assert parse_target("https://example.com/hooks?x=1", require_https=True).port == 443
    assert parse_target("http://example.com/hooks", require_https=False).port == 80
    assert parse_target("https://Example.COM:8443/h", require_https=True).port == 8443
    assert parse_target("https://Example.COM:8443/h", require_https=True).host == "example.com"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/file",
        "file:///etc/passwd",
        "gopher://example.com/",
        "javascript:alert(1)",
        "//example.com/no-scheme",
        "example.com/no-scheme",
        "",
        "https://",
        "https:///path-only",
        "https://user:pass@example.com/",  # credentials can disguise the real host
        "https://user@example.com/",
        "https://example.com:0/",
        "https://example.com:99999/",
        "https://example.com:port/",
        "https://[not-an-ip]/",
    ],
)
def test_unacceptable_urls_are_rejected(url: str) -> None:
    with pytest.raises(InvalidUrlError):
        parse_target(url, require_https=False)


def test_plain_http_is_rejected_when_https_is_required() -> None:
    with pytest.raises(InvalidUrlError, match="https"):
        parse_target("http://example.com/hooks", require_https=True)


@given(url=st.text(max_size=200))
def test_parsing_arbitrary_text_never_crashes(url: str) -> None:
    try:
        target = parse_target(url, require_https=False)
    except InvalidUrlError:
        return
    assert target.scheme in {"http", "https"}
    assert target.host
    assert 1 <= target.port <= 65535


# ------------------------------------------------------------ resolve and check
async def test_returns_the_vetted_ip_to_connect_to() -> None:
    target = await resolve_and_check(
        "https://hooks.example.com/in", policy, resolves_to("93.184.216.34"), require_https=True
    )

    assert target == ResolvedTarget("https", "hooks.example.com", 443, "93.184.216.34")


async def test_hostname_resolving_to_a_private_ip_is_blocked() -> None:
    with pytest.raises(BlockedAddressError):
        await resolve_and_check(
            "https://innocent.example.com/", policy, resolves_to("10.0.0.5"), require_https=True
        )


async def test_the_metadata_address_is_blocked_without_a_dns_lookup() -> None:
    with pytest.raises(BlockedAddressError):
        await resolve_and_check(
            "http://169.254.169.254/latest/meta-data/",
            policy,
            must_not_resolve,
            require_https=False,
        )


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:7f00:1]/",
        "http://0.0.0.0/",
        "http://192.168.0.1:8080/admin",
    ],
)
async def test_literal_internal_ips_in_urls_are_blocked(url: str) -> None:
    with pytest.raises(BlockedAddressError):
        await resolve_and_check(url, policy, must_not_resolve, require_https=False)


@pytest.mark.parametrize("host", ["localhost", "2130706433", "0x7f000001", "017700000001", "127.1"])
async def test_disguised_loopback_names_are_blocked_once_resolved(host: str) -> None:
    """Hosts like 2130706433 are not IP literals to a URL parser, but the system
    resolver turns them into 127.0.0.1. Checking the resolved address catches them."""
    with pytest.raises(BlockedAddressError):
        await resolve_and_check(
            f"http://{host}/", policy, resolves_to("127.0.0.1"), require_https=False
        )


async def test_one_private_address_among_public_ones_blocks_the_whole_host() -> None:
    """Otherwise an attacker returns both and waits for us to pick the private one."""
    with pytest.raises(BlockedAddressError):
        await resolve_and_check(
            "https://rebind.example.com/",
            policy,
            resolves_to("93.184.216.34", "10.0.0.5"),
            require_https=True,
        )


async def test_a_host_that_resolves_to_nothing_is_refused() -> None:
    with pytest.raises(UnresolvableHostError):
        await resolve_and_check(
            "https://nowhere.example/", policy, resolves_to(), require_https=True
        )


async def test_the_resolver_receives_the_host_and_port_from_the_url() -> None:
    seen: list[tuple[str, int]] = []

    async def resolver(host: str, port: int) -> Sequence[str]:
        seen.append((host, port))
        return ["93.184.216.34"]

    await resolve_and_check(
        "https://hooks.example.com:8443/x", policy, resolver, require_https=True
    )

    assert seen == [("hooks.example.com", 8443)]


async def test_development_mode_reaches_a_local_receiver() -> None:
    target = await resolve_and_check(
        "http://localhost:9000/receiver",
        AddressPolicy(allow_private_networks=True),
        resolves_to("127.0.0.1"),
        require_https=False,
    )

    assert target.ip == "127.0.0.1"
    assert target.port == 9000
