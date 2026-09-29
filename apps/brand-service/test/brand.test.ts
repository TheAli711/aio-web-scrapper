import { describe, expect, it } from "vitest";
import { inferSiteName } from "../src/brand.js";

describe("inferSiteName", () => {
  const title = "Online Shopping In Pakistan | buy electronics online | SHOPHIVE";

  it("uses a title segment or logo alt that spells the domain, preferring mixed case", () => {
    expect(inferSiteName(title, "https://www.shophive.com/", [])).toBe("SHOPHIVE");
    expect(inferSiteName(title, "https://www.shophive.com/", ["Shophive!"])).toBe("Shophive");
    expect(inferSiteName("Home - Acme Tools", "https://acme-tools.co.uk/", [])).toBe("Acme Tools");
    expect(inferSiteName("Shophive.com: deals", "https://shophive.com/", [null])).toBe("Shophive.com");
    expect(inferSiteName("Welcome", "https://example.org/", ["Example logo"])).toBe("Example");
  });

  it("does not guess from names that only resemble the domain or from subdomain labels", () => {
    expect(inferSiteName("Online Shopping In Pakistan | buy electronics online", "https://www.shophive.com/", ["Shop"])).toBeNull();
    expect(inferSiteName("Shop | Deals", "https://shop.example.com/", [])).toBeNull();
    expect(inferSiteName("Shophive Store", "https://shophive.com/", [])).toBeNull();
    expect(inferSiteName("", "not a url", ["x"])).toBeNull();
  });
});
