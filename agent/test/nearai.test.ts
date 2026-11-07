import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { complete, type InferenceReceipt } from "../src/nearai.js";
import { receiptHash, saveReceipt, loadReplay } from "../src/receipts.js";

const MODEL = "test/model";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sk = secp256k1.utils.randomSecretKey();
const addr =
  "0x" + bytesToHex(keccak_256(secp256k1.getPublicKey(sk, false).slice(1)).slice(-20));

/** EIP-191 personal_sign, returns 0x r||s||v */
function personalSign(msg: string): string {
  const m = new TextEncoder().encode(msg);
  const h = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${m.length}`), ...m]));
  const rec = secp256k1.sign(h, sk, { prehash: false, format: "recovered" });
  return "0x" + bytesToHex(rec.slice(1)) + (27 + rec[0]!).toString(16);
}

function mockNet(opts: { ownedBy?: string; echoNonce?: boolean } = {}) {
  const { ownedBy = "nearai", echoNonce = true } = opts;
  const calls: string[] = [];
  let body = "";
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
    if (u.endsWith("/v1/models")) return json({ data: [{ id: MODEL, owned_by: ownedBy }] });
    if (u.endsWith("/v1/chat/completions")) {
      body = JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { role: "assistant", content: "PAY" } }] });
      (fn as any).reqBody = String(init?.body);
      return new Response(body, { status: 200 });
    }
    if (u.includes("/v1/signature/chatcmpl-1")) {
      const text = `${MODEL}:${sha((fn as any).reqBody)}:${sha(body)}`;
      return json({ text, signature: personalSign(text), signing_address: addr, signing_algo: "ecdsa", signature_kind: "provider_tee" });
    }
    if (u.includes("/v1/attestation/report")) {
      const nonce = new URL(u).searchParams.get("nonce");
      return json({
        gateway_attestation: { request_nonce: echoNonce ? nonce : "00".repeat(32) },
        model_attestations: [{ signing_address: addr, request_nonce: echoNonce ? nonce : "00".repeat(32) }],
      });
    }
    return new Response("nope", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

const msgs = [{ role: "user" as const, content: "decide" }];
const opts = { model: MODEL };

afterEach(() => vi.unstubAllGlobals());

/** Replace the signature response with the output of `f`. */
function tamperSig(f: (j: any, ctx: { sha: (s: string) => string; req: string; body: string }) => unknown) {
  const fn = mockNet().fn;
  const orig = fn.getMockImplementation()!;
  let req = "";
  let body = "";
  fn.mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v1/chat/completions")) req = String(init?.body);
    const res = await orig(url, init);
    if (u.endsWith("/v1/chat/completions")) {
      body = await res.clone().text();
    }
    if (u.includes("/v1/signature/")) {
      const j = await res.json();
      return new Response(JSON.stringify(f(j, { sha, req, body })));
    }
    return res;
  });
}

const sample = (): InferenceReceipt => ({
  model: MODEL, requestBody: "{}", responseText: JSON.stringify({ choices: [{ message: { content: "SKIP" } }] }),
  chatId: "c", signature: {}, attestation: {}, nonce: "ab", verified: true, verifiedScope: "response-signature+model+nonce", mode: "live", createdAt: "2026-01-01T00:00:00Z",
});

describe("receipts", () => {
  it("hash is stable across key order", () => {
    const a = sample();
    const b = JSON.parse(JSON.stringify(a, Object.keys(a).sort().reverse())) as InferenceReceipt;
    expect(Object.keys(b)).not.toEqual(Object.keys(a));
    expect(receiptHash(a)).toBe(receiptHash(b));
    expect(receiptHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptHash({ ...a, verified: false })).not.toBe(receiptHash(a));
  });

  it("save then loadReplay round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-"));
    const r = sample();
    const hash = saveReceipt(r, dir, "https://github.com/o/r/pull/1");
    expect(hash).toBe(receiptHash(r));
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))["https://github.com/o/r/pull/1"]).toBe(hash);
    const got = loadReplay("https://github.com/o/r/pull/1", dir)!;
    expect(got.hash).toBe(hash);
    expect(got.text).toBe("SKIP");
    expect(got.mode).toBe("replay");
    expect(receiptHash(got.receipt)).toBe(got.hash);
    expect(loadReplay("missing", dir)).toBeNull();
  });

  it("replay makes no fetch calls", () => {
    const { fn } = mockNet();
    const dir = mkdtempSync(join(tmpdir(), "rc-"));
    saveReceipt(sample(), dir, "renewal:2");
    expect(loadReplay("renewal:2", dir)?.mode).toBe("replay");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("complete", () => {
  it("verifies signature and nonce", async () => {
    const { calls } = mockNet();
    const out = await complete(msgs, "k", opts);
    expect(out.text).toBe("PAY");
    expect(out.receipt.verified).toBe(true);
    expect(out.receipt.mode).toBe("live");
    expect(out.receipt.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(out.hash).toBe(receiptHash(out.receipt));
    expect(calls.some((c) => c.includes("/v1/attestation/report") && c.includes(`nonce=${out.receipt.nonce}`))).toBe(true);
  });

  it("rejects non-nearai model", async () => {
    const { calls } = mockNet({ ownedBy: "someone" });
    await expect(complete(msgs, "k", opts)).rejects.toThrow(/owned_by/);
    expect(calls.some((c) => c.includes("chat/completions"))).toBe(false);
  });

  it("allows non-nearai model only with the override, unverified", async () => {
    mockNet({ ownedBy: "someone" });
    const out = await complete(msgs, "k", { ...opts, allowUnverified: true });
    expect(out.receipt.verified).toBe(false);
  });

  it("verified false when nonce mismatch", async () => {
    mockNet({ echoNonce: false });
    const out = await complete(msgs, "k", opts);
    expect(out.receipt.verified).toBe(false);
  });

  it("gateway signature is not verified", async () => {
    tamperSig((j, ctx) => {
      const text = `${ctx.sha(ctx.req)}:${ctx.sha(ctx.body)}`;
      return { ...j, text, signature: personalSign(text), signature_kind: "gateway" };
    });
    expect((await complete(msgs, "k", opts)).receipt.verified).toBe(false);
  });

  it("wrong model in signed text is not verified", async () => {
    tamperSig((j, ctx) => {
      const text = `other/model:${ctx.sha(ctx.req)}:${ctx.sha(ctx.body)}`;
      return { ...j, text, signature: personalSign(text) };
    });
    expect((await complete(msgs, "k", opts)).receipt.verified).toBe(false);
  });

  it("tampered response body is not verified", async () => {
    tamperSig((j, ctx) => {
      const text = `${MODEL}:${ctx.sha(ctx.req)}:${ctx.sha(ctx.body + " ")}`;
      return { ...j, text, signature: personalSign(text) };
    });
    expect((await complete(msgs, "k", opts)).receipt.verified).toBe(false);
  });

  it("malformed signature is not verified", async () => {
    tamperSig((j) => ({ ...j, signature: "0x1234" }));
    expect((await complete(msgs, "k", opts)).receipt.verified).toBe(false);
  });

  it("non-JSON completion body gives a clear error", async () => {
    const fn = mockNet().fn;
    const orig = fn.getMockImplementation()!;
    fn.mockImplementation(async (url, init) =>
      String(url).endsWith("/v1/chat/completions") ? new Response("<html>", { status: 200 }) : orig(url, init));
    await expect(complete(msgs, "k", opts)).rejects.toThrow(/not valid JSON/);
  });

  it("verified false when signature is by another key", async () => {
    const fn = mockNet().fn;
    const orig = fn.getMockImplementation()!;
    fn.mockImplementation(async (url, init) => {
      const res = await orig(url, init);
      if (String(url).includes("/v1/attestation/report")) {
        const j = (await res.json()) as any;
        j.model_attestations[0].signing_address = "0x" + "11".repeat(20);
        return new Response(JSON.stringify(j));
      }
      return res;
    });
    expect((await complete(msgs, "k", opts)).receipt.verified).toBe(false);
  });
});

describe("complete request body", () => {
  it("asks the model not to reason at length, so decisions return in seconds", async () => {
    const { fn } = mockNet();
    await complete(msgs, "k", opts);
    expect(JSON.parse((fn as any).reqBody).reasoning_effort).toBe("none");
  });

  it("asks for temperature 0 so the same pull request gets the same decision", async () => {
    const { fn } = mockNet();
    await complete(msgs, "k", opts);
    expect(JSON.parse((fn as any).reqBody).temperature).toBe(0);
  });
});
