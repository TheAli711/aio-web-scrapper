/**
 * Create a user from the command line (useful when ALLOW_SIGNUP=false).
 *   npm run user:create -- --email you@example.com --password '...' [--name "You"]
 * If --password is omitted, a random one is generated and printed once.
 */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.js";
import { createPool, withTransaction } from "../db/pool.js";
import { projects, users } from "../db/repos.js";
import { hashPassword } from "../lib/crypto.js";

const { values } = parseArgs({
  options: { email: { type: "string" }, password: { type: "string" }, name: { type: "string" } },
});
if (!values.email) {
  console.error("usage: npm run user:create -- --email <email> [--password <password>] [--name <name>]");
  process.exit(2);
}
const password = values.password ?? randomBytes(12).toString("base64url");
if (password.length < 10) {
  console.error("password must be at least 10 characters");
  process.exit(2);
}
const db = createPool(loadConfig().databaseUrl);
try {
  if (await users.findByEmail(db, values.email)) {
    console.error(`user ${values.email} already exists`);
    process.exit(1);
  }
  const hash = await hashPassword(password);
  const user = await withTransaction(db, async (tx) => {
    const u = await users.create(tx, values.email!, hash, values.name ?? null);
    await projects.create(tx, u.id, "Default project", "Created automatically");
    return u;
  });
  console.log(`created user ${user.email} (${user.id})`);
  if (!values.password) console.log(`generated password: ${password}`);
} finally {
  await db.end();
}
