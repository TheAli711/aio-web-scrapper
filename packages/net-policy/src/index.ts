/**
 * Shared SSRF / egress policy.
 *
 * Used in two places:
 *  1. apps/api        – pre-flight check before a job is accepted (fast, user-facing error).
 *  2. apps/egress-proxy – enforcement at connect time for every request the engine makes
 *                         (redirects, crawl-discovered links, sub-resources, DNS rebinding).
 *
 * The pre-flight check alone is NOT a security boundary; the egress proxy is.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

export type PolicyErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_URL"
  | "BLOCKED_URL"
  | "DNS_RESOLUTION_FAILED";

export type PolicyResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? {} : { value: T }))
  | { ok: false; code: PolicyErrorCode; reason: string };

export interface NetPolicyConfig {
  /** Exact hostnames (lower-case) explicitly trusted, bypassing host/IP checks. Empty by default. */
  allowHosts: ReadonlySet<string>;
  /** Ports that may be targeted. Undefined = default ports only. */
  allowedPorts: ReadonlySet<number>;
  maxUrlLength: number;
}

export const DEFAULT_ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);

export function createPolicyConfig(opts: {
  allowHosts?: string | string[];
  allowedPorts?: string | number[];
  maxUrlLength?: number;
} = {}): NetPolicyConfig {
  const hosts = Array.isArray(opts.allowHosts)
    ? opts.allowHosts
    : (opts.allowHosts ?? "").split(",");
  const ports = Array.isArray(opts.allowedPorts)
    ? opts.allowedPorts
    : (opts.allowedPorts ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map(Number);
  return {
    allowHosts: new Set(hosts.map((h) => normalizeHostname(h)).filter(Boolean)),
    allowedPorts: ports.length ? new Set(ports.filter((p) => Number.isInteger(p) && p > 0 && p < 65536)) : DEFAULT_ALLOWED_PORTS,
    maxUrlLength: opts.maxUrlLength ?? 2048,
  };
}

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

// IANA IPv4 special-purpose registry + common internal ranges. Anything listed here is denied.
const BLOCKED_V4: Array<[string, string]> = [
  ["0.0.0.0/8", "this-network"],
  ["10.0.0.0/8", "private"],
  ["100.64.0.0/10", "carrier-grade-nat"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local / cloud metadata"],
  ["172.16.0.0/12", "private"],
  ["192.0.0.0/24", "ietf-protocol-assignments"],
  ["192.0.2.0/24", "documentation"],
  ["192.31.196.0/24", "as112"],
  ["192.52.193.0/24", "amt"],
  ["192.88.99.0/24", "6to4-relay"],
  ["192.168.0.0/16", "private"],
  ["192.175.48.0/24", "as112"],
  ["198.18.0.0/15", "benchmarking"],
  ["198.51.100.0/24", "documentation"],
  ["203.0.113.0/24", "documentation"],
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "reserved"],
  ["255.255.255.255/32", "broadcast"],
];

// IPv6: only global unicast (2000::/3) is allowed, minus the special ranges below.
const V6_GLOBAL_UNICAST = ipaddr.parseCIDR("2000::/3");
const BLOCKED_V6: Array<[string, string]> = [
  ["2001::/23", "ietf-protocol-assignments (incl. teredo)"],
  ["2001:db8::/32", "documentation"],
  ["2002::/16", "6to4"],
  ["3fff::/20", "documentation"],
];

const parsedV4 = BLOCKED_V4.map(([cidr, why]) => [ipaddr.IPv4.parseCIDR(cidr), why] as const);
const parsedV6 = BLOCKED_V6.map(([cidr, why]) => [ipaddr.IPv6.parseCIDR(cidr), why] as const);

/** Returns null when the address is a public, routable unicast address; otherwise a reason. */
export function blockedAddressReason(ip: string): string | null {
  if (!ipaddr.isValid(ip)) return "not an IP address";
  let addr = ipaddr.parse(ip);

  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    // Unwrap addresses that embed an IPv4 destination.
    if (v6.isIPv4MappedAddress()) {
      addr = v6.toIPv4Address();
    } else {
      const nat64 = ipaddr.IPv6.parseCIDR("64:ff9b::/96");
      if (v6.match(nat64)) {
        const b = v6.toByteArray();
        addr = new ipaddr.IPv4(b.slice(12, 16) as [number, number, number, number]);
      } else {
        if (!v6.match(V6_GLOBAL_UNICAST as [ipaddr.IPv6, number])) {
          return `ipv6 ${v6.range()}`;
        }
        for (const [cidr, why] of parsedV6) {
          if (v6.match(cidr)) return `ipv6 ${why}`;
        }
        return null;
      }
    }
  }

  const v4 = addr as ipaddr.IPv4;
  for (const [cidr, why] of parsedV4) {
    if (v4.match(cidr)) return why;
  }
  return null;
}

export function isIpLiteral(host: string): boolean {
  return ipaddr.isValid(stripBrackets(host));
}

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".home.arpa",
  ".corp",
  ".svc",
  ".cluster.local",
];
const BLOCKED_NAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

export function normalizeHostname(host: string): string {
  return stripBrackets(host.trim().toLowerCase()).replace(/\.+$/, "");
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Name-based checks only. IP literals and DNS results are checked separately. */
export function blockedHostnameReason(host: string): string | null {
  const h = normalizeHostname(host);
  if (!h) return "empty hostname";
  if (BLOCKED_NAMES.has(h)) return "internal hostname";
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return "internal domain suffix";
  // Single-label names resolve via search domains / container DNS (e.g. "redis", "api").
  if (!h.includes(".")) return "single-label hostname";
  return null;
}

// ---------------------------------------------------------------------------
// URL checks
// ---------------------------------------------------------------------------

export interface CheckedUrl {
  url: URL;
  hostname: string;
  port: number;
  trusted: boolean;
}

/** Syntactic + static checks. Does not touch the network. */
export function checkUrlSyntax(raw: string, cfg: NetPolicyConfig): PolicyResult<CheckedUrl> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, code: "INVALID_URL", reason: "URL is empty" };
  }
  if (raw.length > cfg.maxUrlLength) {
    return { ok: false, code: "INVALID_URL", reason: `URL exceeds ${cfg.maxUrlLength} characters` };
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: "INVALID_URL", reason: "URL could not be parsed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "UNSUPPORTED_URL", reason: `Scheme "${url.protocol.replace(":", "")}" is not supported; use http or https` };
  }
  if (url.username || url.password) {
    return { ok: false, code: "UNSUPPORTED_URL", reason: "URLs with embedded credentials are not supported" };
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return { ok: false, code: "INVALID_URL", reason: "URL has no host" };

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const trusted = cfg.allowHosts.has(hostname);

  if (!trusted && !cfg.allowedPorts.has(port)) {
    return { ok: false, code: "BLOCKED_URL", reason: `Port ${port} is not allowed` };
  }

  if (!trusted) {
    if (isIpLiteral(hostname)) {
      const why = blockedAddressReason(hostname);
      if (why) return { ok: false, code: "BLOCKED_URL", reason: `Target address is not publicly routable (${why})` };
    } else {
      const why = blockedHostnameReason(hostname);
      if (why) return { ok: false, code: "BLOCKED_URL", reason: `Target host is not allowed (${why})` };
    }
  }

  return { ok: true, value: { url, hostname, port, trusted } };
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const results = await dnsLookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
};

/**
 * Resolve a hostname and require that EVERY returned address is public.
 * Returns the vetted addresses so callers can connect to them directly (prevents DNS rebinding
 * between check and connect).
 */
export async function resolvePublicAddresses(
  hostname: string,
  cfg: NetPolicyConfig,
  resolver: Resolver = systemResolver,
  timeoutMs = 5000,
): Promise<PolicyResult<string[]>> {
  const host = normalizeHostname(hostname);
  const trusted = cfg.allowHosts.has(host);

  if (isIpLiteral(host)) {
    if (!trusted) {
      const why = blockedAddressReason(host);
      if (why) return { ok: false, code: "BLOCKED_URL", reason: `Target address is not publicly routable (${why})` };
    }
    return { ok: true, value: [host] };
  }
  if (!trusted) {
    const why = blockedHostnameReason(host);
    if (why) return { ok: false, code: "BLOCKED_URL", reason: `Target host is not allowed (${why})` };
  }

  let addresses: string[];
  try {
    addresses = await withTimeout(resolver(host), timeoutMs);
  } catch {
    return { ok: false, code: "DNS_RESOLUTION_FAILED", reason: `Could not resolve host "${host}"` };
  }
  if (addresses.length === 0) {
    return { ok: false, code: "DNS_RESOLUTION_FAILED", reason: `Host "${host}" has no addresses` };
  }
  if (!trusted) {
    for (const a of addresses) {
      const why = blockedAddressReason(a);
      if (why) {
        return { ok: false, code: "BLOCKED_URL", reason: `Host resolves to a non-public address (${why})` };
      }
    }
  }
  return { ok: true, value: addresses };
}

/** Full pre-flight check: syntax + DNS. */
export async function checkUrl(
  raw: string,
  cfg: NetPolicyConfig,
  resolver: Resolver = systemResolver,
): Promise<PolicyResult<CheckedUrl>> {
  const syn = checkUrlSyntax(raw, cfg);
  if (!syn.ok) return syn;
  const res = await resolvePublicAddresses(syn.value.hostname, cfg, resolver);
  if (!res.ok) return res;
  return syn;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
