import { describe, it, expect } from "vitest";
import { listMergedInRange, getMergedPr, GitHubError } from "../src/sources/github.js";

const REPO = "near/x";
const q = (u: string) => decodeURIComponent(u.split("q=")[1]!.split("&")[0]!);

const resp = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body }) as Response;

const pull = (n: number, login = "alice", body: string | null = "near: alice.testnet", mergedAt: string | null = `2026-10-0${(n % 9) + 1}T00:00:00Z`) => ({
  html_url: `https://github.com/${REPO}/pull/${n}`, number: n, title: `t${n}`, body, user: { login },
  additions: 2, deletions: 1, labels: [{ name: "bug" }], merged_at: mergedAt,
});

interface Opts { hits?: number[]; total?: number; priorAt?: string; author?: string }
function fakeFetch(o: Opts, urls: string[]) {
  return (async (url: string) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/search/issues")) {
      if (u.includes("author%3A")) return resp({ total_count: 1, items: o.priorAt ? [{ pull_request: { merged_at: o.priorAt } }] : [] });
      const hits = o.hits ?? [1, 2];
      return resp({ total_count: o.total ?? hits.length, items: hits.map((number) => ({ number })) });
    }
    const n = Number(u.split("/pulls/")[1]);
    return resp(pull(n, o.author ?? "alice"));
  }) as unknown as typeof fetch;
}

describe("listMergedInRange", () => {
  it("builds the merged-range search query", async () => {
    const urls: string[] = [];
    await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: fakeFetch({}, urls) });
    expect(urls[0]).toContain("q=" + encodeURIComponent("repo:near/x is:pr is:merged merged:2026-10-01..2026-11-07"));
    expect(urls[0]).toContain("per_page=30");
  });

  it("returns facts for each hit and total from total_count", async () => {
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: fakeFetch({}, []) });
    expect(r.prs).toHaveLength(2);
    expect(r.total).toBe(2);
    expect(r.capped).toBe(false);
    expect(r.prs[0]!.nearAccount).toBe("alice.testnet");
    expect(r.prs[0]).toMatchObject({ number: 1, changedLines: 3, labels: ["bug"], author: "alice" });
  });

  it("caps at 30 and flags capped", async () => {
    const hits = Array.from({ length: 45 }, (_, i) => i + 1);
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: fakeFetch({ hits, total: 45 }, []) });
    expect(r.prs.length).toBeLessThanOrEqual(30);
    expect(r.total).toBe(45);
    expect(r.capped).toBe(true);
  });

  it("firstTime uses whole history: an earlier merged PR means not first-time", async () => {
    const urls: string[] = [];
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: fakeFetch({ hits: [1], priorAt: "2026-01-01T00:00:00Z" }, urls) });
    expect(r.prs[0]!.firstTime).toBe(false);
    const prior = urls.find((u) => u.includes("author%3A"))!;
    expect(q(prior)).toBe("repo:near/x is:pr is:merged author:alice");
    expect(q(prior)).not.toContain("2026-10-01..2026-11-07");
    expect(prior).toContain("per_page=100");
  });

  it("firstTime is true when the author's earliest merged PR is the PR itself", async () => {
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: fakeFetch({ hits: [1], priorAt: pull(1).merged_at! }, []) });
    expect(r.prs[0]!.firstTime).toBe(true);
  });

  it("firstTime is true when the author has no earlier merged PR", async () => {
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: fakeFetch({ hits: [1] }, []) });
    expect(r.prs[0]!.firstTime).toBe(true);
  });

  it("one prior-merged search per distinct author, even with different mergedAt", async () => {
    const urls: string[] = [];
    const at = (n: number) => `2026-10-0${n}T00:00:00Z`;
    const f = (async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("author%3A")) return resp({ items: [1, 2, 3].map((n) => ({ pull_request: { merged_at: at(n) } })) });
      if (u.includes("/search/issues")) return resp({ total_count: 3, items: [{ number: 1 }, { number: 2 }, { number: 3 }] });
      const n = Number(u.split("/pulls/")[1]);
      return resp(pull(n, "alice", null, at(n)));
    }) as unknown as typeof fetch;
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: f });
    expect(r.prs.map((p) => p.firstTime)).toEqual([true, false, false]);
    expect(urls.filter((u) => u.includes("author%3A"))).toHaveLength(1);
  });

  it("rate limit throws GitHubError with retryAfter", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 60);
    const f = (async () => resp({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset })) as unknown as typeof fetch;
    const err = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: f }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(403);
    expect(err.retryAfterSec).toBeGreaterThanOrEqual(55);
    expect(err.retryAfterSec).toBeLessThanOrEqual(61);
  });

  it("uses retry-after when present", async () => {
    const f = (async () => resp({}, 429, { "retry-after": "17" })) as unknown as typeof fetch;
    const err = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: f }).catch((e) => e);
    expect(err.retryAfterSec).toBe(17);
  });

  it("a rate limit during a PR detail fetch aborts the run", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      if (u.includes("/search/issues")) return resp({ total_count: 1, items: [{ number: 1 }] });
      return resp({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) });
    }) as unknown as typeof fetch;
    await expect(listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: f })).rejects.toBeInstanceOf(GitHubError);
  });

  it("a non-rate-limit detail failure skips that PR", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      if (u.includes("author%3A")) return resp({ items: [] });
      if (u.includes("/search/issues")) return resp({ total_count: 2, items: [{ number: 1 }, { number: 2 }] });
      return u.includes("/pulls/1") ? resp({}, 500) : resp(pull(2));
    }) as unknown as typeof fetch;
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: f });
    expect(r.prs.map((p) => p.number)).toEqual([2]);
  });

  it("search hits but every detail request failing throws a 502 GitHubError", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      if (u.includes("/search/issues")) return resp({ total_count: 2, items: [{ number: 1 }, { number: 2 }] });
      return resp({}, 500);
    }) as unknown as typeof fetch;
    const err = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: f }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(502);
    expect(err.retryAfterSec).toBeNull();
    expect(err.message).toBe("GitHub could not return pull request details");
  });

  it("an empty search is not an outage", async () => {
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: fakeFetch({ hits: [], total: 0 }, []) });
    expect(r.prs).toEqual([]);
  });

  it("PRs that are unmerged or authorless (no facts, no failures) are not an outage", async () => {
    const f = (async (url: string) => {
      const u = String(url);
      if (u.includes("/search/issues")) return resp({ total_count: 1, items: [{ number: 1 }] });
      return resp(pull(1, "alice", null, null));
    }) as unknown as typeof fetch;
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: f });
    expect(r.prs).toEqual([]);
  });

  it("searches at most 25 distinct authors and drops the rest, flagging capped", async () => {
    const urls: string[] = [];
    const hits = Array.from({ length: 30 }, (_, i) => i + 1);
    const f = (async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("author%3A")) return resp({ items: [] });
      if (u.includes("/search/issues")) return resp({ total_count: 30, items: hits.map((number) => ({ number })) });
      const n = Number(u.split("/pulls/")[1]);
      return resp(pull(n, `user${n}`));
    }) as unknown as typeof fetch;
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: f });
    expect(urls.filter((u) => u.includes("author%3A"))).toHaveLength(25);
    expect(r.prs).toHaveLength(25);
    expect(r.prs.map((p) => p.number)).toEqual(hits.slice(0, 25));
    expect(r.capped).toBe(true);
    expect(r.total).toBe(30);
  });

  it("many PRs by few authors do not hit the author cap", async () => {
    const hits = Array.from({ length: 30 }, (_, i) => i + 1);
    const r = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: fakeFetch({ hits, total: 30 }, []) });
    expect(r.prs).toHaveLength(30);
    expect(r.capped).toBe(false);
  });

  it("404 throws GitHubError status 404", async () => {
    const f = (async () => resp({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const err = await listMergedInRange(REPO, "2026-10-01", "2026-11-07", { fetchFn: f }).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.status).toBe(404);
    expect(err.retryAfterSec).toBeNull();
  });
});

describe("getMergedPr", () => {
  it("returns the fact for a merged PR", async () => {
    const pr = await getMergedPr(REPO, 4, { fetchFn: fakeFetch({}, []) });
    expect(pr).toMatchObject({ number: 4, firstTime: true, nearAccount: "alice.testnet" });
  });

  it("returns null for an unmerged PR", async () => {
    const f = (async () => resp(pull(5, "alice", null, null))) as unknown as typeof fetch;
    expect(await getMergedPr(REPO, 5, { fetchFn: f })).toBeNull();
  });

  it("returns null when the PR is not found", async () => {
    const f = (async () => resp({}, 404)) as unknown as typeof fetch;
    expect(await getMergedPr(REPO, 6, { fetchFn: f })).toBeNull();
  });

  it("throws on other errors", async () => {
    const f = (async () => resp({}, 500)) as unknown as typeof fetch;
    await expect(getMergedPr(REPO, 7, { fetchFn: f })).rejects.toBeInstanceOf(GitHubError);
  });
});
