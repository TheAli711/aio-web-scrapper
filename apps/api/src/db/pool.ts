import pg from "pg";

export type Db = pg.Pool;
export type DbClient = pg.PoolClient | pg.Pool;

export function createPool(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  });
  pool.on("error", () => {
    // Idle client errors are surfaced on next use; avoid crashing the process.
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
