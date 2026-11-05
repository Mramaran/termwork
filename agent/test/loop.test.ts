import { describe, it, expect, vi } from "vitest";
import type { LogEntry, MandateView, Renewal } from "@termwork/shared";
import type { PullRequestFact } from "../src/sources/types.js";
import { tick, type LoopDeps } from "../src/loop.js";

const near = (tenths: number) => (BigInt(tenths) * 10n ** 23n).toString();
const TERM = 1_000_000; // ms
const mandate = (o: Partial<MandateView> = {}): MandateView => ({
  dao_id: "dao.testnet",
  mission: {
    title: "Contributor Rewards Steward",
    clauses: [
      { id: 1, text: "reward first-time contributors", max_amount: near(5), pays: true },
      { id: 2, text: "standard reward 0.2 NEAR", max_amount: near(2), pays: true },
      { id: 3, text: "big reward goes to a DAO vote", max_amount: near(5), pays: true },
      { id: 4, text: "never pay twice", max_amount: null, pays: false },
    ],
  },
  status: "Active",
  spend_threshold: near(2),
  max_request: near(5),
  term_start_ms: 0,
  term_end_ms: TERM,
  term_number: 1,
  agent_key: null,
  budget_total: "2000000000000000000000000",
  budget_spent: "0",
  budget_available: near(500),
  ...o,
});
const pr = (n: number, o: Partial<PullRequestFact> = {}): PullRequestFact => ({
  url: `https://github.com/termwork/demo/pull/${n}`,
  number: n,
  title: `PR ${n}`,
  author: `dev${n}`,
  firstTime: true,
  changedLines: 10,
  labels: [],
  mergedAt: "2026-11-01T10:00:00Z",
  nearAccount: `dev${n}.testnet`,
  ...o,
});
const entry = (index: number, o: Partial<LogEntry> = {}): LogEntry => ({
  index,
  kind: "Hired",
  clause_id: null,
  amount: null,
  recipient: null,
  evidence_url: null,
  receipt_hash: null,
  note: null,
  timestamp_ms: 0,
  ...o,
});
const small = '{"qualifies":true,"clause_id":2,"amount_near":"0.2","rationale":"small fix"}';
const big = '{"qualifies":true,"clause_id":3,"amount_near":"0.4","rationale":"feature"}';

function deps(o: Partial<LoopDeps> = {}) {
  const calls: { path: string; body: any }[] = [];
  const d: LoopDeps = {
    now: () => 100,
    getMandate: async () => mandate(),
    getWorkLog: async (from, limit) => [entry(0)].slice(from, from + limit),
    getRenewal: async () => null,
    getRequests: async () => [],
    source: { listMerged: async () => [pr(1)] },
    exists: async () => true,
    decide: async () => ({ text: small, hash: "h1" }),
    generateReport: async () => ({ text: "Paid dev1 [#0].", hash: "hr" }),
    signer: {
      post: async (path, body) => {
        calls.push({ path, body });
        return { status: 200, json: { txHash: "TX" } };
      },
    },
    log: () => {},
    ...o,
  };
  return { d, calls };
}

describe("tick", () => {
  it("tick pays small PRs via /spend", async () => {
    const { d, calls } = deps();
    const r = await tick(d);
    expect(r.stopped).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/spend");
    expect(calls[0]!.body).toMatchObject({
      recipient: "dev1.testnet",
      amount: near(2),
      clause_id: 2,
      evidence_url: pr(1).url,
      receipt_hash: "h1",
    });
  });

  it("tick files request for feature PR", async () => {
    const { d, calls } = deps({ decide: async () => ({ text: big, hash: "h2" }) });
    await tick(d);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/request_spend");
    expect(calls[0]!.body).toMatchObject({ amount: near(4), clause_id: 3, rationale: "feature", receipt_hash: "h2" });
  });

  it("skips already-paid PRs after restart", async () => {
    const decide = vi.fn(async () => ({ text: small, hash: "h" }));
    const { d, calls } = deps({
      source: { listMerged: async () => [pr(1), pr(2)] },
      getWorkLog: async (from, limit) =>
        [entry(0), entry(1, { kind: "Paid", evidence_url: pr(1).url })].slice(from, from + limit),
      decide,
    });
    await tick(d);
    expect(calls.map((c) => c.body.evidence_url)).toEqual([pr(2).url]);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("does not re-request pending PRs or re-log skipped ones, but retries rpc failures", async () => {
    const { d, calls } = deps({
      source: { listMerged: async () => [pr(1), pr(2), pr(3)] },
      getRequests: async () => [{ evidence_url: pr(1).url, state: "Pending" } as any],
      getWorkLog: async () => [
        entry(0),
        entry(1, { kind: "Work", evidence_url: pr(2).url, note: "skipped: x" }),
        entry(2, { kind: "Work", evidence_url: pr(3).url, note: "recipient check failed (rpc): boom" }),
      ],
    });
    await tick(d);
    expect(calls.map((c) => c.body.evidence_url)).toEqual([pr(3).url]);
  });

  it("tick calls /expire after term end and stops", async () => {
    const { d, calls } = deps({ now: () => TERM + 1 });
    const r = await tick(d);
    expect(r.stopped).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/expire"]);
  });

  it("stops without acting when status is not Active", async () => {
    const { d, calls } = deps({ getMandate: async () => mandate({ status: "Fired" }) });
    expect((await tick(d)).stopped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("504 is not retried and does not stop other PRs; 502 likewise", async () => {
    let n = 0;
    const calls: string[] = [];
    const { d } = deps({
      source: { listMerged: async () => [pr(1), pr(2), pr(3)] },
      signer: {
        post: async (_p, body: any) => {
          calls.push(body.evidence_url);
          n++;
          if (n === 1) return { status: 504, json: { error: "outcome unknown" } };
          if (n === 2) return { status: 502, json: { error: "rpc" } };
          return { status: 200, json: { txHash: "TX" } };
        },
      },
    });
    await tick(d);
    expect(calls).toEqual([pr(1).url, pr(2).url, pr(3).url]);
  });

  it("skips a PR when the decider throws", async () => {
    const { d, calls } = deps({
      source: { listMerged: async () => [pr(1), pr(2)] },
      decide: async (p) => {
        if (p.number === 1) throw new Error("attestation fetch failed");
        return { text: small, hash: "h" };
      },
    });
    await tick(d);
    expect(calls.map((c) => c.body.evidence_url)).toEqual([pr(2).url]);
  });

  it("skips a PR with no stored receipt (decide returns null)", async () => {
    const { d, calls } = deps({ decide: async () => null });
    await tick(d);
    expect(calls).toHaveLength(0);
  });

  it("logs a model rejection as work with the receipt hash", async () => {
    const { d, calls } = deps({ decide: async () => ({ text: "nonsense", hash: "hx" }) });
    await tick(d);
    expect(calls[0]!.path).toBe("/log_work");
    expect(calls[0]!.body).toMatchObject({ clause_id: 1, evidence_url: pr(1).url, receipt_hash: "hx" });
    expect(calls[0]!.body.summary).toMatch(/^rejected decision/);
  });
});

describe("renewal", () => {
  const inWindow = { now: () => 800_000, source: { listMerged: async () => [] as PullRequestFact[] } };

  it("files renewal once inside window", async () => {
    const { d, calls } = deps(inWindow);
    await tick(d);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/propose_renewal");
    expect(calls[0]!.body).toEqual({
      report_text: "Paid dev1 [#0].",
      requested_term_secs: TERM / 1000,
      requested_topup: "0",
    });
    const filed: Renewal = { report_text: "x", report_hash: "y", requested_term_secs: 1, requested_topup: "0", proposal_id: null, timestamp_ms: 700_000 };
    const again = deps({ ...inWindow, getRenewal: async () => filed });
    await tick(again.d);
    expect(again.calls).toHaveLength(0);
  });

  it("does not file before the window opens", async () => {
    const { d, calls } = deps({ ...inWindow, now: () => 600_000 });
    await tick(d);
    expect(calls).toHaveLength(0);
  });

  it("files again when the stored renewal is from an older term", async () => {
    const old: Renewal = { report_text: "x", report_hash: "y", requested_term_secs: 1, requested_topup: "0", proposal_id: null, timestamp_ms: 10 };
    const { d, calls } = deps({
      ...inWindow,
      getMandate: async () => mandate({ term_start_ms: 500_000, term_end_ms: 1_500_000, term_number: 2 }),
      now: () => 1_300_000,
      getRenewal: async () => old,
    });
    await tick(d);
    expect(calls.map((c) => c.path)).toEqual(["/propose_renewal"]);
  });

  it("report retried once then logged as work if citations fail", async () => {
    const generateReport = vi.fn(async () => ({ text: "no citations here", hash: "hr" }));
    const { d, calls } = deps({ ...inWindow, generateReport });
    await tick(d);
    expect(generateReport).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/log_work");
    expect(calls[0]!.body.clause_id).toBe(1);
    expect(calls[0]!.body.summary).toMatch(/^renewal report rejected: /);
    expect(calls[0]!.body.evidence_url).toBeNull();
  });

  it("does not retry renewal after a rejection note in the same term", async () => {
    const generateReport = vi.fn(async () => ({ text: "Paid dev1 [#0].", hash: "hr" }));
    const { d, calls } = deps({
      ...inWindow,
      generateReport,
      getWorkLog: async () => [
        entry(0),
        entry(1, { kind: "Work", note: "renewal report rejected: no citations", timestamp_ms: 700_000 }),
      ],
    });
    await tick(d);
    expect(generateReport).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("still files renewal when listMerged fails", async () => {
    const { d, calls } = deps({ ...inWindow, source: { listMerged: async () => { throw new Error("gh down"); } } });
    await tick(d);
    expect(calls.map((c) => c.path)).toEqual(["/propose_renewal"]);
  });
});

describe("duplicates", () => {
  it("acts once on a duplicate PR url within one tick", async () => {
    const { d, calls } = deps({ source: { listMerged: async () => [pr(1), pr(1)] } });
    await tick(d);
    expect(calls).toHaveLength(1);
  });
});
