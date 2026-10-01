"""In-process rate limiting: token buckets per external service and politeness delays per host.

These are per worker process. The GLOBAL limit towards a service is therefore
`rate × number of worker processes`; the per-kind concurrency cap in the queue (settings
`source_concurrency`) bounds it independently of how many workers run.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict


class TokenBucket:
    def __init__(self, rate_per_s: float, burst: int = 1) -> None:
        self.rate = max(rate_per_s, 1e-6)
        self.capacity = max(burst, 1)
        self.tokens = float(self.capacity)
        self.updated = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                await asyncio.sleep((1 - self.tokens) / self.rate)


class RateLimiter:
    """Named token buckets, e.g. limiter.acquire("commoncrawl")."""

    def __init__(self, rates: dict[str, float], default_rate: float = 5.0) -> None:
        self._rates = dict(rates)
        self._default = default_rate
        self._buckets: dict[str, TokenBucket] = {}
        self._penalty_until: dict[str, float] = {}

    def set_rate(self, key: str, rate_per_s: float) -> None:
        self._rates[key] = rate_per_s
        self._buckets.pop(key, None)

    async def acquire(self, key: str) -> None:
        until = self._penalty_until.get(key, 0.0)
        now = time.monotonic()
        if until > now:
            await asyncio.sleep(until - now)
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = self._buckets[key] = TokenBucket(self._rates.get(key, self._default))
        await bucket.acquire()

    def penalize(self, key: str, seconds: float) -> None:
        """Pause a service after a 429/503 (Retry-After or our own back-off)."""
        self._penalty_until[key] = max(self._penalty_until.get(key, 0.0), time.monotonic() + seconds)


class HostThrottle:
    """Minimum delay between two requests to the same host (crawl politeness)."""

    def __init__(self, delay_s: float, max_hosts: int = 10_000) -> None:
        self.delay = delay_s
        self._last: OrderedDict[str, float] = OrderedDict()
        self._locks: dict[str, asyncio.Lock] = {}
        self._max_hosts = max_hosts
        self._per_host_delay: dict[str, float] = {}

    def set_delay_for(self, host: str, delay_s: float) -> None:
        # robots.txt Crawl-delay: honoured up to a sane maximum (handled by the caller).
        self._per_host_delay[host] = delay_s

    async def wait(self, host: str) -> None:
        lock = self._locks.setdefault(host, asyncio.Lock())
        async with lock:
            delay = self._per_host_delay.get(host, self.delay)
            last = self._last.get(host)
            if last is not None:
                remaining = last + delay - time.monotonic()
                if remaining > 0:
                    await asyncio.sleep(remaining)
            self._last[host] = time.monotonic()
            self._last.move_to_end(host)
            while len(self._last) > self._max_hosts:
                old, _ = self._last.popitem(last=False)
                self._locks.pop(old, None)
                self._per_host_delay.pop(old, None)
