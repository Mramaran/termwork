import { beforeEach, describe, expect, it } from "vitest";
import type { LogEntry, SpendRequest } from "@termwork/shared";
import type { TxStatus } from "./_lib/near";
import type { PaidInfo } from "./_lib/github-write";
import { handle, limiter, type LabelDeps } from "./label";

const T0 = Date.parse("2026-11-07T12:00:00Z");
const PR_URL = "https://github.com/o/r/pull/7";
const HASH = "7".repeat(44);
const SENDER = "council.testnet";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

const tx = (o: { status?: TxStatus["status"]; receiver?: string; method?: string; args?: unknown; signer?: string } = {}): TxStatus => ({
  status: o.status ?? { SuccessValue: "" },
  transaction: {
    signer_id: o.signer ?? SENDER,
    receiver_id: o.receiver ?? "dao.testnet",
    actions: [{ FunctionCall: { method_name: o.method ?? "act_proposal", args: b64(o.args ?? { id: 7, action: "VoteApprove" }) } }],
  },
});
const request = (o: Partial<SpendRequest> = {}): SpendRequest => ({
  id: 1,
  recipient: "alice.testnet",
  amount: "500000000000000000000000",
  clause_id: 2,
  evidence_url: PR_URL,
  receipt_hash: "rh1",
  rationale: "r",
  proposal_id: 7,
  state: "Executed",
  ...o,
});
const paidLog: LogEntry[] = [{ kind: "PaidApproved", evidence_url: PR_URL } as unknown as LogEntry];

function mk(o: { tx?: TxStatus; requests?: SpendRequest[]; log?: LogEntry[]; payable?: string[] } = {}): LabelDeps & { labels: PaidInfo[] } {
  const labels: PaidInfo[] = [];
  return {
    labels,
    txStatus: async () => o.tx ?? tx(),
    getRequests: async () => o.requests ?? [request()],
    getWorkLog: async () => o.log ?? paidLog,
    labelPaid: async (p) => {
      labels.push(p);
      return "labelled";
    },
    now: () => T0,
    payable: new Set(o.payable ?? ["o/r"]),
    config: { mandateId: "m.testnet", daoId: "dao.testnet", labelToken: "tok" },
  };
}
const post = (body: unknown, ip = "1.1.1.1") => ({ method: "POST", body: JSON.stringify(body), ip });
const good = { repo: "o/r", number: 7, txHash: HASH, sender: SENDER };

beforeEach(() => limiter.reset());

describe("label", () => {
  it("labels when the tx executed the matching request", async () => {
    const d = mk();
    const res = await handle(post(good), d);
    expect(res).toEqual({ status: 200, json: { result: "labelled" } });
    expect(d.labels).toEqual([
      { repo: "o/r", number: 7, amountNear: "0.5", recipient: "alice.testnet", txHash: HASH, receipt: null, receiptHash: "rh1" },
    ]);
  });

  it("matches the PR url case-insensitively", async () => {
    const d = mk({ requests: [request({ evidence_url: "https://github.com/O/R/pull/7" })], log: [{ kind: "PaidApproved", evidence_url: "https://github.com/O/R/pull/7" } as unknown as LogEntry] });
    expect((await handle(post(good), d)).status).toBe(200);
  });

  const conflicts: Array<[string, Parameters<typeof mk>[0]]> = [
    ["tx failed", { tx: tx({ status: { Failure: {} } }) }],
    ["receiver not the DAO", { tx: tx({ receiver: "evil.testnet" }) }],
    ["signer is not the sender", { tx: tx({ signer: "other.testnet" }) }],
    ["wrong method", { tx: tx({ method: "add_proposal" }) }],
    ["not an approval", { tx: tx({ args: { id: 7, action: "VoteReject" } }) }],
    ["proposal for a different PR", { requests: [request({ evidence_url: "https://github.com/o/r/pull/8" })] }],
    ["request still Pending", { requests: [request({ state: "Pending" })] }],
    ["no PaidApproved log entry", { log: [] }],
  ];
  for (const [name, o] of conflicts)
    it(`${name} gives 409 and no label`, async () => {
      const d = mk(o);
      const res = await handle(post(good), d);
      expect(res).toEqual({ status: 409, json: { error: "payment not confirmed" } });
      expect(d.labels).toEqual([]);
    });

  it("repo not payable gives 403", async () => {
    const d = mk({ payable: [] });
    expect((await handle(post(good), d)).status).toBe(403);
    expect(d.labels).toEqual([]);
  });

  it("rejects bad input with 400", async () => {
    for (const b of [{ ...good, txHash: "abc" }, { ...good, sender: "Bad Name" }, { ...good, number: 0 }, { ...good, extra: 1 }, { ...good, repo: 5 }])
      expect((await handle(post(b), mk())).status).toBe(400);
  });

  it("503 when not configured, 405 on GET", async () => {
    const d = mk();
    d.config.labelToken = "";
    expect((await handle(post(good), d)).status).toBe(503);
    expect((await handle({ method: "GET", body: "", ip: "x" }, mk())).status).toBe(405);
  });

  it("502 when the chain cannot be read", async () => {
    const d = mk();
    d.txStatus = async () => {
      throw new Error("rpc down");
    };
    expect((await handle(post(good), d)).status).toBe(502);
  });
});
