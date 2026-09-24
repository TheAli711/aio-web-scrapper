import { configDefaults, defineConfig } from "vitest/config";

// `npm test` runs unit + integration tests; `npm run test:e2e` (E2E=1) runs only the tests
// that need the full docker compose stack.
const e2e = process.env.E2E === "1";

export default defineConfig({
  test: {
    include: e2e ? ["test/e2e/**/*.test.ts"] : ["test/**/*.test.ts"],
    exclude: e2e ? configDefaults.exclude : [...configDefaults.exclude, "test/e2e/**"],
    // Tests share one Postgres database, so files run one at a time.
    fileParallelism: false,
    testTimeout: e2e ? 240_000 : 20_000,
    hookTimeout: 30_000,
    env: { PASSWORD_HASH_LOG2_N: "12", NODE_ENV: "test" },
  },
});
