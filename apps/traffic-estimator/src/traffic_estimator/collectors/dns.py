"""Collector "dns": DNS records (via DNS-over-HTTPS JSON, so it works through the egress proxy),
infrastructure/provider classification, and RDAP registration data (registry servers resolved from
the IANA bootstrap file; never the rdap.org redirector at scale).

Verified 2026-10-01: Google DoH JSON (dns.google/resolve) and Cloudflare (cloudflare-dns.com) are
free with no key; IANA bootstrap at data.iana.org/rdap/dns.json; many ccTLDs (.de .jp .ru .cn .eu
.it .es ...) have no RDAP in the bootstrap -> rdap.status = "unsupported_tld".
"""

from __future__ import annotations

import ipaddress
import json
import logging
import re
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import quote

from sqlalchemy import text

from ..db import connection
from ..http import fetch
from ..settings import get_settings
from .base import CollectorContext, CollectorResult, Observation

log = logging.getLogger(__name__)

DNS_VERSION = "dns_v1"
RECORD_TYPES = {"A": 1, "AAAA": 28, "MX": 15, "NS": 2, "CNAME": 5, "TXT": 16, "CAA": 257}
TYPE_NAMES = {v: k for k, v in RECORD_TYPES.items()}

# Stealth RDAP servers missing from the IANA bootstrap (checked 2026-10-01).
RDAP_OVERRIDES = {
    "de": "https://rdap.denic.de/",
    "ch": "https://rdap.nic.ch/",
    "li": "https://rdap.nic.ch/",
    "io": "https://rdap.identitydigital.services/rdap/",
    "ai": "https://rdap.identitydigital.services/rdap/",
    "us": "https://rdap.nic.us/",
}

IP_FEEDS = {
    "Cloudflare": ("https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6"),
    "Amazon Web Services": ("https://ip-ranges.amazonaws.com/ip-ranges.json",),
    "Google Cloud": ("https://www.gstatic.com/ipranges/cloud.json",),
    "Fastly": ("https://api.fastly.com/public-ip-list",),
}
IP_FEEDS_TTL = timedelta(days=7)

_NS_PATTERNS: tuple[tuple[str, str, str], ...] = (
    # (regex over nameserver, provider, role)
    (r"\.ns\.cloudflare\.com$", "Cloudflare", "dns"),
    (r"awsdns-", "Amazon Route 53", "dns"),
    (r"googledomains\.com$|google\.com$", "Google Cloud DNS", "dns"),
    (r"azure-dns\.", "Microsoft Azure DNS", "dns"),
    (r"domaincontrol\.com$", "GoDaddy", "dns"),
    (r"registrar-servers\.com$", "Namecheap", "dns"),
    (r"dnsimple\.com$", "DNSimple", "dns"),
    (r"nsone\.net$", "NS1", "dns"),
    (r"ultradns\.", "UltraDNS", "dns"),
    (r"akam\.net$|akamaidns\.", "Akamai", "dns"),
    (r"dynect\.net$", "Dyn", "dns"),
    (r"wixdns\.net$", "Wix", "hosting"),
    (r"squarespacedns\.com$", "Squarespace", "hosting"),
    (r"vercel-dns\.com$", "Vercel", "hosting"),
    (r"digitalocean\.com$", "DigitalOcean", "hosting"),
    (r"ovh\.net$|anycast\.me$", "OVH", "hosting"),
    (r"hetzner\.(com|de)$", "Hetzner", "hosting"),
    (r"ionos\.(com|de)$|ui-dns\.", "IONOS", "hosting"),
    (r"hostinger\.com$", "Hostinger", "hosting"),
    # Hostinger's default nameservers for every domain (parked or live), despite the name.
    (r"dns-parking\.com$", "Hostinger DNS", "dns"),
    (r"sedoparking\.com$", "Sedo parking", "parked"),
    (r"parkingcrew\.net$", "ParkingCrew", "parked"),
    (r"bodis\.com$", "Bodis parking", "parked"),
    (r"above\.com$", "Above.com parking", "parked"),
    (r"afternic\.com$", "Afternic", "parked"),
    (r"dan\.com$", "Dan.com", "parked"),
    (r"hugedomains\.com$", "HugeDomains", "parked"),
    (r"bluehost\.com$", "Bluehost", "hosting"),
    (r"siteground\.net$|sgvps\.net$", "SiteGround", "hosting"),
    (r"wpengine\.com$", "WP Engine", "hosting"),
    (r"kinsta\.cloud$", "Kinsta", "hosting"),
    (r"hostgator\.com$", "HostGator", "hosting"),
    (r"dreamhost\.com$", "DreamHost", "hosting"),
    (r"name-services\.com$|enom\.com$", "Enom", "dns"),
    (r"worldnic\.com$", "Network Solutions", "dns"),
    (r"linode\.com$", "Linode/Akamai", "hosting"),
    (r"shopify", "Shopify", "hosting"),
)
_CNAME_PATTERNS: tuple[tuple[str, str, str], ...] = (
    (r"cname\.vercel-dns\.com$|vercel-dns-\d+\.com$|\.vercel\.app$", "Vercel", "hosting"),
    (r"\.netlify\.(app|com)$", "Netlify", "hosting"),
    (r"\.github\.io$", "GitHub Pages", "hosting"),
    (r"shops\.myshopify\.com$|\.myshopify\.com$", "Shopify", "hosting"),
    (r"ext-cust\.squarespace\.com$|\.squarespace\.com$", "Squarespace", "hosting"),
    (r"\.wixdns\.net$|\.wixsite\.com$", "Wix", "hosting"),
    (r"\.cloudfront\.net$", "Amazon CloudFront", "cdn"),
    (r"\.elb\.amazonaws\.com$|\.amazonaws\.com$", "Amazon Web Services", "hosting"),
    (r"\.herokuapp\.com$|\.herokudns\.com$", "Heroku", "hosting"),
    (r"\.azurewebsites\.net$|\.azureedge\.net$|\.azurefd\.net$|\.trafficmanager\.net$", "Microsoft Azure", "hosting"),
    (r"proxy(-ssl)?\.webflow\.com$|\.webflow\.io$", "Webflow", "hosting"),
    (r"\.hs-sites\.com$|\.hubspot\.net$", "HubSpot", "hosting"),
    (r"\.ghost\.io$", "Ghost(Pro)", "hosting"),
    (r"\.wpengine\.com$", "WP Engine", "hosting"),
    (r"\.kinsta\.cloud$", "Kinsta", "hosting"),
    (r"\.pantheonsite\.io$", "Pantheon", "hosting"),
    (r"\.(edgekey|edgesuite|akamaiedge|akamaized)\.net$", "Akamai", "cdn"),
    (r"\.fastly(lb)?\.net$", "Fastly", "cdn"),
    (r"\.cdn\.cloudflare\.net$", "Cloudflare", "cdn"),
    (r"ghs\.googlehosted\.com$|\.googleusercontent\.com$", "Google Cloud", "hosting"),
    (r"\.bigcommerce\.com$|\.mybigcommerce\.com$", "BigCommerce", "hosting"),
    (r"\.ondigitalocean\.app$", "DigitalOcean", "hosting"),
    (r"\.impervadns\.net$|\.incapdns\.net$", "Imperva", "cdn"),
    (r"\.b-cdn\.net$", "Bunny CDN", "cdn"),
    (r"\.sucuri\.net$", "Sucuri", "cdn"),
    (r"\.gitlab\.io$", "GitLab Pages", "hosting"),
    (r"\.framer\.(app|website)$", "Framer", "hosting"),
    (r"\.duda\.co$|\.multiscreensite\.com$", "Duda", "hosting"),
    (r"\.weebly\.com$", "Weebly", "hosting"),
    (r"\.godaddysites\.com$|\.secureserver\.net$", "GoDaddy", "hosting"),
    (r"\.cloudways\.com$", "Cloudways", "hosting"),
    (r"\.flywheelsites\.com$", "Flywheel", "hosting"),
)
_MX_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\.google\.com$|googlemail\.com$", "Google Workspace"),
    (r"\.outlook\.com$|\.protection\.outlook\.com$", "Microsoft 365"),
    (r"zoho\.", "Zoho Mail"),
    (r"pphosted\.com$|proofpoint", "Proofpoint"),
    (r"mimecast\.", "Mimecast"),
    (r"emailsrvr\.com$", "Rackspace Email"),
    (r"secureserver\.net$", "GoDaddy Email"),
    (r"mail\.protonmail\.ch$|protonmail", "Proton Mail"),
    (r"icloud\.com$", "iCloud Mail"),
    (r"fastmail\.", "Fastmail"),
    (r"yandex\.", "Yandex Mail"),
    (r"mx\.ovh\.net$", "OVH Mail"),
    (r"hostinger\.com$", "Hostinger Mail"),
    (r"barracudanetworks\.com$", "Barracuda"),
    (r"mxrecord\.io$|mailgun", "Mailgun"),
)
_FIXED_IPS: tuple[tuple[str, str, str], ...] = (
    ("76.76.21.21", "Vercel", "hosting"),
    ("216.198.79.1", "Vercel", "hosting"),
    ("75.2.60.5", "Netlify", "hosting"),
    ("185.199.108.0/22", "GitHub Pages", "hosting"),
    ("23.227.38.0/24", "Shopify", "hosting"),
    ("198.185.159.144/31", "Squarespace", "hosting"),
    ("198.49.23.144/31", "Squarespace", "hosting"),
    ("185.230.63.0/24", "Wix", "hosting"),
    ("216.239.32.21/32", "Google Sites", "hosting"),
    ("216.239.34.21/32", "Google Sites", "hosting"),
    ("216.239.36.21/32", "Google Sites", "hosting"),
    ("216.239.38.21/32", "Google Sites", "hosting"),
    ("34.111.0.0/16", "Webflow", "hosting"),
    ("13.248.0.0/14", "Amazon Web Services", "hosting"),
)


# ------------------------------------------------------------------------------------ DoH
async def doh_query(name: str, rtype: str) -> dict[str, Any]:
    s = get_settings()
    url = f"{s.doh_url}?name={quote(name)}&type={rtype}"
    r = await fetch(url, limiter_key="doh", headers={"accept": "application/dns-json"}, max_bytes=200_000, retries=2, backoff_s=2.0)
    if not r.ok:
        return {"error": r.error or f"HTTP {r.status}", "Status": -1}
    try:
        return r.json()
    except ValueError:
        return {"error": "invalid json", "Status": -1}


def _answers(resp: dict[str, Any], rtype: str) -> list[str]:
    want = RECORD_TYPES[rtype]
    out: list[str] = []
    for a in resp.get("Answer") or []:
        if a.get("type") == want:
            data = str(a.get("data", "")).strip()
            if data:
                out.append(data.rstrip(".").lower() if rtype in ("NS", "CNAME", "MX") else data)
    return out


async def resolve_all(domain: str) -> dict[str, Any]:
    records: dict[str, list[str]] = {}
    status: dict[str, int] = {}
    for rtype in ("A", "AAAA", "NS", "MX", "TXT", "CAA"):
        resp = await doh_query(domain, rtype)
        status[rtype] = int(resp.get("Status", -1))
        records[rtype] = _answers(resp, rtype)
        if rtype == "A" and status["A"] == 3:  # NXDOMAIN: nothing else will resolve
            for other in ("AAAA", "NS", "MX", "TXT", "CAA"):
                records[other] = []
                status[other] = 3
            break
    www_cname = await doh_query(f"www.{domain}", "CNAME")
    records["CNAME_www"] = _answers(www_cname, "CNAME")
    www_a = await doh_query(f"www.{domain}", "A")
    records["A_www"] = _answers(www_a, "A")
    # CNAME chain of www, if any (DoH returns the whole chain in Answer).
    chain = [str(a.get("data", "")).rstrip(".").lower() for a in (www_a.get("Answer") or []) if a.get("type") == 5]
    records["CNAME_www_chain"] = chain
    mx_hosts = [m.split()[-1] for m in records.get("MX", []) if m.split()]
    records["MX"] = mx_hosts
    txt = records.get("TXT", [])
    return {
        "records": {k: v[:20] for k, v in records.items()},
        "status": status,
        "nxdomain": status.get("A") == 3,
        "resolves": bool(records.get("A") or records.get("AAAA")),
        "www_resolves": bool(records.get("A_www")),
        "has_mx": bool(mx_hosts),
        "has_spf": any("v=spf1" in t.lower() for t in txt),
        "has_dmarc": False,  # would need _dmarc.<domain>; skipped to save a query
        "txt_count": len(txt),
        "verification_tags": sorted(
            {t.split("=", 1)[0].strip('"').lower() for t in txt if "-site-verification" in t.lower() or "verification=" in t.lower()}
        )[:10],
    }


# ------------------------------------------------------------------------------------ infrastructure
async def ip_ranges() -> dict[str, list[str]]:
    """Provider -> CIDRs, from public feeds, cached in kv_cache."""
    async with connection() as conn:
        row = (await conn.execute(text("SELECT value, fetched_at FROM kv_cache WHERE key = 'dns:ip_ranges'"))).first()
    if row and row[1] > datetime.now(UTC) - IP_FEEDS_TTL:
        return dict(row[0])
    ranges: dict[str, list[str]] = {}
    for provider, urls in IP_FEEDS.items():
        cidrs: list[str] = []
        for url in urls:
            r = await fetch(url, limiter_key="lists", max_bytes=5_000_000, retries=1)
            if not r.ok:
                continue
            body = r.text()
            if url.endswith(".json") or url.endswith("public-ip-list"):
                try:
                    data = json.loads(body)
                except ValueError:
                    continue
                if "prefixes" in data:  # AWS / GCP
                    for p in data.get("prefixes", []) + data.get("ipv6_prefixes", []):
                        c = p.get("ip_prefix") or p.get("ipv4Prefix") or p.get("ipv6Prefix") or p.get("ipv6_prefix")
                        if c:
                            cidrs.append(c)
                else:  # Fastly
                    cidrs.extend(data.get("addresses", []) + data.get("ipv6_addresses", []))
            else:
                cidrs.extend(line.strip() for line in body.splitlines() if line.strip() and "/" in line)
        if cidrs:
            ranges[provider] = cidrs
    if ranges:
        async with connection() as conn:
            await conn.execute(
                text(
                    "INSERT INTO kv_cache (key, value, fetched_at) VALUES ('dns:ip_ranges', CAST(:v AS jsonb), now())"
                    " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()"
                ),
                {"v": json.dumps(ranges)},
            )
        return ranges
    return dict(row[0]) if row else {}


_networks_cache: tuple[dict[str, list[str]], list[tuple[ipaddress._BaseNetwork, str]]] | None = None


def _networks(ranges: dict[str, list[str]]) -> list[tuple[ipaddress._BaseNetwork, str]]:
    global _networks_cache
    if _networks_cache and _networks_cache[0] is ranges:
        return _networks_cache[1]
    nets: list[tuple[ipaddress._BaseNetwork, str]] = []
    for provider, cidrs in ranges.items():
        for c in cidrs:
            try:
                nets.append((ipaddress.ip_network(c, strict=False), provider))
            except ValueError:
                continue
    for c, provider, _role in _FIXED_IPS:
        try:
            nets.append((ipaddress.ip_network(c, strict=False), provider))
        except ValueError:
            continue
    _networks_cache = (ranges, nets)
    return nets


def classify_infra(records: dict[str, list[str]], ranges: dict[str, list[str]]) -> dict[str, Any]:
    providers: dict[str, set[str]] = {"cdn": set(), "hosting": set(), "dns": set(), "parked": set(), "email": set()}
    nets = _networks(ranges)
    ip_providers: set[str] = set()
    for ip in records.get("A", []) + records.get("AAAA", []) + records.get("A_www", []):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        for net, provider in nets:
            if addr.version == net.version and addr in net:
                ip_providers.add(provider)
                break
    for p in ip_providers:
        role = "cdn" if p in ("Cloudflare", "Fastly", "Amazon CloudFront", "Akamai") else "hosting"
        providers[role].add(p)
    for ns in records.get("NS", []):
        for pat, provider, role in _NS_PATTERNS:
            if re.search(pat, ns):
                providers[role].add(provider)
                break
    for cn in records.get("CNAME_www", []) + records.get("CNAME_www_chain", []):
        for pat, provider, role in _CNAME_PATTERNS:
            if re.search(pat, cn):
                providers[role].add(provider)
                break
    for mx in records.get("MX", []):
        for pat, provider in _MX_PATTERNS:
            if re.search(pat, mx):
                providers["email"].add(provider)
                break
    if records.get("MX") and not providers["email"]:
        providers["email"].add("self-hosted/other")
    names = sorted(set().union(*[v for k, v in providers.items() if k != "email"]))
    return {
        "cdn": sorted(providers["cdn"]),
        "hosting": sorted(providers["hosting"]),
        "dns_provider": sorted(providers["dns"]),
        "email_provider": sorted(providers["email"]),
        "parked_provider": sorted(providers["parked"]),
        "providers": names,
        "ip_provider_matches": sorted(ip_providers),
    }


# ------------------------------------------------------------------------------------ RDAP
async def rdap_base_url(tld: str) -> str | None:
    tld = tld.lower()
    if tld in RDAP_OVERRIDES:
        return RDAP_OVERRIDES[tld]
    s = get_settings()
    async with connection() as conn:
        row = (await conn.execute(text("SELECT value, fetched_at FROM kv_cache WHERE key = 'rdap:bootstrap'"))).first()
    data = None
    if row and row[1] > datetime.now(UTC) - timedelta(days=7):
        data = row[0]
    else:
        r = await fetch(s.rdap_bootstrap_url, limiter_key="lists", max_bytes=2_000_000, retries=1)
        if r.ok:
            try:
                data = r.json()
                async with connection() as conn:
                    await conn.execute(
                        text(
                            "INSERT INTO kv_cache (key, value, fetched_at) VALUES ('rdap:bootstrap', CAST(:v AS jsonb), now())"
                            " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()"
                        ),
                        {"v": json.dumps(data)},
                    )
            except ValueError:
                data = None
        if data is None and row:
            data = row[0]
    if not data:
        return None
    for entry in data.get("services", []):
        tlds, urls = entry[0], entry[1]
        if tld in [t.lower() for t in tlds]:
            https = [u for u in urls if u.startswith("https://")]
            return (https or urls)[0]
    return None


def _parse_rdap(doc: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "registration_date": None,
        "expiration_date": None,
        "last_changed": None,
        "registrar": None,
        "registrar_iana_id": None,
    }
    for ev in doc.get("events", []) or []:
        action = (ev.get("eventAction") or "").lower()
        when = ev.get("eventDate")
        if not when:
            continue
        if action == "registration":
            out["registration_date"] = when
        elif action == "expiration":
            out["expiration_date"] = when
        elif action == "last changed":
            out["last_changed"] = when
    for ent in doc.get("entities", []) or []:
        roles = [r.lower() for r in ent.get("roles", [])]
        if "registrar" in roles:
            vcard = ent.get("vcardArray")
            if isinstance(vcard, list) and len(vcard) > 1:
                for item in vcard[1]:
                    if isinstance(item, list) and item and item[0] == "fn" and len(item) > 3:
                        out["registrar"] = str(item[3])[:120]
            for pid in ent.get("publicIds", []) or []:
                if "iana" in (pid.get("type") or "").lower():
                    out["registrar_iana_id"] = str(pid.get("identifier"))
            if not out["registrar"] and ent.get("handle"):
                out["registrar"] = str(ent["handle"])[:120]
    out["statuses"] = [str(s) for s in doc.get("status", []) or []][:15]
    out["nameservers"] = sorted(
        {(ns.get("ldhName") or "").rstrip(".").lower() for ns in doc.get("nameservers", []) or [] if ns.get("ldhName")}
    )[:10]
    out["dnssec"] = bool((doc.get("secureDNS") or {}).get("delegationSigned"))
    reg = out["registration_date"]
    if reg:
        try:
            d = datetime.fromisoformat(reg.replace("Z", "+00:00"))
            out["domain_age_days"] = max(0, (datetime.now(UTC) - d).days)
        except ValueError:
            out["domain_age_days"] = None
    else:
        out["domain_age_days"] = None
    return out


async def rdap_lookup(domain: str) -> dict[str, Any]:
    tld = domain.rsplit(".", 1)[-1]
    base = await rdap_base_url(tld)
    if not base:
        return {"status": "unsupported_tld", "tld": tld}
    url = f"{base.rstrip('/')}/domain/{quote(domain)}"
    r = await fetch(
        url,
        limiter_key="rdap",
        headers={"accept": "application/rdap+json, application/json"},
        max_bytes=1_000_000,
        retries=2,
        backoff_s=10.0,
    )
    if r.status == 404:
        return {"status": "not_found", "server": base}
    if not r.ok:
        return {"status": "error", "server": base, "http_status": r.status, "error": r.error}
    try:
        doc = r.json()
    except ValueError:
        return {"status": "error", "server": base, "error": "invalid json"}
    parsed = _parse_rdap(doc)
    parsed.update({"status": "ok", "server": base})
    return parsed


class DnsCollector:
    name = "dns"
    sources = ("dns",)
    cache_hours = 24 * 14

    async def collect(self, ctx: CollectorContext) -> CollectorResult:
        s = get_settings()
        dns = await resolve_all(ctx.domain)
        if dns["status"].get("A") == -1 and not dns["resolves"]:
            return CollectorResult.failed("DNS-over-HTTPS resolver unavailable")
        try:
            ranges = await ip_ranges()
        except Exception as e:  # noqa: BLE001 - feeds are optional
            log.warning("ip range feeds unavailable: %s", e)
            ranges = {}
        infra = classify_infra(dns["records"], ranges)
        rdap: dict[str, Any] = {"status": "disabled"}
        if s.rdap_enabled and not dns["nxdomain"]:
            rdap = await rdap_lookup(ctx.domain)
        elif dns["nxdomain"] and s.rdap_enabled:
            rdap = await rdap_lookup(ctx.domain)  # tells apart "unregistered" from "registered but no DNS"
        payload = {
            "domain": ctx.domain,
            "dns_version": DNS_VERSION,
            **dns,
            "infra": infra,
            "rdap": rdap,
            "collected_on": date.today().isoformat(),
        }
        return CollectorResult.ok([Observation("dns", payload, DNS_VERSION, records=sum(len(v) for v in dns["records"].values()))])
