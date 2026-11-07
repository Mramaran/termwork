import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { explorerAccount, explorerTx } from "./chain";
import { confirmCheck, reportHashMatches, steps, type CheckItem, type FeedLine } from "./run";
import { FIXTURE } from "./run.fixture";

const S = steps(FIXTURE);
const ctxBase = { keys: null, receipt: async () => null, reportOk: null };
const texts = (f: FeedLine[]) => f.map((l) => l.text);

describe("steps", () => {
  it("work feed shows AI said yes, rules said no for PR 5", () => {
    const line = S.work.feed.find((l) => l.text.includes("AI said yes, the rules said no"));
    expect(line).toBeDefined();
    expect(line!.detail?.ai?.qualifies).toBe(true);
    expect(line!.detail?.rules).toContain("not a first-time contributor");
  });

  it("feed amounts read in NEAR not yocto", () => {
    for (const id of ["hire", "work", "vote", "fired"] as const) {
      for (const l of S[id].feed) expect(l.text, `${id}: ${l.text}`).not.toMatch(/\d{10,}|yocto/i);
    }
    expect(texts(S.work.feed).join("\n")).toContain("0.2 NEAR");
    expect(texts(S.hire.feed).join("\n")).toContain("2 NEAR");
  });

  it("fired step lists Fired 2.433 NEAR and Swept 0.115 NEAR separately", () => {
    const t = texts(S.fired.feed);
    expect(t.filter((x) => x.includes("Fired: 2.433 NEAR returned to the DAO"))).toHaveLength(1);
    expect(t.filter((x) => x.includes("Swept 0.115 NEAR"))).toHaveLength(1);
    expect(t.some((x) => x.includes("Fired: 2.433 NEAR") && x.includes("Swept"))).toBe(false);
    expect(t.some((x) => x.includes("including the 1.4 NEAR of unspent budget"))).toBe(true);
  });

  it("fired attempt line is labelled recorded output", () => {
    expect(texts(S.fired.feed).some((x) => x.startsWith("The agent's next attempt was rejected") && x.endsWith("(recorded output)"))).toBe(true);
  });

  it("renew step shows the report verbatim plus an On-chain figures line and the note", () => {
    const t = texts(S.renew.feed);
    expect(t).toContain(FIXTURE.renewal.reportText);
    expect(t).toContain("On-chain figures: budget 2 NEAR, spent 0.6 NEAR, available at report time 1.4 NEAR");
    expect(t).toContain("The agent's report states amounts in yoctoNEAR and calls the available 1.4 NEAR its 'initial budget'. The contract's figures above are authoritative.");
  });

  it("renew checklist has separate report-hash and receipt items", () => {
    const kinds = S.renew.checks.map((c) => c.kind);
    expect(kinds).toContain("report-hash");
    const r = S.renew.checks.find((c) => c.kind === "receipt")!;
    expect(r.label).toBe("Renewal AI receipt");
    expect(r.receiptHash).toBe(FIXTURE.renewal.receiptHash);
    expect(S.renew.checks.some((c) => c.label === "Report hash matches on-chain")).toBe(true);
  });

  it("hire agent key item links the second vote tx", () => {
    const k = S.hire.checks.find((c) => /agent key created/i.test(c.label))!;
    expect(k.tx).toBe(FIXTURE.hire.voteTxs[1]);
    expect(k.href).toBe(explorerTx(FIXTURE.hire.voteTxs[1]!));
  });

  it("null tx renders explorer account link labelled \"see on explorer\"", async () => {
    const run = structuredClone(FIXTURE);
    run.prs[0]!.tx = null;
    const item = steps(run).work.checks.find((c) => c.label.includes("see on explorer"))!;
    expect(item.href).toBe(explorerAccount(run.mandate));
    expect(await confirmCheck(item, ctxBase)).toBe(false);
  });

  it("fired step ends with a live keys check and a recorded attempt", () => {
    expect(S.fired.checks.some((c) => c.kind === "live-keys")).toBe(true);
    const rec = S.fired.checks.filter((c) => c.kind === "recorded");
    expect(rec.length).toBeGreaterThan(0);
  });

  it("vote step lists each approved big spend with its YES vote and payment", () => {
    const half = (5n * 10n ** 23n).toString();
    const run = {
      ...FIXTURE,
      bigSpends: [
        { prNumber: 2, prUrl: "https://github.com/o/r/pull/2", requestId: 0, proposalId: 3, amount: half, recipient: "a.testnet", requestTx: "RQ0", voteTxs: ["V0"], approved: true, state: "Approved" },
        { prNumber: 5, prUrl: "https://github.com/o/r/pull/5", requestId: 1, proposalId: 4, amount: half, recipient: "b.testnet", requestTx: null, voteTxs: ["V1"], approved: true, state: "Approved" },
      ],
    };
    const v = steps(run).vote;
    expect(texts(v.feed)).toEqual([
      "PR #2 asked for 0.5 NEAR, over the 0.2 NEAR limit: DAO proposal #3",
      "The council voted YES (1 vote): 0.5 NEAR paid to a.testnet",
      "PR #5 asked for 0.5 NEAR, over the 0.2 NEAR limit: DAO proposal #4",
      "The council voted YES (1 vote): 0.5 NEAR paid to b.testnet",
    ]);
    expect(v.checks.map((c) => c.label)).toEqual(["PR #2 request", "PR #2 vote 1 (YES, pays 0.5 NEAR)", "PR #5 request, see on explorer", "PR #5 vote 1 (YES, pays 0.5 NEAR)"]);
    expect(v.checks[1]!.href).toBe(explorerTx("V0"));
  });

  it("the agent key check links the vote that passed the hire, even with one vote", () => {
    const one = steps({ ...FIXTURE, hire: { ...FIXTURE.hire, voteTxs: ["ONLY"] } });
    expect(one.hire.checks.find((c) => c.label === "Agent key created")!.href).toBe(explorerTx("ONLY"));
  });
});

describe("confirmCheck", () => {
  it("tx ticked when hash present", async () => {
    expect(await confirmCheck({ label: "x", href: "h", kind: "tx", tx: "abc" }, ctxBase)).toBe(true);
    expect(await confirmCheck({ label: "x", href: "h", kind: "tx" }, ctxBase)).toBe(false);
  });

  it("checklist item for unverified receipt is not ticked", async () => {
    const item: CheckItem = { label: "r", href: "h", kind: "receipt", receiptHash: "a".repeat(64) };
    expect(await confirmCheck(item, { ...ctxBase, receipt: async () => ({ verified: false }) })).toBe(false);
    expect(await confirmCheck(item, { ...ctxBase, receipt: async () => null })).toBe(false);
    expect(await confirmCheck(item, { ...ctxBase, receipt: async () => ({ verified: true }) })).toBe(true);
  });

  it("renewal receipt ticks only when verified and its message equals the report", async () => {
    const item = S.renew.checks.find((c) => c.kind === "receipt")!;
    const body = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });
    const text = FIXTURE.renewal.reportText;
    expect(item.expectText).toBe(text);
    const ctx = (r: object) => ({ ...ctxBase, receipt: async () => r });
    expect(await confirmCheck(item, ctx({ verified: true, responseText: body(text) }))).toBe(true);
    expect(await confirmCheck(item, ctx({ verified: true, responseText: body(text + "!") }))).toBe(false);
    expect(await confirmCheck(item, ctx({ verified: true, responseText: "not json" }))).toBe(false);
    expect(await confirmCheck(item, ctx({ verified: true }))).toBe(false);
    expect(await confirmCheck(item, ctx({ verified: false, responseText: body(text) }))).toBe(false);
  });

  it("receipt item is not ticked when the fetch rejects", async () => {
    const item: CheckItem = { label: "r", href: "h", kind: "receipt", receiptHash: "a".repeat(64) };
    expect(await confirmCheck(item, { ...ctxBase, receipt: async () => { throw new Error("offline"); } })).toBe(false);
  });

  it("work log item is labelled as recorded on-chain", () => {
    expect(S.work.checks.some((c) => c.label === "Work log (recorded on-chain)")).toBe(true);
  });

  it("recorded item is never ticked", async () => {
    const item: CheckItem = { label: "r", href: null, kind: "recorded", tx: "abc" };
    expect(await confirmCheck(item, { keys: [], receipt: async () => ({ verified: true }), reportOk: true })).toBe(false);
  });

  it("live-keys item ticked only for empty list", async () => {
    const item: CheckItem = { label: "k", href: "h", kind: "live-keys" };
    expect(await confirmCheck(item, { ...ctxBase, keys: [] })).toBe(true);
    expect(await confirmCheck(item, { ...ctxBase, keys: null })).toBe(false);
    expect(await confirmCheck(item, { ...ctxBase, keys: [{ public_key: "k", access_key: { nonce: 0, permission: "FullAccess" } }] })).toBe(false);
  });

  it("report-hash item follows reportOk", async () => {
    const item: CheckItem = { label: "h", href: null, kind: "report-hash" };
    expect(await confirmCheck(item, { ...ctxBase, reportOk: true })).toBe(true);
    expect(await confirmCheck(item, { ...ctxBase, reportOk: false })).toBe(false);
    expect(await confirmCheck(item, { ...ctxBase, reportOk: null })).toBe(false);
  });
});

describe("reportHashMatches", () => {
  it("true for report text and its hash", async () => {
    const hex = createHash("sha256").update(FIXTURE.renewal.reportText, "utf8").digest("hex");
    expect(hex).toBe(FIXTURE.renewal.reportHash);
    expect(await reportHashMatches(FIXTURE.renewal.reportText, hex)).toBe(true);
    expect(await reportHashMatches(FIXTURE.renewal.reportText, hex.toUpperCase())).toBe(true);
    expect(await reportHashMatches(FIXTURE.renewal.reportText + "x", hex)).toBe(false);
  });
});
