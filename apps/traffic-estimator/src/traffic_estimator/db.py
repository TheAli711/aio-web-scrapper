"""Database access: async SQLAlchemy engine + plain-SQL migrations (same approach as apps/api)."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from .settings import APP_DIR, get_settings

log = logging.getLogger(__name__)

MIGRATIONS_DIR = APP_DIR / "migrations"

_engine: AsyncEngine | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        s = get_settings()
        _engine = create_async_engine(s.database_url, pool_size=10, max_overflow=20, pool_pre_ping=True)
    return _engine


async def dispose_engine() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None


@asynccontextmanager
async def connection() -> AsyncIterator[AsyncConnection]:
    """A connection in a transaction: commits on success, rolls back on error."""
    async with get_engine().begin() as conn:
        yield conn


async def migrate(migrations_dir: Path = MIGRATIONS_DIR) -> list[str]:
    """Apply every `NNN_name.sql` not yet recorded in schema_migrations. Returns the names applied."""
    applied: list[str] = []
    async with get_engine().begin() as conn:
        # Serialise concurrent starters (api + workers may boot at once).
        await conn.execute(text("SELECT pg_advisory_xact_lock(7311001)"))
        await conn.execute(
            text("CREATE TABLE IF NOT EXISTS schema_migrations ( name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        )
        done = {r[0] for r in await conn.execute(text("SELECT name FROM schema_migrations"))}
        for path in sorted(migrations_dir.glob("*.sql")):
            if path.name in done:
                continue
            log.info("applying migration %s", path.name)
            await conn.exec_driver_sql(path.read_text())
            await conn.execute(text("INSERT INTO schema_migrations (name) VALUES (:n)"), {"n": path.name})
            applied.append(path.name)
    return applied


async def ping() -> bool:
    try:
        async with get_engine().connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001
        return False
