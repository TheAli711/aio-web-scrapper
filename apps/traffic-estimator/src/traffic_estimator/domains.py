"""Domain normalisation and validation.

Input can be anything a user pastes: "HTTPS://www.Example.com/path?x=1", "example.com.",
"sub.example.co.uk". Output is the lower-case registrable domain (public-suffix aware), e.g.
"example.com" / "example.co.uk". Subdomains are folded into their registrable domain because every
signal we use (Tranco, web graph, RDAP) is keyed that way.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

import idna
import tldextract

# Bundled public-suffix snapshot only: never fetch at runtime (workers have no direct internet).
# Private PSL entries (github.io, blogspot.com, ...) count as suffixes: "blog.github.io" is its own site.
_extract = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None, fallback_to_snapshot=True, include_psl_private_domains=True)

_LABEL_RE = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")


class InvalidDomain(ValueError):
    pass


@dataclass(frozen=True)
class NormalizedDomain:
    name: str  # registrable domain, lower case, ASCII (punycode for IDN)
    host: str  # the full host that was given (lower case, ASCII), e.g. www.example.com


def normalize_domain(raw: str) -> NormalizedDomain:
    if raw is None:
        raise InvalidDomain("empty")
    s = raw.strip().lower()
    if not s:
        raise InvalidDomain("empty")
    # Strip scheme / path / query / credentials / port.
    if "://" in s:
        s = urlsplit(s).hostname or ""
    else:
        if "/" in s:
            s = s.split("/", 1)[0]
        if "@" in s:
            s = s.rsplit("@", 1)[1]
        if s.startswith("[") or s.count(":") > 1:  # IPv6 literal
            raise InvalidDomain("ip addresses are not domains")
        if ":" in s:
            s = s.split(":", 1)[0]
    s = s.strip().rstrip(".")
    if not s:
        raise InvalidDomain("empty")
    if re.fullmatch(r"[0-9.]+", s):
        raise InvalidDomain("ip addresses are not domains")
    try:
        ascii_host = idna.encode(s, uts46=True).decode("ascii")
    except idna.IDNAError as e:
        raise InvalidDomain(f"invalid international domain: {e}") from e
    if len(ascii_host) > 253:
        raise InvalidDomain("too long")
    labels = ascii_host.split(".")
    if len(labels) < 2:
        raise InvalidDomain("a registrable domain needs at least two labels")
    for label in labels:
        if not _LABEL_RE.fullmatch(label):
            raise InvalidDomain(f"invalid label {label!r}")
    ext = _extract(ascii_host)
    if not ext.suffix:
        raise InvalidDomain("unknown top-level domain")
    if not ext.domain:
        raise InvalidDomain("a public suffix is not a registrable domain")
    registrable = f"{ext.domain}.{ext.suffix}"
    return NormalizedDomain(name=registrable, host=ascii_host)


def registrable_domain(host: str) -> str | None:
    """Registrable domain for an already-clean host, or None if it has no public suffix."""
    ext = _extract(host.lower().rstrip("."))
    if not ext.suffix or not ext.domain:
        return None
    return f"{ext.domain}.{ext.suffix}"


def same_site(host: str, domain: str) -> bool:
    """True when `host` is `domain` or one of its subdomains."""
    host = host.lower().rstrip(".")
    return host == domain or host.endswith("." + domain)


def reverse_domain(name: str) -> str:
    """example.com -> com.example (Common Crawl's notation)."""
    return ".".join(reversed(name.split(".")))


def unreverse_domain(rev: str) -> str:
    return ".".join(reversed(rev.split(".")))
