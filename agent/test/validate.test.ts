import { describe, it, expect } from "vitest";
import type { MandateView } from "@termwork/shared";
import { parseDecision, validate, type Decision } from "../src/validate.js";
import { fixturesAdapter } from "../src/sources/fixtures.js";

/** tenths of a NEAR as a yocto string: near(2) = 0.2 NEAR */
const near = (tenths: number) => (BigInt(tenths) * 10n ** 23n).toString();
const mandate: MandateView = {
  dao_id: "dao.testnet",
  mission: {
    title: "Contributor Rewards Steward",
    clauses: [
      { id: 1, text: "reward first-time contributors whose PRs are merged", max_amount: near(5), pays: true },
      { id: 2, text: "standard reward 0.2 NEAR", max_amount: near(2), pays: true },
      { id: 3, text: "big reward goes to a DAO vote", max_amount: near(5), pays: true },
      { id: 4, text: "never pay twice / needs a NEAR account", max_amount: null, pays: false },
    ],
  },
  status: "Active",
  spend_threshold: near(2),
  max_request: near(5),
  term_start_ms: 0,
  term_end_ms: 1,
  term_number: 1,
  agent_key: null,
  budget_total: "2000000000000000000000000",
  budget_spent: "0",
  budget_available: near(500),
};
const yes = async () => true;
const dec = (o: Partial<Decision> = {}): Decision => ({
  qualifies: true,
  clause_id: 2,
  amount_near: "0.2",
  rationale: "ok",
  ...o,
});
const prs = await fixturesAdapter().listMerged();
const pr1 = prs[0]!;
const pr4 = prs[3]!;
const pr5 = prs[4]!;

describe("rejects malformed decision", () => {
  const cases: Array<[string, string]> = [
    ["no json", "I think we should pay"],
    ["number amount", '{"qualifies":true,"clause_id":2,"amount_near":0.2,"rationale":"x"}'],
    ["missing field", '{"qualifies":true,"clause_id":2,"amount_near":"0.2"}'],
    ["unknown clause", '{"qualifies":true,"clause_id":99,"amount_near":"0.2","rationale":"x"}'],
  ];
  for (const [name, raw] of cases) {
    it(name, async () => {
      const a = await validate(parseDecision(raw), pr1, mandate, new Set(), yes);
      expect(a.kind).toBe("log");
      expect((a as { summary: string }).summary).toMatch(/^rejected decision: /);
    });
  }
  it("accepts prose-wrapped JSON", () => {
    const d = parseDecision('Sure! Here: {"qualifies":true,"clause_id":2,"amount_near":"0.2","rationale":"a {b} c"} thanks');
    expect(d).toEqual(dec({ rationale: "a {b} c" }));
  });
});

describe("validate", () => {
  it("small first-time PR → spend 0.2", async () => {
    const a = await validate(dec(), pr1, mandate, new Set(), yes);
    expect(a).toEqual({ kind: "spend", recipient: "alice-dev.invalid", amountYocto: near(2), clauseId: 2, evidenceUrl: pr1.url });
  });
  it("feature PR → request 0.5", async () => {
    const a = await validate(dec({ clause_id: 3, amount_near: "0.5" }), pr4, mandate, new Set(), yes);
    expect(a).toMatchObject({ kind: "request", amountYocto: near(5), clauseId: 3, recipient: "dave-builds.invalid" });
  });
  it("repeat author is paid like anyone else", async () => {
    const a = await validate(dec(), { ...pr5, nearAccount: "alice.testnet" }, mandate, new Set(), yes);
    expect(a).toMatchObject({ kind: "spend" });
  });
  it("already paid → log skip", async () => {
    const a = await validate(dec(), pr1, mandate, new Set([pr1.url]), yes);
    expect(a).toMatchObject({ kind: "log", clauseId: 4 });
  });
  it("amount above max_request → log rejected", async () => {
    const a = await validate(dec({ clause_id: 3, amount_near: "0.6" }), pr4, mandate, new Set(), yes);
    expect(a).toMatchObject({ kind: "log" });
    expect((a as { summary: string }).summary).toMatch(/^rejected decision/);
  });
  it("skips nonexistent recipient", async () => {
    const a = await validate(dec(), pr1, mandate, new Set(), async () => false);
    expect(a).toMatchObject({ kind: "log", summary: "recipient account does not exist" });
  });
  it("missing near account → log skip", async () => {
    const a = await validate(dec(), { ...pr1, nearAccount: null }, mandate, new Set(), yes);
    expect(a).toMatchObject({ kind: "log", clauseId: 4 });
  });
  it("non-qualifying decision → log skip with rationale", async () => {
    const a = await validate(dec({ qualifies: false, amount_near: "0", rationale: "spam" }), pr1, mandate, new Set(), yes);
    expect(a).toMatchObject({ kind: "log", summary: "skipped: spam" });
  });
  it("zero amount and non-paying clause are rejected; exists() throwing does not escape", async () => {
    expect((await validate(dec({ amount_near: "0" }), pr1, mandate, new Set(), yes)).kind).toBe("log");
    expect((await validate(dec({ clause_id: 4 }), pr1, mandate, new Set(), yes)).kind).toBe("log");
    const a = await validate(dec(), pr1, mandate, new Set(), async () => {
      throw new Error("rpc down");
    });
    expect(a).toMatchObject({ kind: "log", clauseId: 4, summary: "recipient check failed (rpc): rpc down" });
  });
  it("max_request branch is hit independently of clause max", async () => {
    const m = {
      ...mandate,
      mission: { title: "t", clauses: [{ id: 3, text: "big", max_amount: near(50), pays: true }] },
    };
    const a = await validate(dec({ clause_id: 3, amount_near: "0.6" }), pr4, m, new Set(), yes);
    expect(a).toMatchObject({ kind: "log", summary: "rejected decision: amount exceeds max_request" });
  });
});
