import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";
import { createPool } from "../db/pool.js";

const db = createPool(loadConfig().databaseUrl);
const applied = await migrate(db, (m) => console.log(m));
console.log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
await db.end();
