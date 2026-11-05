import { describe, it, expect } from "vitest";
import { loadConfig, type LogEntry, type MandateView } from "@termwork/shared";
import { fixtureDecision, fixtureReceipt, fixtureReport, FIXTURE_MODEL } from "../src/fixture.js";
import { completionText, receiptHash } from "../src/receipts.js";
import { checkCitations } from "../src/report.js";
import { fixturesAdapter } from "../src/sources/fixtures.js";
import { parseDecision } from "../src/validate.js";

const near = (tenths: number) => (BigInt(tenths) * 10n ** 23n).toString();
const mandate: MandateView = {
  dao_id: "dao.testnet",
  mission: { title: "Contributor Rewards Steward", clauses: [] },
  status: "Active",
  spend_threshold: near(2),
  max_request: near(5),
  term_start_ms: 0,
  term_end_ms: 1,
  term_number: 1,
  agent_key: null,
  budget_spent: near(6),
  budget_available: near(14),
};

describe("fixture decider", () => {
  it("decides the five fixture PRs by the mission rules", async () => {
    const prs = await fixturesAdapter().listMerged();
    const outcome = prs.map((pr) => {
      const d = parseDecision(fixtureDecision(pr));
      if ("error" in d) throw new Error(d.error);
      return `${pr.number}:${d.qualifies}:${d.clause_id}:${d.amount_near}`;
    });
    expect(outcome).toEqual(["1:true:2:0.2", "2:true:2:0.2", "3:true:2:0.2", "4:true:3:0.5", "5:false:1:0"]);
  });

  it("sends a PR over 200 lines to a vote even without a feature label", async () => {
    const [pr] = await fixturesAdapter().listMerged();
    const d = parseDecision(fixtureDecision({ ...pr!, labels: ["bug"], changedLines: 201 }));
    expect(d).toMatchObject({ qualifies: true, clause_id: 3, amount_near: "0.5" });
  });

  it("is deterministic", async () => {
    const [pr] = await fixturesAdapter().listMerged();
    expect(fixtureDecision(pr!)).toBe(fixtureDecision(pr!));
  });
});

describe("fixture report", () => {
  const entry = (index: number, o: Partial<LogEntry>): LogEntry => ({
    index, kind: "Work", clause_id: null, amount: null, recipient: null, evidence_url: null, receipt_hash: null, note: null, timestamp_ms: 0, ...o,
  });
  const log = [
    entry(0, { kind: "Hired" }),
    entry(1, { kind: "Paid", clause_id: 2, amount: near(2), evidence_url: "https://github.com/termwork/demo/pull/1" }),
    entry(2, { kind: "Requested", clause_id: 3, amount: near(5), evidence_url: "https://github.com/termwork/demo/pull/4" }),
    entry(3, { kind: "Work", clause_id: 1, evidence_url: "https://github.com/termwork/demo/pull/5", note: "skipped: not a first-time contributor" }),
  ];

  it("cites only real log indices and passes the report check", () => {
    const text = fixtureReport(mandate, log);
    expect(checkCitations(text, new Set(log.map((e) => e.index)))).toEqual({ ok: true });
    expect(text).toContain("[#1]");
    expect(text).toContain("[#2]");
    expect(text).toContain("[#3]");
    expect(text).toContain("paid 0.2 NEAR");
  });
});

describe("fixture receipt", () => {
  it("is honestly labelled, round-trips and hashes stably", () => {
    const r = fixtureReceipt([{ role: "user", content: "x" }], "hello", "k");
    expect(r).toMatchObject({ model: FIXTURE_MODEL, verified: false, verifiedScope: "none", mode: "fixture", signature: null, attestation: null });
    expect(completionText(r.responseText)).toBe("hello");
    expect(receiptHash(r)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("config", () => {
  it("accepts AGENT_MODE=fixture and still rejects unknown modes", () => {
    expect(loadConfig({ AGENT_MODE: "fixture" } as NodeJS.ProcessEnv).AGENT_MODE).toBe("fixture");
    expect(() => loadConfig({ AGENT_MODE: "magic" } as NodeJS.ProcessEnv)).toThrow(/AGENT_MODE/);
  });
  it("accepts only allowlisted testnet RPC hosts", () => {
    for (const h of ["rpc.testnet.near.org", "archival-rpc.testnet.near.org", "test.rpc.fastnear.com", "rpc.testnet.fastnear.com"]) {
      expect(loadConfig({ NEAR_RPC_URL: `https://${h}` } as NodeJS.ProcessEnv).NEAR_RPC_URL).toBe(`https://${h}`);
    }
    for (const bad of ["https://test.evil.example", "https://testnet.evil.example", "https://test.rpc.mainnet.near.org", "https://rpc.mainnet.near.org", "http://rpc.testnet.near.org", "https://rpc.testnet.near.org.evil.example"]) {
      expect(() => loadConfig({ NEAR_RPC_URL: bad } as NodeJS.ProcessEnv)).toThrow(/NEAR_RPC_URL/);
    }
  });
});
