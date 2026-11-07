import { beforeEach, describe, expect, it } from "vitest";
import type { LogEntry } from "@termwork/shared";
import { handle, limiter, resetCache, type PaidDeps } from "./paid";

const T0 = Date.parse("2026-11-07T12:00:00Z");
const MANDATE = "mandate.testnet";
const HASH = "5".repeat(44);

const entry = (o: Partial<LogEntry> = {}): LogEntry => ({
  index: 0,
  kind: "Paid",
  clause_id: 1,
  amount: "500000000000000000000000",
  recipient: "alice.testnet",
  evidence_url: "https://github.com/o/r/pull/7",
  receipt_hash: "rh",
  note: null,
  timestamp_ms: T0 - 1000,
  ...o,
});

type Mk = Partial<PaidDeps> & { log?: LogEntry[] };
function mk(o: Mk = {}): PaidDeps & { calls: { log: number; tx: string[]; title: string[] } } {
  const calls = { log: 0, tx: [] as string[], title: [] as string[] };
  return {
    calls,
    getWorkLog:
      o.getWorkLog ??
      (async () => {
        calls.log++;
        return o.log ?? [entry()];
      }),
    findPaidTx:
      o.findPaidTx ??
      (async (repo, n) => {
        calls.tx.push(`${repo}#${n}`);
        return HASH;
      }),
    getTitle:
      o.getTitle ??
      (async (repo, n) => {
        calls.title.push(`${repo}#${n}`);
        return "Fix the thing";
      }),
    now: o.now ?? (() => T0),
    payable: o.payable ?? new Set(["o/r"]),
    mandateId: o.mandateId ?? MANDATE,
    secrets: o.secrets,
  };
}
const get = (d: PaidDeps, method = "GET") => handle({ method, body: "", ip: "1.1.1.1" }, d);

beforeEach(() => {
  limiter.reset();
  resetCache();
});

describe("paid", () => {
  it("rejects other methods", async () => {
    const r = await get(mk(), "POST");
    expect(r.status).toBe(405);
    expect(r.headers?.Allow).toBe("GET");
  });

  it("503 when the mandate is not configured", async () => {
    expect((await get(mk({ mandateId: "" }))).status).toBe(503);
  });

  it("maps Paid to direct and PaidApproved to dao, newest first, with a formatted amount", async () => {
    const d = mk({
      log: [
        entry({ kind: "Paid", evidence_url: "https://github.com/o/r/pull/1", timestamp_ms: T0 - 5000 }),
        entry({ kind: "PaidApproved", evidence_url: "https://github.com/o/r/pull/2", timestamp_ms: T0 - 1000 }),
      ],
    });
    const r = await get(d);
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<Record<string, unknown>> }).items;
    expect(items.map((i) => [i.number, i.via])).toEqual([[2, "dao"], [1, "direct"]]);
    expect(items[0]).toEqual({
      prUrl: "https://github.com/o/r/pull/2",
      repo: "o/r",
      number: 2,
      title: "Fix the thing",
      recipient: "alice.testnet",
      amountNear: "0.5",
      via: "dao",
      timestampMs: T0 - 1000,
      txHash: HASH,
      fallbackHref: `https://testnet.nearblocks.io/address/${MANDATE}`,
    });
  });

  it("uses a null txHash and the fallback link when no paid comment is found", async () => {
    const r = await get(mk({ findPaidTx: async () => null }));
    const item = (r.json as { items: Array<Record<string, unknown>> }).items[0]!;
    expect(item.txHash).toBeNull();
    expect(item.fallbackHref).toBe(`https://testnet.nearblocks.io/address/${MANDATE}`);
  });

  it("excludes other repos, non-paid kinds and unparseable URLs; matches repos case-insensitively", async () => {
    const d = mk({
      log: [
        entry({ evidence_url: "https://github.com/x/y/pull/3" }),
        entry({ kind: "Rejected" as LogEntry["kind"], evidence_url: "https://github.com/o/r/pull/4" }),
        entry({ evidence_url: "not a url" }),
        entry({ evidence_url: null }),
        entry({ evidence_url: "https://github.com/O/R/pull/5" }),
      ],
    });
    const items = (await get(d)).json as { items: Array<{ number: number; repo: string }> };
    expect(items.items.map((i) => [i.repo, i.number])).toEqual([["O/R", 5]]);
  });

  it("a GitHub failure for one item leaves title and txHash null without failing the list", async () => {
    const d = mk({
      log: [entry({ evidence_url: "https://github.com/o/r/pull/1" }), entry({ evidence_url: "https://github.com/o/r/pull/2", timestamp_ms: T0 - 2000 })],
      findPaidTx: async (_r, n) => {
        if (n === 1) throw new Error("boom");
        return HASH;
      },
      getTitle: async (_r, n) => {
        if (n === 1) throw new Error("boom");
        return "ok";
      },
    });
    const r = await get(d);
    expect(r.status).toBe(200);
    const items = (r.json as { items: Array<{ number: number; title: string | null; txHash: string | null }> }).items;
    expect(items[0]).toMatchObject({ number: 1, title: null, txHash: null });
    expect(items[1]).toMatchObject({ number: 2, title: "ok", txHash: HASH });
  });

  it("502 when the chain cannot be read, and the failure is not cached", async () => {
    let fail = true;
    const d = mk({
      getWorkLog: async () => {
        if (fail) throw new Error("rpc down");
        return [entry()];
      },
    });
    expect((await get(d)).status).toBe(502);
    fail = false;
    expect((await get(d)).status).toBe(200);
  });

  it("serves a second call within 30 s from the cache, then refreshes", async () => {
    let t = T0;
    const d = mk({ now: () => t });
    await get(d);
    t += 29_000;
    await get(d);
    expect(d.calls.log).toBe(1);
    t += 2_000;
    await get(d);
    expect(d.calls.log).toBe(2);
  });

  it("rate limits per IP", async () => {
    const d = mk();
    for (let i = 0; i < 20; i++) expect((await get(d)).status).toBe(200);
    const r = await get(d);
    expect(r.status).toBe(429);
  });
});
