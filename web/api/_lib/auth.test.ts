import { KeyPair, KeyPairSigner } from "near-api-js";
import { describe, expect, it } from "vitest";
import { AUTH_RECIPIENT, verifyCouncil, type CouncilProof } from "./auth";

const NOW = 1_700_000_000_000;
const DAO = "dao.testnet";
const kp = KeyPair.fromRandom("ed25519");
const pub = kp.getPublicKey().toString();

async function signWith(key: KeyPair, message: string, nonce: Buffer, recipient: string, callbackUrl?: string): Promise<string> {
  const signed = await new KeyPairSigner(key).signNep413Message("alice.testnet", { message, recipient, nonce, callbackUrl });
  return Buffer.from(signed.signature).toString("base64");
}

async function proof(
  over: { ts?: number; recipient?: string; accountId?: string; nonce?: Buffer; signKey?: KeyPair; callbackUrl?: string } = {},
): Promise<CouncilProof> {
  const message = JSON.stringify({ action: "mission-dao-pay", ts: over.ts ?? NOW });
  const nonce = over.nonce ?? Buffer.alloc(32, 7);
  const signature = await signWith(over.signKey ?? kp, message, nonce, over.recipient ?? AUTH_RECIPIENT, over.callbackUrl);
  return {
    accountId: over.accountId ?? "alice.testnet",
    publicKey: pub,
    signature,
    message,
    nonce: nonce.toString("base64"),
    ...(over.callbackUrl === undefined ? {} : { callbackUrl: over.callbackUrl }),
  };
}

function deps(opts: { permission?: unknown; council?: string[]; keyMissing?: boolean } = {}) {
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const { params } = JSON.parse(init.body) as { params: { request_type: string; account_id: string; public_key?: string } };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (params.request_type === "view_access_key") {
      if (opts.keyMissing || params.public_key !== pub) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "access key does not exist", cause: { name: "UNKNOWN_ACCESS_KEY" } } }));
      }
      return reply({ nonce: 1, permission: opts.permission ?? "FullAccess" });
    }
    const policy = { roles: [{ kind: { Group: opts.council ?? ["alice.testnet"] } }] };
    return reply({ result: [...Buffer.from(JSON.stringify(policy))] });
  }) as unknown as typeof fetch;
  return { near: { rpcUrl: "http://rpc", fetchFn }, daoId: DAO, now: NOW };
}

describe("verifyCouncil", () => {
  it("accepts a valid proof from a council member", async () => {
    expect(await verifyCouncil(await proof(), deps())).toEqual({ ok: true, accountId: "alice.testnet" });
  });
  it("refuses an account that is not on the council", async () => {
    const r = await verifyCouncil(await proof(), deps({ council: ["bob.testnet"] }));
    expect(r).toEqual({ ok: false, error: "only council members can run payments" });
  });
  it("refuses a function-call key", async () => {
    const r = await verifyCouncil(await proof(), deps({ permission: { FunctionCall: { receiver_id: DAO, method_names: [], allowance: null } } }));
    expect(r.ok).toBe(false);
  });
  it("refuses a key that is not on the account", async () => {
    expect((await verifyCouncil(await proof(), deps({ keyMissing: true }))).ok).toBe(false);
  });
  it("accepts a proof signed over a callbackUrl (MyNearWallet)", async () => {
    const url = "https://example.app/path?x=1";
    expect(await verifyCouncil(await proof({ callbackUrl: url }), deps())).toEqual({ ok: true, accountId: "alice.testnet" });
  });
  it("refuses a proof signed with a callbackUrl but sent without it", async () => {
    const { callbackUrl: _drop, ...p } = await proof({ callbackUrl: "https://example.app/" });
    expect((await verifyCouncil(p, deps())).ok).toBe(false);
  });
  it("refuses a proof signed without a callbackUrl but sent with one, or with a different one", async () => {
    expect((await verifyCouncil({ ...(await proof()), callbackUrl: "https://example.app/" }, deps())).ok).toBe(false);
    expect((await verifyCouncil({ ...(await proof({ callbackUrl: "https://a.app/" })), callbackUrl: "https://b.app/" }, deps())).ok).toBe(false);
  });
  it("refuses an oversized callbackUrl", async () => {
    const big = "https://e.app/" + "a".repeat(2048);
    expect((await verifyCouncil(await proof({ callbackUrl: big }), deps())).ok).toBe(false);
  });
  it("refuses a ts older than 5 minutes, and one too far ahead", async () => {
    expect((await verifyCouncil(await proof({ ts: NOW - 300_001 }), deps())).ok).toBe(false);
    expect((await verifyCouncil(await proof({ ts: NOW + 300_001 }), deps())).ok).toBe(false);
    expect((await verifyCouncil(await proof({ ts: NOW - 300_000 }), deps())).ok).toBe(true);
  });
  it("refuses a wrong recipient", async () => {
    expect((await verifyCouncil(await proof({ recipient: "someone-else" }), deps())).ok).toBe(false);
  });
  it("refuses a tampered message", async () => {
    const p = await proof();
    const r = await verifyCouncil({ ...p, message: JSON.stringify({ action: "mission-dao-pay", ts: NOW + 1 }) }, deps());
    expect(r.ok).toBe(false);
  });
  it("refuses a signature from a different key", async () => {
    const r = await verifyCouncil(await proof({ signKey: KeyPair.fromRandom("ed25519") }), deps());
    expect(r.ok).toBe(false);
  });
  it("refuses a nonce that is not 32 bytes", async () => {
    const p = await proof();
    expect((await verifyCouncil({ ...p, nonce: Buffer.alloc(31, 7).toString("base64") }, deps())).ok).toBe(false);
  });
  it("refuses another action in the message", async () => {
    const message = JSON.stringify({ action: "other", ts: NOW });
    const nonce = Buffer.alloc(32, 7);
    const p = { ...(await proof()), message, signature: await signWith(kp, message, nonce, AUTH_RECIPIENT) };
    expect((await verifyCouncil(p, deps())).ok).toBe(false);
  });
  it("returns an error, never throws, on malformed bodies", async () => {
    const p0 = await proof();
    for (const bad of [null, undefined, 5, "x", {}, { ...p0, signature: 3 }, { ...p0, publicKey: "nope" }, { ...p0, message: "{" }, { ...p0, callbackUrl: 5 }, { ...p0, callbackUrl: "" }]) {
      const r = await verifyCouncil(bad, deps());
      expect(r.ok).toBe(false);
    }
  });
});
