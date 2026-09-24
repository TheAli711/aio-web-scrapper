/**
 * Egress proxy: the SSRF enforcement point for the scraping engine.
 *
 * Firecrawl's workers and Playwright service run on a Docker network with no route to the
 * internet (see infra/firecrawl.override.yml). The only way out is this proxy, which:
 *   - resolves the destination itself,
 *   - rejects the connection if ANY resolved address is non-public (private, loopback,
 *     link-local / cloud metadata, CGNAT, multicast, reserved, ULA, ...),
 *   - connects to the vetted IP (no second resolution => no DNS rebinding window),
 *   - restricts destination ports.
 * Every hop (redirects, crawl-discovered links, page sub-resources) goes through here, so
 * validating only the user-submitted URL string is never the sole protection.
 */
import http from "node:http";
import net from "node:net";
import { createPolicyConfig, resolvePublicAddresses, normalizeHostname } from "@ws/net-policy";

const PORT = Number(process.env.PORT ?? 3128);
const USERNAME = process.env.PROXY_USERNAME ?? "";
const PASSWORD = process.env.PROXY_PASSWORD ?? "";
const CONNECT_TIMEOUT_MS = Number(process.env.EGRESS_CONNECT_TIMEOUT_MS ?? 10_000);
const IDLE_TIMEOUT_MS = Number(process.env.EGRESS_IDLE_TIMEOUT_MS ?? 120_000);
const MAX_TUNNELS = Number(process.env.EGRESS_MAX_TUNNELS ?? 2000);

const policy = createPolicyConfig({
  allowHosts: process.env.EGRESS_ALLOW_HOSTS ?? "",
  allowedPorts: process.env.EGRESS_ALLOWED_PORTS ?? "",
});

const counters = {
  allowed: 0,
  blocked: 0,
  dns_failed: 0,
  upstream_errors: 0,
  auth_failed: 0,
  active_tunnels: 0,
};

function log(fields: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service: "egress-proxy", ...fields }) + "\n");
}

function authorized(req: http.IncomingMessage): boolean {
  if (!USERNAME) return true;
  const header = req.headers["proxy-authorization"];
  if (!header || !header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const u = decoded.slice(0, idx);
  const p = decoded.slice(idx + 1);
  return safeEqual(u, USERNAME) && safeEqual(p, PASSWORD);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

type Decision = { ok: true; addresses: string[] } | { ok: false; status: number; code: string; reason: string };

async function decide(hostname: string, port: number): Promise<Decision> {
  const host = normalizeHostname(hostname);
  const trusted = policy.allowHosts.has(host);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, status: 400, code: "INVALID_URL", reason: "invalid port" };
  }
  if (!trusted && !policy.allowedPorts.has(port)) {
    return { ok: false, status: 403, code: "BLOCKED_URL", reason: `port ${port} not allowed` };
  }
  const r = await resolvePublicAddresses(host, policy);
  if (!r.ok) {
    return { ok: false, status: r.code === "DNS_RESOLUTION_FAILED" ? 502 : 403, code: r.code, reason: r.reason };
  }
  return { ok: true, addresses: r.value };
}

function record(decision: Decision, fields: Record<string, unknown>) {
  if (decision.ok) {
    counters.allowed++;
    return;
  }
  if (decision.code === "DNS_RESOLUTION_FAILED") counters.dns_failed++;
  else counters.blocked++;
  log({ level: "warn", event: "egress_denied", code: decision.code, reason: decision.reason, ...fields });
}

/** Connect to the first reachable vetted address. */
function connectVetted(addresses: string[], port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const attempt = () => {
      const address = addresses[i++];
      if (!address) return reject(new Error("all addresses failed"));
      const sock = net.connect({ host: address, port });
      const timer = setTimeout(() => sock.destroy(new Error("connect timeout")), CONNECT_TIMEOUT_MS);
      sock.once("connect", () => {
        clearTimeout(timer);
        sock.removeAllListeners("error");
        resolve(sock);
      });
      sock.once("error", () => {
        clearTimeout(timer);
        attempt();
      });
    };
    attempt();
  });
}

const server = http.createServer(async (req, res) => {
  // Direct (non-proxy) requests: health + metrics only.
  if (req.url?.startsWith("/")) {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/metrics") {
      const body = Object.entries(counters)
        .map(([k, v]) => `egress_${k}${k === "active_tunnels" ? "" : "_total"} ${v}`)
        .join("\n");
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(body + "\n");
      return;
    }
    res.writeHead(404).end();
    return;
  }

  if (!authorized(req)) {
    counters.auth_failed++;
    res.writeHead(407, { "proxy-authenticate": 'Basic realm="egress"' }).end();
    return;
  }

  let target: URL;
  try {
    target = new URL(req.url ?? "");
  } catch {
    res.writeHead(400).end("invalid proxy request");
    return;
  }
  if (target.protocol !== "http:") {
    res.writeHead(400).end("only http:// may be forwarded; use CONNECT for https");
    return;
  }
  const port = target.port ? Number(target.port) : 80;
  const decision = await decide(target.hostname, port);
  record(decision, { method: req.method, host: target.hostname, port });
  if (!decision.ok) {
    res
      .writeHead(decision.status, { "content-type": "text/plain", "x-egress-denied": decision.code })
      .end(`egress denied: ${decision.reason}\n`);
    return;
  }

  const headers = { ...req.headers };
  for (const h of ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "te", "trailer", "upgrade"]) {
    delete headers[h];
  }
  headers.host = target.host;

  // Connect to the vetted IP; the Host header carries the original name.
  const upstream = http.request({
    host: decision.addresses[0],
    port,
    method: req.method,
    path: target.pathname + target.search,
    headers,
    timeout: IDLE_TIMEOUT_MS,
  });
  upstream.on("response", (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => {
    counters.upstream_errors++;
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${err.message}\n`);
  });
  req.pipe(upstream);
});

server.on("connect", async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
  client.on("error", () => client.destroy());
  if (!authorized(req)) {
    counters.auth_failed++;
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="egress"\r\n\r\n');
    return;
  }
  if (counters.active_tunnels >= MAX_TUNNELS) {
    client.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }
  const [rawHost, rawPort] = splitHostPort(req.url ?? "");
  const port = Number(rawPort ?? 443);
  const decision = await decide(rawHost, port);
  record(decision, { method: "CONNECT", host: rawHost, port });
  if (!decision.ok) {
    client.end(
      `HTTP/1.1 ${decision.status} Egress Denied\r\nX-Egress-Denied: ${decision.code}\r\nContent-Type: text/plain\r\n\r\negress denied: ${decision.reason}\n`,
    );
    return;
  }

  let upstream: net.Socket;
  try {
    upstream = await connectVetted(decision.addresses, port);
  } catch {
    counters.upstream_errors++;
    client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }
  counters.active_tunnels++;
  upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
  client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
  const done = () => {
    counters.active_tunnels = Math.max(0, counters.active_tunnels - 1);
  };
  upstream.once("close", done);
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length) upstream.write(head);
  upstream.pipe(client);
  client.pipe(upstream);
});

function splitHostPort(authority: string): [string, string | undefined] {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return [authority.slice(1, end), authority.slice(end + 2) || undefined];
  }
  const idx = authority.lastIndexOf(":");
  return idx === -1 ? [authority, undefined] : [authority.slice(0, idx), authority.slice(idx + 1)];
}

server.listen(PORT, "0.0.0.0", () => {
  log({
    level: "info",
    event: "listening",
    port: PORT,
    auth: Boolean(USERNAME),
    allowedPorts: [...policy.allowedPorts],
    trustedHosts: [...policy.allowHosts],
  });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
