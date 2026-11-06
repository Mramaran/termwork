import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LogEntry, MandateView, SpendRequest } from "@termwork/shared";
import { DEMO_MISSION } from "@termwork/shared";
import type { InferenceReceipt } from "../../agent/src/receipts.js";
import type { PullRequestFact } from "../../agent/src/sources/types.js";
import { assertNoSecrets, buildRun, matchTxs, serializeRun, type BuildInput } from "../src/run-build.js";

const Y = (tenths: number): string => (BigInt(tenths) * 10n ** 23n).toString();
const REPORT = "Paid\n[#1] Paid 0.2 NEAR.\n";
const REPORT_HASH = createHash("sha256").update(REPORT, "utf8").digest("hex");
const prUrl = (n: number) => `https://github.com/termwork/demo/pull/${n}`;
const h = (c: string) => c.repeat(64);

const receipt = (decision: object, model = "test-model"): InferenceReceipt => ({
  model,
  requestBody: "{}",
  responseText: JSON.stringify({ id: "x", choices: [{ message: { content: JSON.stringify(decision) } }] }),
  chatId: "c",
  signature: {},
  attestation: {},
  nonce: "n",
  verified: true,
  verifiedScope: "response-signature+model+nonce",
  mode: "live",
  createdAt: "2026-11-06T00:00:00Z",
});

const entry = (e: Partial<LogEntry> & Pick<LogEntry, "index" | "kind">): LogEntry => ({
  clause_id: null,
  amount: null,
  recipient: null,
  evidence_url: null,
  receipt_hash: null,
  note: null,
  timestamp_ms: 1_000_000 + e.index * 10_000,
  ...e,
});

function input(): BuildInput {
  const log: LogEntry[] = [
    entry({ index: 0, kind: "Hired", amount: Y(20) }),
    entry({ index: 1, kind: "Paid", clause_id: 1, amount: Y(2), recipient: "a.t", evidence_url: prUrl(1), receipt_hash: h("1") }),
    entry({ index: 2, kind: "Paid", clause_id: 2, amount: Y(2), recipient: "b.t", evidence_url: prUrl(2), receipt_hash: h("2") }),
    entry({ index: 3, kind: "Paid", clause_id: 2, amount: Y(2), recipient: "c.t", evidence_url: prUrl(3), receipt_hash: h("3") }),
    entry({ index: 4, kind: "Requested", clause_id: 3, amount: Y(5), recipient: "d.t", evidence_url: prUrl(4), receipt_hash: h("4"), note: "big" }),
    entry({ index: 5, kind: "Work", clause_id: 1, evidence_url: prUrl(5), receipt_hash: h("5"), note: "skipped: not a first-time contributor" }),
    entry({ index: 6, kind: "RenewalProposed", amount: "0", receipt_hash: REPORT_HASH, note: "300 s requested" }),
    entry({ index: 7, kind: "Fired", amount: "2433371664646956000000000", recipient: "dao.t" }),
    entry({ index: 8, kind: "Swept", amount: "114510000000000000000000", recipient: "dao.t" }),
  ];
  const requests: SpendRequest[] = [
    { id: 0, recipient: "d.t", amount: Y(5), clause_id: 3, evidence_url: prUrl(4), receipt_hash: h("4"), rationale: "big", proposal_id: 1, state: "Cancelled" },
  ];
  const decisions = [true, true, true, true, true].map((q, i) => ({ qualifies: q, clause_id: i === 3 ? 3 : 2, amount_near: i === 3 ? "0.5" : "0.2", rationale: `r${i + 1}` }));
  const receipts: Record<string, InferenceReceipt> = {};
  const index: Record<string, string> = {};
  decisions.forEach((d, i) => {
    receipts[h(String(i + 1))] = receipt(d);
    index[prUrl(i + 1)] = h(String(i + 1));
  });
  receipts[h("9")] = receipt({ note: "report" }, "renewal-model");
  index["renewal:1"] = h("9");
  const facts: PullRequestFact[] = [1, 2, 3, 4, 5].map((n) => ({
    url: prUrl(n),
    number: n,
    title: `PR ${n}`,
    author: "x",
    firstTime: n !== 5,
    changedLines: 10 * n,
    labels: [],
    mergedAt: "2026-11-01T00:00:00Z",
    nearAccount: `u${n}.t`,
  }));
  const tx = (hash: string) => ({ hash, explorer: `https://e/${hash}` });
  const mandate = {
    dao_id: "dao.t",
    mission: DEMO_MISSION,
    status: "Fired",
    spend_threshold: Y(2),
    max_request: Y(5),
    term_start_ms: 1_000_000,
    term_end_ms: 1_300_000,
    term_number: 1,
    agent_key: null,
    budget_total: Y(20),
    budget_spent: Y(6),
    budget_available: "0",
  } as MandateView;
  return {
    demo: {
      startedAt: "2026-11-06T16:40:18.334Z",
      accounts: { dao: "dao.t", mandate: "m.t", renewalReport: REPORT, contributors: {} },
      proposals: { hire: 0, bigSpend: 1, renewal: 2, fire: 3 },
      txs: {
        "hire.propose": tx("HP"),
        "hire.vote1": tx("HV1"),
        "hire.vote2": tx("HV2"),
        "bigSpend.reject1": tx("BR1"),
        "bigSpend.reject2": tx("BR2"),
        "termEnded.spend": tx("TE"),
        "fire.propose": tx("FP"),
        "fire.vote1": tx("FV1"),
        "fire.vote2": tx("FV2"),
        "renewal.reject1": tx("RR1"),
        "renewal.reject2": tx("RR2"),
        sweep: tx("SW"),
      },
      termEnded: { rpcError: "Smart contract panicked: term ended" },
      agentAttempt: { result: "InvalidAccessKey (access key does not exist)" },
    },
    mandate,
    log,
    requests,
    proposals: [{ id: 1, status: "Rejected" }],
    receipts,
    index,
    prFacts: facts,
    txLookup: { "paid:1": "P1", "paid:2": "P2", "paid:3": "P3", "request:0": "RQ", renewal: "RN" },
  };
}

describe("buildRun", () => {
  it("buildRun maps 5 PRs with outcomes paid,paid,paid,requested,skipped", () => {
    const run = buildRun(input());
    expect(run.prs.map((p) => p.outcome)).toEqual(["paid", "paid", "paid", "requested", "skipped"]);
    expect(run.prs.map((p) => p.tx)).toEqual(["P1", "P2", "P3", "RQ", null]);
    expect(run.prs.map((p) => p.logIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(run.model).toBe("renewal-model");
    expect(run.bigSpend).toMatchObject({ requestId: 0, proposalId: 1, state: "Rejected", rejectTxs: ["BR1", "BR2"] });
    expect(run.hire.voteTxs).toEqual(["HV1", "HV2"]);
    expect(run.termSecs).toBe(300);
    expect(run.budget.availableAtReport).toBe(Y(14));
  });

  it('PR 5 keeps AI qualifies=true with outcome skipped and note "not a first-time contributor"', () => {
    const p5 = buildRun(input()).prs[4]!;
    expect(p5.ai?.qualifies).toBe(true);
    expect(p5.outcome).toBe("skipped");
    expect(p5.outcomeNote).toBe("not a first-time contributor");
    expect(p5.amount).toBeNull();
  });

  it("renewal reportHash equals log entry 6 hash", () => {
    const run = buildRun(input());
    expect(run.renewal.reportHash).toBe(run.log[6]!.receipt_hash);
    expect(run.renewal.logIndex).toBe(6);
    expect(run.renewal.receiptHash).toBe(h("9"));
    expect(run.renewal.proposalTx).toBe("RN");
  });

  it("missing tx lookup yields null tx, not a guess", () => {
    const i = input();
    i.txLookup = {};
    const run = buildRun(i);
    expect(run.prs.every((p) => p.tx === null)).toBe(true);
    expect(run.bigSpend.requestTx).toBeNull();
    expect(run.renewal.proposalTx).toBeNull();
  });

  it("ai is null when the receipt cannot be parsed", () => {
    const i = input();
    i.receipts[h("1")] = { ...i.receipts[h("1")]!, responseText: "not json at all" };
    expect(buildRun(i).prs[0]!.ai).toBeNull();
  });

  it("amounts stay yocto strings in run.json", () => {
    const parsed = JSON.parse(serializeRun(buildRun(input())));
    expect(parsed.prs[0].amount).toBe(Y(2));
    expect(parsed.prs[3].amount).toBe(Y(5));
    expect(parsed.end.firedAmount).toBe("2433371664646956000000000");
    expect(parsed.end.sweptAmount).toBe("114510000000000000000000");
    expect(parsed.budget).toEqual({ total: Y(20), spent: Y(6), availableAtReport: Y(14) });
    expect(typeof parsed.spendThreshold).toBe("string");
  });

  it("refuses to write when a value looks like a private key", () => {
    const i = input();
    i.demo.agentAttempt.result = "ed25519:" + "1".repeat(64);
    expect(() => serializeRun(buildRun(i))).toThrow(/private key/);
    expect(() => assertNoSecrets('{"k":"sk-abcdefghijklmnop"}')).toThrow(/sk-/);
    expect(() => assertNoSecrets('{"k":"ed25519:' + "2".repeat(44) + '"}')).not.toThrow();
  });
});

describe("matchTxs", () => {
  it("matches by method and order, and drops failed or out-of-window transactions", () => {
    const i = input();
    const t = (method: string, hash: string, blockMs: number, ok = true) => ({ method, hash, blockMs, ok });
    const m = matchTxs(
      [
        t("spend", "S1", 1_009_000),
        t("spend", "S2", 1_019_000),
        t("spend", "S3", 1_029_000),
        t("spend", "LATE", 1_299_000, false),
        t("request_spend", "R0", 1_039_000),
        t("propose_renewal", "PR", 1_059_000),
      ],
      i.log,
      i.requests,
    );
    expect(m).toEqual({ "paid:1": "S1", "paid:2": "S2", "paid:3": "S3", "request:0": "R0", renewal: "PR" });
    expect(matchTxs([t("spend", "FAR", 5)], i.log, i.requests)).toEqual({});
  });
});
