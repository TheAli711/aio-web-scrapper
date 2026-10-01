"""Shared outbound HTTP: one httpx client per process, proxy-aware, size-capped, retrying politely.

Every request leaves through `settings.http_proxy` when set (compose: egress-proxy, the SSRF policy
point shared with the scraping engine). 429/503/504 are retried with back-off honouring Retry-After;
the calling collector's rate-limit key is penalised so sibling tasks slow down too.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from .ratelimit import RateLimiter
from .settings import get_settings

log = logging.getLogger(__name__)

RETRY_STATUSES = {429, 502, 503, 504}


@dataclass
class FetchResult:
    url: str
    final_url: str
    status: int | None
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    error: str | None = None
    elapsed_ms: int = 0
    truncated: bool = False
    attempts: int = 1

    @property
    def ok(self) -> bool:
        return self.error is None and self.status is not None and 200 <= self.status < 300

    def text(self, fallback: str = "utf-8") -> str:
        enc = None
        ctype = self.headers.get("content-type", "")
        if "charset=" in ctype:
            enc = ctype.split("charset=", 1)[1].split(";")[0].strip().strip('"')
        for candidate in (enc, fallback, "latin-1"):
            if not candidate:
                continue
            try:
                return self.body.decode(candidate)
            except (LookupError, UnicodeDecodeError):
                continue
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        import json

        return json.loads(self.body)


_client: httpx.AsyncClient | None = None
_limiter: RateLimiter | None = None


def get_limiter() -> RateLimiter:
    global _limiter
    if _limiter is None:
        _limiter = RateLimiter(get_settings().source_rate_per_s)
    return _limiter


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        s = get_settings()
        proxy = None
        if s.http_proxy:
            u = httpx.URL(s.http_proxy)
            if s.http_proxy_username:
                u = u.copy_with(username=s.http_proxy_username, password=s.http_proxy_password)
            proxy = httpx.Proxy(u)
        _client = httpx.AsyncClient(
            proxy=proxy,
            headers={"user-agent": s.user_agent, "accept": "*/*", "accept-encoding": "gzip, deflate"},
            timeout=httpx.Timeout(s.http_timeout_s, connect=min(10.0, s.http_timeout_s)),
            limits=httpx.Limits(max_connections=s.http_max_connections, max_keepalive_connections=20),
            follow_redirects=False,
            trust_env=False,
        )
    return _client


async def close_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


def _retry_after_seconds(headers: httpx.Headers, default: float) -> float:
    ra = headers.get("retry-after")
    if not ra:
        return default
    ra = ra.strip()
    if ra.isdigit():
        return min(float(ra), 600.0)
    try:
        dt = parsedate_to_datetime(ra)
        return max(0.0, min((dt.timestamp() - time.time()), 600.0))
    except (TypeError, ValueError):
        return default


async def fetch(
    url: str,
    *,
    limiter_key: str | None = None,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    max_bytes: int = 5_000_000,
    max_redirects: int = 5,
    retries: int = 2,
    backoff_s: float = 5.0,
    timeout_s: float | None = None,
    content: bytes | None = None,
) -> FetchResult:
    """Fetch with redirects, a body size cap, and polite retries. Never raises for HTTP/network errors."""
    client = get_client()
    limiter = get_limiter()
    started = time.monotonic()
    current = url
    attempts = 0
    last: FetchResult | None = None
    redirects = 0
    while True:
        attempts += 1
        if limiter_key:
            await limiter.acquire(limiter_key)
        try:
            timeout = httpx.Timeout(timeout_s) if timeout_s else client.timeout
            async with client.stream(method, current, headers=headers, content=content, timeout=timeout) as resp:
                if resp.is_redirect and redirects < max_redirects and resp.headers.get("location"):
                    redirects += 1
                    nxt = str(resp.url.join(resp.headers["location"]))
                    await resp.aclose()
                    current = nxt
                    attempts -= 1
                    continue
                chunks: list[bytes] = []
                size = 0
                truncated = False
                async for chunk in resp.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        chunks.append(chunk[: max(0, max_bytes - (size - len(chunk)))])
                        truncated = True
                        break
                    chunks.append(chunk)
                last = FetchResult(
                    url=url,
                    final_url=str(resp.url),
                    status=resp.status_code,
                    headers={k.lower(): v for k, v in resp.headers.items()},
                    body=b"".join(chunks),
                    elapsed_ms=int((time.monotonic() - started) * 1000),
                    truncated=truncated,
                    attempts=attempts,
                )
        except httpx.HTTPError as e:
            last = FetchResult(
                url=url,
                final_url=current,
                status=None,
                error=f"{type(e).__name__}: {e}"[:300],
                elapsed_ms=int((time.monotonic() - started) * 1000),
                attempts=attempts,
            )
        except Exception as e:  # noqa: BLE001 - e.g. proxy refused, invalid URL
            last = FetchResult(
                url=url,
                final_url=current,
                status=None,
                error=f"{type(e).__name__}: {e}"[:300],
                elapsed_ms=int((time.monotonic() - started) * 1000),
                attempts=attempts,
            )
        retryable = last.status in RETRY_STATUSES or (last.status is None and "Timeout" in (last.error or ""))
        if not retryable or attempts > retries:
            return last
        delay = backoff_s * attempts
        if last.status in (429, 503):
            delay = max(delay, _retry_after_seconds(httpx.Headers(last.headers), delay))
        if limiter_key:
            limiter.penalize(limiter_key, delay)
        log.info("retrying %s after %s (status=%s) in %.0fs", current, limiter_key, last.status, delay)
        await asyncio.sleep(delay)
