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
        ? { items: [] }
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

  const resp = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;
  const pull = (n: number, user: unknown) => ({
    html_url: `https://github.com/o/r/pull/${n}`, number: n, title: "t", body: null, user,
    additions: 1, deletions: 1, labels: [], merged_at: `2026-11-0${n}T00:00:00Z`,
  });

  it("first-time ignores a later merged PR by the same author", async () => {
    const queries: string[] = [];
    const f = (async (url: string) => {
      const u = String(url);
      if (u.includes("/search/issues")) {
        const q = decodeURIComponent(u.split("q=")[1]!);
        queries.push(q);
        return resp({ items: [{ pull_request: { merged_at: "2026-12-01T00:00:00Z" } }] });
      }
      if (u.includes("/pulls/1")) return resp(pull(1, { login: "z" }));
      return resp([{ number: 1, merged_at: "2026-11-01T00:00:00Z" }]);
    }) as unknown as typeof fetch;
    const prs = await githubAdapter("o/r", f).listMerged();
    expect(prs[0]!.firstTime).toBe(true);
    expect(queries).toHaveLength(1);
  });

  it("skips null-user and failing-search PRs but keeps the rest", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      if (u.includes("/search/issues")) {
        return decodeURIComponent(u).includes("author:bad") ? resp({}, false) : resp({ items: [{ pull_request: { merged_at: "2026-10-01T00:00:00Z" } }] });
      }
      if (u.includes("/pulls/1")) return resp(pull(1, null));
      if (u.includes("/pulls/2")) return resp(pull(2, { login: "bad" }));
      if (u.includes("/pulls/3")) return resp(pull(3, { login: "good" }));
      return resp([1, 2, 3].map((n) => ({ number: n, merged_at: `2026-11-0${n}T00:00:00Z` })));
    }) as unknown as typeof fetch;
    const prs = await githubAdapter("o/r", f).listMerged();
    expect(prs.map((p) => p.number)).toEqual([3]);
    expect(prs[0]!.firstTime).toBe(false);
  });
});
