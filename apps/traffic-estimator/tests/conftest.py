"""Test setup. DB-backed tests need the compose Postgres: `docker compose up -d traffic-db`.
They use a separate database (traffic_test) created on demand; set TE_TEST_DATABASE_URL to override."""

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

import psycopg
import pytest

TEST_DB_URL = os.environ.get("TE_TEST_DATABASE_URL", "postgresql+psycopg://traffic:traffic@localhost:5434/traffic_test")
os.environ["TE_DATABASE_URL"] = TEST_DB_URL
os.environ["TE_DATA_DIR"] = tempfile.mkdtemp(prefix="te-test-")
os.environ["TE_HTTP_PROXY"] = ""
os.environ["TE_MIGRATE_ON_START"] = "false"
os.environ["TE_REPROCESS_AFTER_HOURS"] = "0"

from traffic_estimator import db  # noqa: E402
from traffic_estimator.settings import get_settings  # noqa: E402

TABLES = [
    "estimates",
    "domain_features",
    "training_examples",
    "collection_runs",
    "raw_observations",
    "tasks",
    "pipeline_runs",
    "domains",
    "ranked_list_entries",
    "ranked_lists",
    "kv_cache",
]


def _ensure_database() -> bool:
    url = TEST_DB_URL.replace("postgresql+psycopg://", "postgresql://", 1)
    base, _, dbname = url.rpartition("/")
    try:
        with psycopg.connect(f"{base}/postgres", autocommit=True, connect_timeout=3) as conn:
            exists = conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (dbname,)).fetchone()
            if not exists:
                conn.execute(f'CREATE DATABASE "{dbname}"')
        return True
    except psycopg.OperationalError:
        return False


DB_AVAILABLE = _ensure_database()
needs_db = pytest.mark.skipif(not DB_AVAILABLE, reason="Postgres not reachable (docker compose up -d traffic-db)")


@pytest.fixture(scope="session")
def event_loop_policy():
    return asyncio.DefaultEventLoopPolicy()


@pytest.fixture(scope="session", autouse=True)
def _migrated():
    if DB_AVAILABLE:
        asyncio.run(db.migrate())
        asyncio.run(db.dispose_engine())
    yield


@pytest.fixture
async def clean_db():
    if not DB_AVAILABLE:
        pytest.skip("no database")
    async with db.connection() as conn:
        from sqlalchemy import text

        await conn.execute(text("TRUNCATE " + ", ".join(TABLES) + " RESTART IDENTITY CASCADE"))
    yield
    await db.dispose_engine()


@pytest.fixture
def settings():
    return get_settings()


@pytest.fixture
def fixtures_dir() -> Path:
    return Path(__file__).parent / "fixtures"
