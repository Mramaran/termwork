import { describe, it, expect } from "vitest";
import { fixturesAdapter } from "../src/sources/fixtures.js";
import { parseNearAccount, githubAdapter } from "../src/sources/github.js";

describe("sources", () => {
  it("fixtures adapter returns 5 PRs", async () => {
    const prs = await fixturesAdapter().listMerged();
    expect(prs).toHaveLength(5);
    expect(prs[3]!.labels).toContain("feature");
    expect(prs[4]!.firstTime).toBe(false);
  });
  it("parses near account from body", () => {
    expect(parseNearAccount("Fixes bug\n\nnear: alice.testnet\n")).toBe("alice.testnet");
    expect(parseNearAccount("Near: bob-1.testnet  ")).toBe("bob-1.testnet");
    expect(parseNearAccount("no account here")).toBeNull();
    expect(parseNearAccount("near: alice.mainnet")).toBeNull();
  });
  it("github adapter derives facts via injected fetch", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      const body = u.includes("/search/issues")
        ? { total_count: 1 }
        : u.includes("/pulls/7")
          ? { html_url: "https://github.com/o/r/pull/7", number: 7, title: "t", body: "near: z.testnet", user: { login: "z" }, additions: 5, deletions: 3, labels: [{ name: "feature" }], merged_at: "2026-11-01T00:00:00Z" }
          : [{ number: 7, merged_at: "2026-11-01T00:00:00Z" }, { number: 8, merged_at: null }];
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    const prs = await githubAdapter("o/r", f, "tok").listMerged();
    expect(prs).toEqual([
      expect.objectContaining({ number: 7, firstTime: true, changedLines: 8, nearAccount: "z.testnet", labels: ["feature"] }),
    ]);
  });
});
