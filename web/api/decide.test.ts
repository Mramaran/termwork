import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { handle, type DecideDeps } from "./decide";
import { _resetLimits } from "./limits";

const SENTINEL = "sk-test-SENTINEL-1234567890";
const T0 = 1_700_000_000_000;

function fakeComplete(decision: object): DecideDeps["complete"] {
  return (async () => ({
    text: JSON.stringify(decision),
    receipt: {
      model: "m",
      requestBody: "{}",
      responseText: "{}",
      chatId: "c1",
      signature: null,
      attestation: null,
      nonce: "n",
      verified: true,
      verifiedScope: "response-signature+model+nonce",
      mode: "live",
      createdAt: "2026-11-06T00:00:00.000Z",
    },
    hash: "abc123",
  })) as DecideDeps["complete"];
}

const base = { title: "Fix typo", changedLines: 3, feature: false, firstTime: true, nearAccount: "alice.testnet" };
const post = (b: unknown, ip = "1.1.1.1") => ({ method: "POST", body: typeof b === "string" ? b : JSON.stringify(b), ip });
const deps = (c: DecideDeps["complete"] = fakeComplete({ qualifies: true, clause_id: 2, amount_near: "0.2", rationale: "ok" })): DecideDeps => ({
  complete: c,
  now: () => T0,
  secrets: [SENTINEL],
  apiKey: SENTINEL,
  model: "m",
});

beforeEach(() => {
  _resetLimits();
  process.env.NEARAI_API_KEY = SENTINEL;
});
afterEach(() => {
  delete process.env.NEARAI_API_KEY;
});

describe("/api/decide", () => {
  it("rejects non-POST", async () => {
    expect((await handle({ method: "GET", body: "", ip: "1.1.1.1" }, deps())).status).toBe(405);
  });
  it("rejects oversized body", async () => {
    const r = await handle(post({ ...base, title: "x".repeat(2100) }), deps());
    expect(r.status).toBe(413);
  });
  it("rejects bad account", async () => {
    const r = await handle(post({ ...base, nearAccount: "Not A Valid Account!" }), deps());
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ field: "nearAccount" });
  });
  it("rejects out-of-range lines", async () => {
    const r = await handle(post({ ...base, changedLines: 100001 }), deps());
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ field: "changedLines" });
    expect((await handle(post({ ...base, changedLines: 1.5 }), deps())).status).toBe(400);
  });
  it("rejects unknown fields", async () => {
    const r = await handle(post({ ...base, extra: 1 }), deps());
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ field: "extra" });
  });
  it("rejects invalid json", async () => {
    expect((await handle(post("{nope"), deps())).status).toBe(400);
  });
  it("small first-time fix → would pay 0.2", async () => {
    const r = await handle(post(base), deps());
    expect(r.status).toBe(200);
    const j = r.json as any;
    expect(j.result).toBe("would pay");
    expect(j.amountNear).toBe("0.2");
    expect(j.receiptHash).toBe("abc123");
    expect(j.answer.clause_id).toBe(2);
    expect(j.rules.every((x: any) => x.pass)).toBe(true);
    expect(j.rules).toContainEqual({ rule: "recipient exists on-chain", pass: true, note: "skipped in the playground" });
  });
  it("feature 340 lines → would go to a DAO vote", async () => {
    const c = fakeComplete({ qualifies: true, clause_id: 3, amount_near: "0.5", rationale: "big" });
    const r = await handle(post({ ...base, changedLines: 340, feature: true }), deps(c));
    const j = r.json as any;
    expect(j.result).toBe("would go to a DAO vote");
    expect(j.amountNear).toBe("0.5");
  });
  it("repeat contributor → would skip with rule \"first-time contributor\" failing", async () => {
    const r = await handle(post({ ...base, firstTime: false }), deps());
    const j = r.json as any;
    expect(j.result).toBe("would skip");
    expect(j.rules.find((x: any) => x.rule === "first-time contributor").pass).toBe(false);
  });
  it("returns 502 with message when complete() throws, redacting the key", async () => {
    const c = (async () => {
      throw new Error(`Chat completion request failed: 500 Bearer ${SENTINEL}`);
    }) as DecideDeps["complete"];
    const r = await handle(post(base), deps(c));
    expect(r.status).toBe(502);
    expect((r.json as any).error).toBe("The AI request failed. Try again in a minute.");
    expect(JSON.stringify(r.json)).not.toContain(SENTINEL);
  });
  it("sixth request in a minute from one IP → 429", async () => {
    for (let i = 0; i < 5; i++) expect((await handle(post(base), deps())).status).toBe(200);
    const r = await handle(post(base), deps());
    expect(r.status).toBe(429);
    expect((r.json as any).retryAfterSec).toBeGreaterThan(0);
    expect((await handle(post(base, "2.2.2.2"), deps())).status).toBe(200);
  });
  it("response never contains the API key", async () => {
    const leaky = (async () => ({
      text: JSON.stringify({ qualifies: true, clause_id: 2, amount_near: "0.2", rationale: `key ${SENTINEL}` }),
      receipt: { model: "m", requestBody: `Bearer ${SENTINEL}`, responseText: "{}", chatId: "c", signature: null, attestation: null, nonce: "n", verified: true, verifiedScope: "none", mode: "live", createdAt: "x" },
      hash: "h",
    })) as DecideDeps["complete"];
    for (const r of [await handle(post(base), deps()), await handle(post(base), deps(leaky)), await handle(post({ ...base, changedLines: -1 }), deps())]) {
      expect(JSON.stringify(r.json)).not.toContain(SENTINEL);
    }
  });

  const rulesOf = async (d: object, extra: object = {}) =>
    ((await handle(post({ ...base, ...extra }), deps(fakeComplete(d)))).json as any).rules as { rule: string; pass: boolean }[];

  it("rationale mentioning amount does not mark amount rules", async () => {
    const r = await rulesOf({ qualifies: false, clause_id: 1, amount_near: "0", rationale: "amount exceeds clause maximum, max_request" });
    expect(r.map((x) => x.rule)).toEqual(["decision well-formed", "model says it qualifies"]);
    expect(r[1]!.pass).toBe(false);
  });
  it("zero amount fails the amount rule", async () => {
    const r = await rulesOf({ qualifies: true, clause_id: 2, amount_near: "0", rationale: "x" });
    expect(r[r.length - 1]).toEqual({ rule: "amount above zero and within the clause maximum", pass: false });
  });
  it("malformed amount fails the well-formed rule", async () => {
    const r = await rulesOf({ qualifies: true, clause_id: 2, amount_near: "abc", rationale: "x" });
    expect(r).toEqual([{ rule: "decision well-formed", pass: false }]);
  });
  it("rules stop at the first failure", async () => {
    const r = await rulesOf({ qualifies: true, clause_id: 2, amount_near: "0.2", rationale: "x" }, { firstTime: false, nearAccount: "" });
    expect(r.map((x) => x.rule)).toEqual(["decision well-formed", "model says it qualifies", "first-time contributor"]);
    expect(r[2]!.pass).toBe(false);
  });
  it("result matches validate for the 3 presets", async () => {
    const cases: [object, object, string][] = [
      [base, { qualifies: true, clause_id: 2, amount_near: "0.2", rationale: "r" }, "would pay"],
      [{ ...base, changedLines: 340, feature: true }, { qualifies: true, clause_id: 3, amount_near: "0.5", rationale: "r" }, "would go to a DAO vote"],
      [{ ...base, firstTime: false }, { qualifies: true, clause_id: 2, amount_near: "0.2", rationale: "r" }, "would skip"],
    ];
    for (const [input, d, want] of cases) {
      const j = (await handle(post(input), deps(fakeComplete(d)))).json as any;
      expect(j.result).toBe(want);
      if (want !== "would skip") expect(j.rules.every((x: any) => x.pass)).toBe(true);
      else expect(j.rules.some((x: any) => !x.pass)).toBe(true);
    }
  });
  it("503 when not configured, without calling upstream", async () => {
    let called = false;
    const c = (async () => { called = true; throw new Error("x"); }) as DecideDeps["complete"];
    const r = await handle(post(base), { ...deps(c), apiKey: "" });
    expect(r.status).toBe(503);
    expect(called).toBe(false);
  });
  it("405 carries Allow: POST and oversized flag gives 413", async () => {
    const r = await handle({ method: "GET", body: "", ip: "1.1.1.1" }, deps());
    expect(r.headers).toEqual({ Allow: "POST" });
    expect((await handle({ ...post(base), oversized: true }, deps())).status).toBe(413);
  });
});
