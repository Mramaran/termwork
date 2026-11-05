import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Account, KeyPair, KeyPairSigner, baseEncode } from "near-api-js";
import { buildOps, ValidationError, type AccountLike, type Ops } from "../src/ops.js";
import { loadConfig } from "@termwork/shared";
import { createSignerServer, listenLocal } from "../src/server.js";

const TOKEN = "test-token-not-secret-0123456789";
const SECRET_KEY = KeyPair.fromRandom("ed25519").toString();
const MANDATE = "mandate.testnet";

function mockAccount() {
  const calls: any[] = [];
  const account: AccountLike = {
    accountId: MANDATE,
    callFunctionRaw: vi.fn(async (p: any) => {
      calls.push(p);
      return { transaction: { hash: "HASH" + calls.length }, status: { SuccessValue: "" } } as any;
    }),
  };
  return { account, calls };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  vi.restoreAllMocks();
});

async function start(ops: Ops, secrets: string[] = [TOKEN, SECRET_KEY]) {
  const server = createSignerServer(ops, { token: TOKEN, secrets });
  await listenLocal(server, 0);
  servers.push(server);
  const { address, port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, token: string | null = TOKEN) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  return { server, address, post };
}

const goodSpend = {
  recipient: "vendor.testnet",
  amount: "1000000000000000000000000",
  clause_id: 1,
  evidence_url: "https://example.com/invoice/1",
  receipt_hash: "abc123",
};

describe("signer", () => {
  it("rejects unknown route", async () => {
    const { account } = mockAccount();
    const { post } = await start(buildOps(account));
    const res = await post("/sign_anything", {});
    expect(res.status).toBe(404);
  });

  it("rejects missing token", async () => {
    const { account, calls } = mockAccount();
    const { post } = await start(buildOps(account));
    expect((await post("/spend", goodSpend, null)).status).toBe(401);
    expect((await post("/spend", goodSpend, "wrong")).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("validates account id", async () => {
    const { account, calls } = mockAccount();
    const { post } = await start(buildOps(account));
    for (const bad of ["", "A.testnet", "a", "bad..id", "-x.testnet", "has space.testnet", "x".repeat(65)]) {
      const res = await post("/spend", { ...goodSpend, recipient: bad });
      expect(res.status, `recipient ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(calls).toHaveLength(0);
    const ok = await post("/spend", { ...goodSpend, recipient: "ab" });
    expect(ok.status).toBe(200);
  });

  it("validates amount is decimal yocto string", async () => {
    const { account, calls } = mockAccount();
    const { post } = await start(buildOps(account));
    for (const bad of ["0", "-5", "1.5", "1e24", "0x10", "", " 5", 5, null, "00"]) {
      const res = await post("/spend", { ...goodSpend, amount: bad });
      expect(res.status, `amount ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(calls).toHaveLength(0);
    expect((await post("/request_spend", { ...goodSpend, rationale: "r", amount: "7" })).status).toBe(200);
  });

  it("validates https evidence url", async () => {
    const { account, calls } = mockAccount();
    const { post } = await start(buildOps(account));
    for (const bad of ["http://example.com/x", "ftp://x.com", "javascript:alert(1)", "not a url", ""]) {
      const res = await post("/spend", { ...goodSpend, evidence_url: bad });
      expect(res.status, `url ${bad}`).toBe(400);
    }
    expect((await post("/log_work", { clause_id: 0, summary: "s", evidence_url: "http://x.com" })).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await post("/log_work", { clause_id: 0, summary: "s", evidence_url: null })).status).toBe(200);
  });

  it("validates clause id, report size and unknown fields", async () => {
    const { account } = mockAccount();
    const { post } = await start(buildOps(account));
    expect((await post("/spend", { ...goodSpend, clause_id: 256 })).status).toBe(400);
    expect((await post("/spend", { ...goodSpend, clause_id: -1 })).status).toBe(400);
    expect((await post("/spend", { ...goodSpend, clause_id: 1.5 })).status).toBe(400);
    expect((await post("/spend", { ...goodSpend, extra: 1 })).status).toBe(400);
    const renew = { report_text: "r", requested_term_secs: 3600, requested_topup: "10" };
    expect((await post("/propose_renewal", { ...renew, report_text: "é".repeat(2049) })).status).toBe(400);
    expect((await post("/propose_renewal", { ...renew, report_text: "é".repeat(2048) })).status).toBe(200);
  });

  it("calls the mandate with explicit gas and zero deposit", async () => {
    const { account, calls } = mockAccount();
    const { post } = await start(buildOps(account));
    const tgas = (n: number) => BigInt(n) * 10n ** 12n;
    const r1 = await post("/spend", goodSpend);
    expect(await r1.json()).toEqual({ txHash: "HASH1" });
    await post("/request_spend", { ...goodSpend, rationale: "why" });
    await post("/log_work", { clause_id: 2, summary: "did it" });
    await post("/propose_renewal", { report_text: "r", requested_term_secs: 60, requested_topup: "5" });
    await post("/expire", {});
    expect(calls.map((c) => [c.contractId, c.methodName, c.gas, c.deposit])).toEqual([
      [MANDATE, "spend", tgas(30), 0n],
      [MANDATE, "request_spend", tgas(100), 0n],
      [MANDATE, "log_work", tgas(30), 0n],
      [MANDATE, "propose_renewal", tgas(100), 0n],
      [MANDATE, "expire", tgas(30), 0n],
    ]);
    expect(calls[2].args).toEqual({ clause_id: 2, summary: "did it", evidence_url: null, receipt_hash: null });
    expect(calls[4].args).toEqual({});
  });

  it("returns 502 with rpcError on chain failure", async () => {
    const account: AccountLike = {
      accountId: MANDATE,
      callFunctionRaw: vi.fn(async () => {
        throw new Error("Smart contract panicked: mandate not active");
      }),
    };
    const { post } = await start(buildOps(account));
    const res = await post("/expire", {});
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string; rpcError: string };
    expect(body.error).toBeTruthy();
    expect(body.rpcError).toContain("mandate not active");
  });

  it("never includes key in responses or logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const account: AccountLike = {
      accountId: MANDATE,
      callFunctionRaw: vi.fn(async () => {
        throw new Error(`rpc exploded while holding ${SECRET_KEY} and bearer ${TOKEN}`);
      }),
    };
    const { post } = await start(buildOps(account));
    const bodies: string[] = [];
    for (const [path, body] of [
      ["/spend", goodSpend],
      ["/expire", {}],
      ["/spend", { ...goodSpend, amount: "bad" }],
    ] as const) {
      const res = await post(path, body);
      bodies.push(await res.text());
    }
    bodies.push(await (await post("/spend", goodSpend, "wrong-token-value")).text());
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))).join("\n");
    for (const text of [...bodies, logged]) {
      expect(text).not.toContain(SECRET_KEY);
      expect(text).not.toContain(SECRET_KEY.replace("ed25519:", ""));
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("wrong-token-value");
    }
  });

  it("refetches nonce for every call", async () => {
    let nonce = 10n;
    const provider = {
      viewAccessKey: vi.fn(async () => ({ nonce, permission: "FullAccess", block_height: 1, block_hash: "x" })),
      viewBlock: vi.fn(async () => ({ header: { hash: baseEncode(new Uint8Array(32).fill(7)) } })),
      sendTransactionUntil: vi.fn(async () => ({
        transaction: { hash: "TXHASH" },
        status: { SuccessValue: "" },
        final_execution_status: "EXECUTED_OPTIMISTIC",
      })),
    };
    const signer = KeyPairSigner.fromSecretKey(SECRET_KEY as any);
    // A shared Account would cache the nonce internally; the signer must build a fresh one per call.
    const ops = buildOps(() => new Account(MANDATE, provider as any, signer));
    await ops.expire({});
    expect(provider.viewAccessKey).toHaveBeenCalledTimes(1);
    // Simulate renew: the key is re-added and its nonce resets on chain.
    nonce = 3n;
    await ops.expire({});
    expect(provider.viewAccessKey).toHaveBeenCalledTimes(2);
    await ops.log_work({ clause_id: 0, summary: "x" });
    expect(provider.viewAccessKey).toHaveBeenCalledTimes(3);
    const sent = provider.sendTransactionUntil.mock.calls.map((c: any) => c[0].transaction.nonce);
    expect(sent).toEqual([11n, 4n, 4n]);
  });

  it("serialises concurrent calls", async () => {
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = {
      viewAccessKey: vi.fn(async () => {
        events.push("nonce");
        return { nonce: 1n, permission: "FullAccess", block_height: 1, block_hash: "x" };
      }),
      viewBlock: vi.fn(async () => ({ header: { hash: baseEncode(new Uint8Array(32).fill(7)) } })),
      sendTransactionUntil: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push("send-start");
        await new Promise((r) => setTimeout(r, 20));
        events.push("send-end");
        inFlight--;
        return { transaction: { hash: "T" }, status: { SuccessValue: "" }, final_execution_status: "EXECUTED_OPTIMISTIC" };
      }),
    };
    const signer = KeyPairSigner.fromSecretKey(SECRET_KEY as any);
    const ops = buildOps(() => new Account(MANDATE, provider as any, signer));
    const results = await Promise.all([ops.expire({}), ops.expire({}), ops.log_work({ clause_id: 0, summary: "x" })]);
    expect(results.map((r) => r.txHash)).toEqual(["T", "T", "T"]);
    expect(maxInFlight).toBe(1);
    expect(events).toEqual(["nonce", "send-start", "send-end", "nonce", "send-start", "send-end", "nonce", "send-start", "send-end"]);
  });

  it("keeps serving after a failed call in the queue", async () => {
    let n = 0;
    const account: AccountLike = {
      accountId: MANDATE,
      callFunctionRaw: vi.fn(async () => {
        if (n++ === 0) throw new Error("boom");
        return { transaction: { hash: "OK" } } as any;
      }),
    };
    const ops = buildOps(account);
    const [a, b] = await Promise.allSettled([ops.expire({}), ops.expire({})]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
  });

  it("rejects non-testnet network", () => {
    expect(() => loadConfig({ NEAR_NETWORK: "mainnet" })).toThrow(/testnet/);
    expect(() => loadConfig({ NEAR_NETWORK: "" })).toThrow(/testnet/);
    expect(loadConfig({}).NEAR_NETWORK).toBe("testnet");
  });

  it("rejects wrong method (405) and oversized body (413)", async () => {
    const { account } = mockAccount();
    const { address, post } = await start(buildOps(account));
    const port = (servers[0]!.address() as AddressInfo).port;
    const get = await fetch(`http://${address}:${port}/spend`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    const big = await post("/log_work", { clause_id: 0, summary: "x".repeat(70 * 1024) });
    expect(big.status).toBe(413);
  });

  it("binds to 127.0.0.1", async () => {
    const { account } = mockAccount();
    const { address } = await start(buildOps(account));
    expect(address).toBe("127.0.0.1");
  });

  it("exposes a ValidationError type", () => {
    expect(new ValidationError("x")).toBeInstanceOf(Error);
  });
});
