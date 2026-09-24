import { describe, expect, it } from "vitest";
import {
  blockedAddressReason,
  checkUrl,
  checkUrlSyntax,
  createPolicyConfig,
  resolvePublicAddresses,
  type Resolver,
} from "./index.js";

const cfg = createPolicyConfig();
const fakeResolver =
  (map: Record<string, string[]>): Resolver =>
  async (host) => {
    const r = map[host];
    if (!r) throw new Error("ENOTFOUND");
    return r;
  };

describe("blockedAddressReason", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "ff02::1",
  ])("blocks %s", (ip) => {
    expect(blockedAddressReason(ip)).not.toBeNull();
  });

  it.each(["93.184.215.14", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:1.1.1.1"])(
    "allows %s",
    (ip) => {
      expect(blockedAddressReason(ip)).toBeNull();
    },
  );
});

describe("checkUrlSyntax", () => {
  it("accepts a normal https URL", () => {
    const r = checkUrlSyntax("https://example.com/path?q=1", cfg);
    expect(r.ok).toBe(true);
  });

  it.each([
    ["", "INVALID_URL"],
    ["not a url", "INVALID_URL"],
    ["ftp://example.com/", "UNSUPPORTED_URL"],
    ["file:///etc/passwd", "UNSUPPORTED_URL"],
    ["javascript:alert(1)", "UNSUPPORTED_URL"],
    ["gopher://example.com", "UNSUPPORTED_URL"],
    ["https://user:pass@example.com", "UNSUPPORTED_URL"],
    ["http://localhost/", "BLOCKED_URL"],
    ["http://foo.localhost/", "BLOCKED_URL"],
    ["http://127.0.0.1/", "BLOCKED_URL"],
    ["http://2130706433/", "BLOCKED_URL"], // decimal form of 127.0.0.1
    ["http://0x7f.0.0.1/", "BLOCKED_URL"], // hex form
    ["http://0177.0.0.1/", "BLOCKED_URL"], // octal form
    ["http://[::1]/", "BLOCKED_URL"],
    ["http://[::ffff:7f00:1]/", "BLOCKED_URL"],
    ["http://169.254.169.254/latest/meta-data/", "BLOCKED_URL"],
    ["http://metadata.google.internal/computeMetadata/v1/", "BLOCKED_URL"],
    ["http://redis:6379/", "BLOCKED_URL"],
    ["http://nuq-postgres/", "BLOCKED_URL"],
    ["http://example.com:6379/", "BLOCKED_URL"],
    ["http://printer.local/", "BLOCKED_URL"],
  ])("rejects %s with %s", (url, code) => {
    const r = checkUrlSyntax(url, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it("honours an explicit trusted host allowlist", () => {
    const trusted = createPolicyConfig({ allowHosts: "testsite" });
    expect(checkUrlSyntax("http://testsite/", trusted).ok).toBe(true);
    expect(checkUrlSyntax("http://testsite:9999/", trusted).ok).toBe(true);
    expect(checkUrlSyntax("http://other/", trusted).ok).toBe(false);
  });
});

describe("resolvePublicAddresses / checkUrl", () => {
  it("rejects public-looking names that resolve to private addresses (DNS rebinding style)", async () => {
    const r = await checkUrl("https://evil.example/", cfg, fakeResolver({ "evil.example": ["10.0.0.5"] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("BLOCKED_URL");
  });

  it("rejects when ANY resolved address is private", async () => {
    const r = await resolvePublicAddresses(
      "mixed.example",
      cfg,
      fakeResolver({ "mixed.example": ["93.184.215.14", "127.0.0.1"] }),
    );
    expect(r.ok).toBe(false);
  });

  it("reports DNS failures distinctly", async () => {
    const r = await checkUrl("https://nx.example/", cfg, fakeResolver({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("DNS_RESOLUTION_FAILED");
  });

  it("accepts public resolutions", async () => {
    const r = await checkUrl("https://example.com/", cfg, fakeResolver({ "example.com": ["93.184.215.14"] }));
    expect(r.ok).toBe(true);
  });
});
