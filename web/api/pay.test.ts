import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_MAX_REQUEST, DEMO_MISSION, DEMO_SPEND_THRESHOLD, type LogEntry, type MandateView, type SpendRequest } from "@termwork/shared";
import { OutcomeUnknownError } from "../../signer/src/ops";
import { GitHubError } from "../../agent/src/sources/github";
import type { PullRequestFact } from "../../agent/src/sources/types";
import type { PaidInfo } from "./_lib/github-write";
import { handle, limiter, type PayDeps } from "./pay";

const T0 = Date.parse("2026-11-07T12:00:00Z");
const PR_URL = "https://github.com/o/r/pull/7";
const mandate: MandateView = {
  dao_id: "dao.testnet",
  mission: DEMO_MISSION,
  status: "Active",
  spend_threshold: DEMO_SPEND_THRESHOLD,
  max_request: DEMO_MAX_REQUEST,
  term_start_ms: 0,
  term_end_ms: T0 + 86_400_000,
  term_number: 1,
  agent_key: null,
  budget_total: "0",
  budget_spent: "0",
  budget_available: "0",
};
const fact = (o: Partial<PullRequestFact> = {}): PullRequestFact => ({
  url: PR_URL,
  number: 7,
  title: "Fix typo",
  author: "alice",
  firstTime: true,
  changedLines: 3,
  labels: [],
  mergedAt: "2026-11-05T10:00:00Z",
  nearAccount: "alice.testnet",
  ...o,
});
const proof = { accountId: "council.testnet", publicKey: "ed25519:x", signature: "s", message: "{}", nonce: "n" };
const decision = (amount: string, clause: number) => JSON.stringify({ qualifies: true, clause_id: clause, amount_near: amount, rationale: "good work" });
const RECEIPT = { model: "m", chatId: "c" };

type Calls = {
  verify: number;
  spend: unknown[];
  request: unknown[];
  label: PaidInfo[];
  exists: string[];
};

function mk(o: Partial<PayDeps> & { decisionText?: string; pr?: PullRequestFact | null; opsError?: unknown } = {}): PayDeps & { calls: Calls } {
  const calls: Calls = { verify: 0, spend: [], request: [], label: [], exists: [] };
  const d: PayDeps = {
    verifyCouncil: async () => {
      calls.verify++;
      return { ok: true, accountId: "council.testnet" };
    },
    getMergedPr: (async () => (o.pr === undefined ? fact() : o.pr)) as unknown as PayDeps["getMergedPr"],
    complete: (async () => ({ text: o.decisionText ?? decision("0.2", 2), receipt: RECEIPT, hash: "rh1" })) as unknown as PayDeps["complete"],
    getMandate: async () => mandate,
    getWorkLog: async () => [],
    getRequests: async () => [],
    accountExists: async (id) => {
      calls.exists.push(id);
      return true;
    },
    ops: () => ({
      spend: async (a) => {
        calls.spend.push(a);
        if (o.opsError) throw o.opsError;
        return { txHash: "TX1" };
      },
      request_spend: async (a) => {
        calls.request.push(a);
        if (o.opsError) throw o.opsError;
        return { txHash: "TX2" };
      },
    }),
    labelPaid: async (p) => {
      calls.label.push(p);
      return "labelled";
    },
    now: () => T0,
    secrets: ["sekret-key"],
    payable: new Set(["o/r"]),
    config: {
      privateKey: "ed25519:pk",
      mandateId: "m.testnet",
      daoId: "dao.testnet",
      apiKey: "k",
      model: "mod",
      githubToken: "gh",
      labelToken: "lt",
    },
    ...o,
  };
  return Object.assign(d, { calls });
}

const post = (b: Record<string, unknown> = {}, ip = "1.1.1.1") => ({
  method: "POST",
  body: JSON.stringify({ repo: "o/r", number: 7, range: { preset: "week" }, proof, ...b }),
  ip,
});
const body = (r: { json: unknown }) => r.json as any;
const noOps = (d: { calls: Calls }) => d.calls.spend.length + d.calls.request.length === 0;

let logged: string[] = [];
beforeEach(() => {
  limiter.reset();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((m: unknown) => void logged.push(String(m)));
});
afterEach(() => vi.restoreAllMocks());

describe("/api/pay", () => {
  it("rejects non-POST and oversized bodies", async () => {
    expect((await handle({ method: "GET", body: "", ip: "1" }, mk())).status).toBe(405);
    expect((await handle({ method: "POST", body: "", ip: "1", oversized: true }, mk())).status).toBe(413);
  });

  it("is 503 when a required setting is missing", async () => {
    for (const k of ["privateKey", "mandateId", "daoId", "apiKey", "model", "githubToken"] as const) {
      const d = mk();
      d.config = { ...d.config, [k]: "" };
      const r = await handle(post(), d);
      expect(r.status).toBe(503);
      expect(d.calls.verify).toBe(0);
    }
  });

  it("repo not in PAYABLE_REPOS gives 403 without verifying or paying", async () => {
    const d = mk({ payable: new Set(["other/repo"]) });
    const r = await handle(post(), d);
    expect(r.status).toBe(403);
    expect(d.calls.verify).toBe(0);
    expect(noOps(d)).toBe(true);
  });

  it("bad proof gives 401 and never pays", async () => {
    const d = mk({ verifyCouncil: async () => ({ ok: false, error: "invalid signature proof" }) });
    const r = await handle(post(), d);
    expect(r.status).toBe(401);
    expect(body(r).error).toBe("invalid signature proof");
    expect(noOps(d)).toBe(true);
  });

  it("verifies the proof with a fresh clock on every request", async () => {
    const seen: number[] = [];
    let t = T0;
    const d = mk({ now: () => (t += 1000), verifyCouncil: async (_p, now) => (seen.push(now), { ok: false, error: "x" }) });
    await handle(post(), d);
    await handle(post(), d);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]!);
  });

  it("body amount/recipient fields are rejected", async () => {
    for (const k of ["recipient", "amount", "clause_id"]) {
      const d = mk();
      const r = await handle(post({ [k]: "x" }), d);
      expect(r.status).toBe(400);
      expect(body(r).error).toBe(`unknown field: ${k}`);
      expect(d.calls.verify).toBe(0);
    }
  });

  it("rejects a bad repo, number or range with 400", async () => {
    expect((await handle(post({ repo: "nope" }), mk())).status).toBe(400);
    expect((await handle(post({ number: 0 }), mk())).status).toBe(400);
    expect((await handle(post({ number: "7" }), mk())).status).toBe(400);
    expect((await handle(post({ range: { preset: "year" } }), mk())).status).toBe(400);
    expect((await handle({ method: "POST", body: "{", ip: "1" }, mk())).status).toBe(400);
  });

  it("small reward: pays the PR's own account, then labels", async () => {
    const d = mk();
    const r = await handle(post(), d);
    expect(r.status).toBe(200);
    expect(d.calls.spend).toEqual([
      { recipient: "alice.testnet", amount: "200000000000000000000000", clause_id: 2, evidence_url: PR_URL, receipt_hash: "rh1" },
    ]);
    expect(d.calls.label).toEqual([{ repo: "o/r", number: 7, amountNear: "0.2", recipient: "alice.testnet", txHash: "TX1", receipt: RECEIPT, receiptHash: "rh1" }]);
    expect(body(r)).toEqual({ kind: "spend", txHash: "TX1", amountNear: "0.2", recipient: "alice.testnet", labelled: true });
  });

  it("skips labelling when no label token is configured", async () => {
    const d = mk();
    d.config = { ...d.config, labelToken: "" };
    const r = await handle(post(), d);
    expect(body(r)).toMatchObject({ kind: "spend", labelled: false });
    expect(d.calls.label).toHaveLength(0);
  });

  it("large reward: files a request for the DAO vote, no label", async () => {
    const d = mk({ decisionText: decision("0.5", 3), pr: fact({ labels: ["feature"] }) });
    const r = await handle(post(), d);
    expect(r.status).toBe(200);
    expect(d.calls.spend).toHaveLength(0);
    expect(d.calls.request).toEqual([
      {
        recipient: "alice.testnet",
        amount: "500000000000000000000000",
        clause_id: 3,
        evidence_url: PR_URL,
        receipt_hash: "rh1",
        rationale: "good work",
      },
    ]);
    expect(d.calls.label).toHaveLength(0);
    expect(body(r)).toEqual({ kind: "request", txHash: "TX2", amountNear: "0.5", recipient: "alice.testnet" });
  });

  it("a 5000-character rationale is cut to 2048 bytes", async () => {
    const text = JSON.stringify({ qualifies: true, clause_id: 3, amount_near: "0.5", rationale: "a".repeat(5000) });
    const d = mk({ decisionText: text, pr: fact({ labels: ["feature"] }) });
    expect((await handle(post(), d)).status).toBe(200);
    expect((d.calls.request[0] as { rationale: string }).rationale).toBe("a".repeat(2048));
  });

  it("a long multi-byte rationale is cut without splitting a character", async () => {
    // "x" (1 byte) then 2500 two-byte characters: 1 + 1023 * 2 = 2047 bytes is the longest whole fit.
    const text = JSON.stringify({ qualifies: true, clause_id: 3, amount_near: "0.5", rationale: "x" + "é".repeat(2500) });
    const d = mk({ decisionText: text, pr: fact({ labels: ["feature"] }) });
    expect((await handle(post(), d)).status).toBe(200);
    const sent = (d.calls.request[0] as { rationale: string }).rationale;
    expect(sent).toBe("x" + "é".repeat(1023));
    expect(Buffer.byteLength(sent, "utf8")).toBe(2047);
  });

  it("a NEAR RPC failure while checking the recipient gives 502, not a skip", async () => {
    const d = mk({
      accountExists: async () => {
        throw new Error("RPC HTTP 503 sekret-key");
      },
    });
    const r = await handle(post(), d);
    expect(r.status).toBe(502);
    expect(body(r)).toEqual({ error: "Could not check the recipient account on NEAR. Try again." });
    expect(noOps(d)).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("[redacted]");
    expect(logged[0]).not.toContain("sekret-key");
  });

  it("recipient account missing gives a skip and no payment", async () => {
    const d = mk({ accountExists: async () => false });
    const r = await handle(post(), d);
    expect(r.status).toBe(200);
    expect(body(r).kind).toBe("skip");
    expect(body(r).reason).toContain("does not exist");
    expect(noOps(d)).toBe(true);
  });

  it("already paid in work log gives 409", async () => {
    const paid: LogEntry = {
      index: 3,
      kind: "Paid",
      clause_id: 2,
      amount: "1",
      recipient: "alice.testnet",
      evidence_url: PR_URL,
      receipt_hash: "h",
      note: null,
      timestamp_ms: 0,
    };
    for (const kind of ["Paid", "PaidApproved"] as const) {
      const d = mk({ getWorkLog: async () => [{ ...paid, kind }] });
      const r = await handle(post(), d);
      expect(r.status).toBe(409);
      expect(body(r).error).toBe("already paid or pending");
      expect(noOps(d)).toBe(true);
    }
  });

  it("a pending request for the PR gives 409", async () => {
    const req: SpendRequest = {
      id: 1,
      recipient: "alice.testnet",
      amount: "1",
      clause_id: 3,
      evidence_url: PR_URL,
      receipt_hash: "h",
      rationale: "r",
      proposal_id: 4,
      state: "Pending",
    };
    const d = mk({ getRequests: async () => [req] });
    const r = await handle(post(), d);
    expect(r.status).toBe(409);
    expect(body(r).error).toBe("already paid or pending");
    expect(noOps(d)).toBe(true);
    // A cancelled request does not block.
    const d2 = mk({ getRequests: async () => [{ ...req, state: "Cancelled" }] });
    expect((await handle(post(), d2)).status).toBe(200);
  });

  it("concurrent duplicate: contract already paid gives 409", async () => {
    const d = mk({ opsError: new Error("Smart contract panicked: already paid") });
    const r = await handle(post(), d);
    expect(r.status).toBe(409);
    expect(body(r).error).toBe("already paid or pending");
    expect(d.calls.label).toHaveLength(0);
  });

  it("agent inactive or out of budget gives 409 with a plain message", async () => {
    const cases: [string, string][] = [
      ["agent is not active", "The agent is not active (expired or fired)."],
      ["Smart contract panicked: term ended", "The agent is not active (expired or fired)."],
      ["Smart contract panicked: insufficient budget", "The agent's budget is used up."],
    ];
    for (const [msg, want] of cases) {
      const r = await handle(post(), mk({ opsError: new Error(msg) }));
      expect(r.status).toBe(409);
      expect(body(r).error).toBe(want);
    }
  });

  it("an inactive or expired agent gives 409 before any model or ops call", async () => {
    const cases: MandateView[] = [
      { ...mandate, status: "Fired" as MandateView["status"] },
      { ...mandate, term_end_ms: T0 },
      { ...mandate, term_end_ms: T0 - 1 },
    ];
    for (const m of cases) {
      let completes = 0;
      const d = mk({
        getMandate: async () => m,
        complete: (async () => {
          completes++;
          return { text: decision("0.2", 2), receipt: RECEIPT, hash: "rh1" };
        }) as unknown as PayDeps["complete"],
      });
      const r = await handle(post(), d);
      expect(r.status).toBe(409);
      expect(body(r).error).toBe("The agent is not active (expired or fired).");
      expect(completes).toBe(0);
      expect(noOps(d)).toBe(true);
    }
  });

  it("a missing access key at send time gives 409", async () => {
    for (const msg of ["AccessKeyDoesNotExist { account_id: x }", "Can not sign transactions: no access key found"]) {
      const r = await handle(post(), mk({ opsError: new Error(msg) }));
      expect(r.status).toBe(409);
      expect(body(r).error).toBe("The agent is not active (expired or fired).");
    }
  });

  it("OutcomeUnknownError gives 504", async () => {
    const r = await handle(post(), mk({ opsError: new OutcomeUnknownError() }));
    expect(r.status).toBe(504);
    expect(body(r).error).toBe("outcome unknown, refresh before retrying");
  });

  it("any other send failure gives 502 with secrets scrubbed", async () => {
    const r = await handle(post(), mk({ opsError: new Error("boom sekret-key") }));
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).not.toContain("sekret-key");
    expect(logged).toEqual(["pay: send failed: boom [redacted]"]);
  });

  it("PR not found or not merged gives 404", async () => {
    const d = mk({ pr: null });
    const r = await handle(post(), d);
    expect(r.status).toBe(404);
    expect(noOps(d)).toBe(true);
  });

  it("PR merged outside range gives 404", async () => {
    const d = mk({ pr: fact({ mergedAt: "2026-10-01T10:00:00Z" }) });
    const r = await handle(post(), d);
    expect(r.status).toBe(404);
    expect(body(r).error).toContain("not merged in the chosen range");
    expect(noOps(d)).toBe(true);
  });

  it("range bounds are inclusive UTC dates", async () => {
    const range = { preset: "custom", from: "2026-11-05", to: "2026-11-05" };
    expect((await handle(post({ range }), mk({ pr: fact({ mergedAt: "2026-11-05T23:59:59Z" }) }))).status).toBe(200);
    expect((await handle(post({ range }), mk({ pr: fact({ mergedAt: "2026-11-06T00:00:00Z" }) }))).status).toBe(404);
  });

  it("GitHub rate limit gives 429", async () => {
    const d = mk({ getMergedPr: (async () => {
      throw new GitHubError(403, 30, "rate");
    }) as unknown as PayDeps["getMergedPr"] });
    const r = await handle(post(), d);
    expect(r.status).toBe(429);
    expect(body(r).retryAfterSec).toBe(30);
  });

  it("AI failure gives 502 and never pays", async () => {
    const d = mk({ complete: (async () => {
      throw new Error("down");
    }) as unknown as PayDeps["complete"] });
    const r = await handle(post(), d);
    expect(r.status).toBe(502);
    expect(noOps(d)).toBe(true);
  });

  it("label failure does not fail the payment", async () => {
    const d = mk({ labelPaid: async () => {
      throw new Error("GitHub 403");
    } });
    const r = await handle(post(), d);
    expect(r.status).toBe(200);
    expect(body(r)).toMatchObject({ kind: "spend", txHash: "TX1", labelled: false });
  });

  it("rate limits per IP", async () => {
    const d = mk({ verifyCouncil: async () => ({ ok: false, error: "x" }) });
    for (let i = 0; i < 30; i++) expect((await handle(post({}, "9.9.9.9"), d)).status).toBe(401);
    expect((await handle(post({}, "9.9.9.9"), d)).status).toBe(429);
  });
});
