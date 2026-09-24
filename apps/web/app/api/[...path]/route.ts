/**
 * Same-origin proxy: every /api/* request from the browser is forwarded to the Fastify API at
 * API_INTERNAL_URL (read per request, so it can be changed at container runtime).
 *
 * - Method, query string, body and headers (cookie, origin, content-type, authorization,
 *   x-forwarded-for, sec-fetch-*) are forwarded; `host` and hop-by-hop headers are not.
 * - Request and response bodies are streamed, so large exports/downloads are never buffered.
 * - Status codes and response headers (set-cookie, content-disposition, content-type, CSP ...)
 *   are passed through unchanged; redirects are not followed.
 */
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Never forwarded upstream: the API must see its own host; length/encoding are recomputed.
const DROP_REQUEST = new Set(["host", "content-length", "accept-encoding", "expect"]);
// fetch() transparently decodes compressed bodies, so these would no longer be accurate.
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "set-cookie"]);

function upstreamBase(): string {
  return (process.env.API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/+$/, "");
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message, requestId: `web-${crypto.randomUUID()}` } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function proxy(req: NextRequest): Promise<Response> {
  const base = upstreamBase();
  const target = `${base}${req.nextUrl.pathname}${req.nextUrl.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!HOP_BY_HOP.has(k) && !DROP_REQUEST.has(k)) headers.set(k, value);
  });
  // Ask for an uncompressed response; we stream it through as-is.
  headers.set("accept-encoding", "identity");
  // Next.js has already filled in x-forwarded-for/-host/-proto for the incoming request.

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
      cache: "no-store",
      signal: req.signal,
      // Required by Node's fetch when the request body is a stream.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error(`[api-proxy] ${req.method} ${req.nextUrl.pathname} -> ${base} failed:`, err);
    return errorResponse(
      502,
      "API_UNREACHABLE",
      "The dashboard could not reach the API server. Check that it is running and that API_INTERNAL_URL points to it.",
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!HOP_BY_HOP.has(k) && !DROP_RESPONSE.has(k)) out.set(k, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
  // Keep the length for downloads when the body was not re-encoded (useful for progress bars).
  const len = upstream.headers.get("content-length");
  if (len && !upstream.headers.get("content-encoding")) out.set("content-length", len);

  // Rewrite absolute redirects that point at the internal API so the browser stays on our origin.
  const location = out.get("location");
  if (location && location.startsWith(base)) out.set("location", location.slice(base.length) || "/");

  const noBody = req.method === "HEAD" || upstream.status === 204 || upstream.status === 304;
  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
