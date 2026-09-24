import path from "node:path";
import type { NextConfig } from "next";

// npm workspaces hoist dependencies to the repo root, so trace (and resolve) from there.
const repoRoot = path.join(__dirname, "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  poweredByHeader: false,
  reactStrictMode: true,
  // Don't let `next dev` write AGENTS.md / CLAUDE.md into the app directory.
  agentRules: false,
  // No rewrites: /api/* is proxied at request time by app/api/[...path]/route.ts so that
  // API_INTERNAL_URL is read at runtime (rewrites are baked in at build time for standalone).
};

export default nextConfig;
