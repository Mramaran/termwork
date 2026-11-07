import { describe, expect, it, beforeEach, vi } from "vitest";
import { DEMO_MAX_REQUEST, DEMO_MISSION, DEMO_SPEND_THRESHOLD, type LogEntry, type MandateView, type SpendRequest } from "@termwork/shared";
import { GitHubError } from "../../agent/src/sources/github";
import type { PullRequestFact } from "../../agent/src/sources/types";
import { EST_DIRECT, EST_VOTE, handle, limiter, payableLimiter, type AnalyseDeps } from "./analyse";

const T0 = Date.parse("2026-11-07T12:00:00Z");
const mandate: MandateView = {
  dao_id: "dao.testnet",
  mission: DEMO_MISSION,
  status: "Active",
  spend_threshold: DEMO_SPEND_THRESHOLD,
  max_request: DEMO_MAX_REQUEST,
  term_start_ms: 0,
  term_end_ms: 0,
  term_number: 1,
  agent_key: null,
  budget_total: "0",
  budget_spent: "0",
  budget_available: "0",
};

const pr = (n: number, o: Partial<PullRequestFact> = {}): PullRequestFact => ({
  url: `https://github.com/o/r/pull/${n}`,
  number: n,
  title: `PR ${n}`,
  author: `user${n}`,
  firstTime: true,
  changedLines: 3,
  labels: [],
  mergedAt: "2026-11-05T00:00:00Z",
  nearAccount: `user${n}.testnet`,
  ...o,
});

const decision = JSON.stringify({ qualifies: true, clause_id: 2, amount_near: "0.2", rationale: "ok" });
const completeOk = (async () => ({ text: decision, receipt: {}, hash: "h" })) as unknown as AnalyseDeps["complete"];

function mk(prs: PullRequestFact[], o: Partial<AnalyseDeps> = {}): AnalyseDeps & { calls: { complete: number } } {
  const calls = { complete: 0 };
  const d: AnalyseDeps = {
    listMergedInRange: async () => ({ prs, total: prs.length, capped: false }),
    complete: (async (...a: unknown[]) => {
      calls.complete++;
      return (completeOk as (...x: unknown[]) => unknown)(...a);
    }) as unknown as AnalyseDeps["complete"],
    getMandate: async () => mandate,
    getWorkLog: async () => [],
    getRequests: async () => [],
    now: () => T0,
    secrets: [],
    mandateId: "m.testnet",
    payable: new Set(),
    apiKey: "k",
    model: "m",
    ...o,
  };
  return Object.assign(d, { calls });
}

const post = (b: unknown = { repo: "o/r", range: { preset: "week" } }, ip = "1.1.1.1") => ({ method: "POST", body: JSON.stringify(b), ip });
const body = (r: { json: unknown }) => r.json as any;
const throwing = (e: unknown) => async (): Promise<never> => {
  throw e;
};

beforeEach(() => {
  limiter.reset();
  payableLimiter.reset();
});

describe("/api/analyse", () => {
  it("non-payable repo: first-timer with account would pay", async () => {
    const r = await handle(post(), mk([pr(1)]));
    expect(r.status).toBe(200);
    expect(body(r).payable).toBe(false);
    expect(body(r).rows[0]).toMatchObject({ status: "would_pay", amountNear: "0.2", nearAccount: "user1.testnet", firstTime: true, proposalId: null });
    expect(body(r).fit).toBe("ok");
  });

  it("non-payable repo: first-timer without account is unclaimed with the amount", async () => {
    const r = await handle(post(), mk([pr(1, { nearAccount: null })]));
    expect(body(r).rows[0]).toMatchObject({ status: "unclaimed", amountNear: "0.2", nearAccount: null });
  });

  it("non-payable repo: a repeat author is decided like anyone else", async () => {
    const r = await handle(post(), mk([pr(1), pr(2, { firstTime: false })]));
    expect(body(r).rows[1]).toMatchObject({ status: "would_pay", amountNear: "0.2" });
  });

  it("non-payable repo: a model rejection is skipped with its reason", async () => {
    const text = JSON.stringify({ qualifies: false, clause_id: 1, amount_near: "0", rationale: "too small" });
    const c = (async () => ({ text, receipt: {}, hash: "h" })) as unknown as AnalyseDeps["complete"];
    const r = await handle(post(), mk([pr(1)], { complete: c }));
    expect(body(r).rows[0]).toMatchObject({ status: "skipped", reason: "skipped: too small" });
  });

  it("payable repo: ready rows get the AI's estimate; paid and pending rows make no model call", async () => {
    const log: LogEntry[] = [
      { index: 0, kind: "Paid", clause_id: 2, amount: "200000000000000000000000", recipient: "user1.testnet", evidence_url: pr(1).url, receipt_hash: "r1", note: null, timestamp_ms: 1 },
    ];
    const big = JSON.stringify({ qualifies: true, clause_id: 3, amount_near: "0.5", rationale: "feature" });
    const c = (async (msgs: { content: string }[]) => ({ text: msgs[1]!.content.includes("PR 3") ? big : decision, receipt: {}, hash: "h" })) as unknown as AnalyseDeps["complete"];
    const d = mk([pr(1), pr(2), pr(3)], { payable: new Set(["o/r"]), getWorkLog: async () => log, complete: c });
    const rows = body(await handle(post(), d)).rows;
    expect(rows[0]).toMatchObject({ status: "paid", amountNear: "0.2" });
    expect(rows[1]).toMatchObject({ status: "ready", amountNear: "0.2", reason: EST_DIRECT });
    expect(rows[2]).toMatchObject({ status: "ready", amountNear: "0.5", reason: EST_VOTE });
  });

  it("payable repo: a model refusal shows as skipped; an AI failure keeps the row ready", async () => {
    const no = JSON.stringify({ qualifies: false, clause_id: 1, amount_near: "0", rationale: "trivial change" });
    const c = (async (msgs: { content: string }[]) => {
      if (msgs[1]!.content.includes("PR 2")) throw new Error("upstream down");
      return { text: no, receipt: {}, hash: "h" };
    }) as unknown as AnalyseDeps["complete"];
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rows = body(await handle(post(), mk([pr(1), pr(2)], { payable: new Set(["o/r"]), complete: c }))).rows;
      expect(rows[0]).toMatchObject({ status: "skipped", reason: "skipped: trivial change", amountNear: null });
      expect(rows[1]).toMatchObject({ status: "ready", reason: "ready to pay", amountNear: null });
    } finally {
      errs.mockRestore();
    }
  });

  it("payable repo without AI configured: no model call; paid, pending and ready statuses", async () => {
    const log: LogEntry[] = [
      { index: 0, kind: "Paid", clause_id: 2, amount: "200000000000000000000000", recipient: "user1.testnet", evidence_url: pr(1).url, receipt_hash: "r1", note: null, timestamp_ms: 1 },
      { index: 1, kind: "PaidApproved", clause_id: 2, amount: "300000000000000000000000", recipient: "user2.testnet", evidence_url: pr(2).url, receipt_hash: "r2", note: null, timestamp_ms: 2 },
    ];
    const reqs: SpendRequest[] = [
      { id: 7, recipient: "user3.testnet", amount: "400000000000000000000000", clause_id: 2, evidence_url: pr(3).url, receipt_hash: "r3", rationale: "x", proposal_id: 42, state: "Pending" },
      { id: 8, recipient: "user4.testnet", amount: "400000000000000000000000", clause_id: 2, evidence_url: pr(4).url, receipt_hash: "r4", rationale: "x", proposal_id: 43, state: "Cancelled" },
    ];
    const d = mk([pr(1), pr(2), pr(3), pr(4), pr(5), pr(6, { nearAccount: null })], {
      payable: new Set(["o/r"]),
      getWorkLog: async () => log,
      getRequests: async () => reqs,
      apiKey: "",
    });
    const r = await handle(post(), d);
    expect(d.calls.complete).toBe(0);
    const rows = body(r).rows;
    expect(body(r).payable).toBe(true);
    expect(rows[0]).toMatchObject({ status: "paid", amountNear: "0.2", receiptHash: "r1", proposalId: null });
    expect(rows[1]).toMatchObject({ status: "paid", amountNear: "0.3", receiptHash: "r2" });
    expect(rows[2]).toMatchObject({ status: "pending", proposalId: 42, amountNear: "0.4", receiptHash: "r3" });
    expect(rows[3]).toMatchObject({ status: "ready", proposalId: null });
    expect(rows[4]).toMatchObject({ status: "ready" });
    expect(rows[5]).toMatchObject({ status: "unclaimed" });
  });

  it("fit no_merged_in_range with suggestions", async () => {
    const r = await handle(post(), mk([], { payable: new Set(["mramaran/demo"]) }));
    expect(body(r).fit).toBe("no_merged_in_range");
    expect(body(r).suggestions).toEqual(["mramaran/demo", "near/near-cli-rs", "near/near-sdk-rs"]);
  });

  it("fit is ok when every PR is from a repeat contributor", async () => {
    const r = await handle(post(), mk([pr(1, { firstTime: false })]));
    expect(body(r).fit).toBe("ok");
    expect(body(r).suggestions).toEqual(["near/near-cli-rs", "near/near-sdk-rs"]);
  });

  it("suggestions leave out the analysed repo", async () => {
    const r = await handle(post({ repo: "near/near-cli-rs", range: { preset: "week" } }), mk([], { payable: new Set(["mramaran/demo"]) }));
    expect(body(r).suggestions).toEqual(["mramaran/demo", "near/near-sdk-rs"]);
  });

  it("GitHub 404 gives not_found", async () => {
    const r = await handle(post(), mk([], { listMergedInRange: throwing(new GitHubError(404, null, "GitHub 404")) }));
    expect(r.status).toBe(404);
    expect(body(r)).toMatchObject({ fit: "not_found" });
    expect(body(r).suggestions.length).toBeGreaterThan(0);
  });

  it("GitHub rate limit gives 429 with retryAfterSec", async () => {
    const r = await handle(post(), mk([], { listMergedInRange: throwing(new GitHubError(403, 90, "GitHub 403")) }));
    expect(r.status).toBe(429);
    expect(body(r).retryAfterSec).toBe(90);
    expect(body(r).error).toContain("GitHub");
  });

  it("other GitHub errors give 502", async () => {
    const r = await handle(post(), mk([], { listMergedInRange: throwing(new GitHubError(500, null, "GitHub 500")) }));
    expect(r.status).toBe(502);
  });

  it("validates input", async () => {
    const bad = await handle(post({ repo: "nope", range: { preset: "week" } }), mk([]));
    expect(bad.status).toBe(400);
    expect(body(bad).field).toBe("repo");
    const r = await handle(post({ repo: "o/r", range: { preset: "x" } }), mk([]));
    expect(r.status).toBe(400);
    expect(body(r).field).toBe("range");
    expect((await handle({ method: "GET", body: "", ip: "1" }, mk([]))).status).toBe(405);
  });

  it("own limiter: third request in a minute is 429", async () => {
    const d = mk([]);
    expect((await handle(post(), d)).status).toBe(200);
    expect((await handle(post(), d)).status).toBe(200);
    const r = await handle(post(), d);
    expect(r.status).toBe(429);
    expect(body(r).retryAfterSec).toBeGreaterThan(0);
  });

  it("payable repo: three requests a minute from one IP all succeed (own, larger limit)", async () => {
    const d = mk([pr(1)], { payable: new Set(["o/r"]) });
    for (let i = 0; i < 3; i++) expect((await handle(post(), d)).status).toBe(200);
  });

  it("payable repo does not use up the non-payable limit", async () => {
    const pay = mk([pr(1)], { payable: new Set(["o/r"]) });
    for (let i = 0; i < 3; i++) await handle(post(), pay);
    const other = mk([pr(1)]);
    expect((await handle(post({ repo: "x/y", range: { preset: "week" } }), other)).status).toBe(200);
  });

  it("GitHub outage after a non-empty search gives 502 with its message", async () => {
    const r = await handle(post(), mk([], { listMergedInRange: throwing(new GitHubError(502, null, "GitHub could not return pull request details")) }));
    expect(r.status).toBe(502);
    expect(body(r).error).toBe("GitHub could not return pull request details");
  });

  it("503 when the mandate is not configured, or the model is missing for a non-payable repo", async () => {
    expect((await handle(post(), mk([], { mandateId: "" }))).status).toBe(503);
    expect((await handle(post(), mk([], { apiKey: "" }))).status).toBe(503);
    expect((await handle(post(), mk([], { apiKey: "", payable: new Set(["o/r"]) }))).status).toBe(200);
  });

  it("scrubs secrets", async () => {
    const r = await handle(post(), mk([pr(1, { title: "leak sk-SECRET" })], { secrets: ["sk-SECRET"] }));
    expect(JSON.stringify(r.json)).not.toContain("sk-SECRET");
  });

  it("runs decisions at most 5 at a time", async () => {
    let cur = 0;
    let max = 0;
    const c = (async () => {
      cur++;
      max = Math.max(max, cur);
      await new Promise((res) => setTimeout(res, 5));
      cur--;
      return { text: decision, receipt: {}, hash: "h" };
    }) as unknown as AnalyseDeps["complete"];
    const prs = Array.from({ length: 12 }, (_, i) => pr(i + 1));
    const r = await handle(post(), mk(prs, { complete: c }));
    expect(body(r).rows).toHaveLength(12);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(5);
  });

  it("every model call failing gives 502 and logs a scrubbed line", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = (async () => {
      throw new Error("401 bad key sk-SECRET");
    }) as unknown as AnalyseDeps["complete"];
    const r = await handle(post(), mk([pr(1), pr(2)], { complete: c, secrets: ["sk-SECRET"] }));
    expect(r.status).toBe(502);
    expect(body(r).error).toBe("The AI request failed. Try again in a minute.");
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(" ")).toContain("401 bad key");
    expect(spy.mock.calls.flat().join(" ")).not.toContain("sk-SECRET");
    spy.mockRestore();
  });

  it("a partial model failure still gives 200 with that row skipped", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const c = (async () => {
      if (n++ === 0) throw new Error("boom");
      return { text: decision, receipt: {}, hash: "h" };
    }) as unknown as AnalyseDeps["complete"];
    const r = await handle(post(), mk([pr(1), pr(2)], { complete: c }));
    expect(r.status).toBe(200);
    expect(body(r).rows.map((x: any) => x.status).sort()).toEqual(["skipped", "would_pay"]);
    spy.mockRestore();
  });
});
