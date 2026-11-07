import { createHash } from "node:crypto";
import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { AUTH_RECIPIENT, verifyCouncil, type CouncilProof } from "./auth";

const NOW = 1_700_000_000_000;
const DAO = "dao.testnet";
const kp = KeyPair.fromRandom("ed25519");
const pub = kp.getPublicKey().toString();

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}
function hashOf(message: string, nonce: Buffer, recipient: string): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2147484061);
  return createHash("sha256")
    .update(Buffer.concat([tag, borshString(message), nonce, borshString(recipient), Buffer.from([0])]))
    .digest();
}

function proof(over: { ts?: number; recipient?: string; accountId?: string; nonce?: Buffer; signKey?: KeyPair } = {}): CouncilProof {
  const message = JSON.stringify({ action: "mission-dao-pay", ts: over.ts ?? NOW });
  const nonce = over.nonce ?? Buffer.alloc(32, 7);
  const sig = (over.signKey ?? kp).sign(hashOf(message, nonce, over.recipient ?? AUTH_RECIPIENT)).signature;
  return {
    accountId: over.accountId ?? "alice.testnet",
    publicKey: pub,
    signature: Buffer.from(sig).toString("base64"),
    message,
    nonce: nonce.toString("base64"),
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
    expect(await verifyCouncil(proof(), deps())).toEqual({ ok: true, accountId: "alice.testnet" });
  });
  it("refuses an account that is not on the council", async () => {
    const r = await verifyCouncil(proof(), deps({ council: ["bob.testnet"] }));
    expect(r).toEqual({ ok: false, error: "only council members can run payments" });
  });
  it("refuses a function-call key", async () => {
    const r = await verifyCouncil(proof(), deps({ permission: { FunctionCall: { receiver_id: DAO, method_names: [], allowance: null } } }));
    expect(r.ok).toBe(false);
  });
  it("refuses a key that is not on the account", async () => {
    expect((await verifyCouncil(proof(), deps({ keyMissing: true }))).ok).toBe(false);
  });
  it("refuses a ts older than 5 minutes, and one too far ahead", async () => {
    expect((await verifyCouncil(proof({ ts: NOW - 300_001 }), deps())).ok).toBe(false);
    expect((await verifyCouncil(proof({ ts: NOW + 300_001 }), deps())).ok).toBe(false);
    expect((await verifyCouncil(proof({ ts: NOW - 300_000 }), deps())).ok).toBe(true);
  });
  it("refuses a wrong recipient", async () => {
    expect((await verifyCouncil(proof({ recipient: "someone-else" }), deps())).ok).toBe(false);
  });
  it("refuses a tampered message", async () => {
    const p = proof();
    const r = await verifyCouncil({ ...p, message: JSON.stringify({ action: "mission-dao-pay", ts: NOW + 1 }) }, deps());
    expect(r.ok).toBe(false);
  });
  it("refuses a signature from a different key", async () => {
    const r = await verifyCouncil(proof({ signKey: KeyPair.fromRandom("ed25519") }), deps());
    expect(r.ok).toBe(false);
  });
  it("refuses a nonce that is not 32 bytes", async () => {
    expect((await verifyCouncil(proof({ nonce: Buffer.alloc(31, 7) }), deps())).ok).toBe(false);
  });
  it("refuses another action in the message", async () => {
    const message = JSON.stringify({ action: "other", ts: NOW });
    const nonce = Buffer.alloc(32, 7);
    const sig = kp.sign(hashOf(message, nonce, AUTH_RECIPIENT)).signature;
    const p = { ...proof(), message, signature: Buffer.from(sig).toString("base64") };
    expect((await verifyCouncil(p, deps())).ok).toBe(false);
  });
  it("returns an error, never throws, on malformed bodies", async () => {
    for (const bad of [null, undefined, 5, "x", {}, { ...proof(), signature: 3 }, { ...proof(), publicKey: "nope" }, { ...proof(), message: "{" }]) {
      const r = await verifyCouncil(bad, deps());
      expect(r.ok).toBe(false);
    }
  });
});
