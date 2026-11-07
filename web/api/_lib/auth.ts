import { createHash } from "node:crypto";
import { PublicKey } from "near-api-js";
import { AUTH_ACTION, AUTH_MAX_SKEW_MS, AUTH_RECIPIENT, type CouncilProof } from "../../src/authConst";
import { accessKeyPermission, councilMembers, type NearDeps } from "./near";

export { AUTH_RECIPIENT, type CouncilProof };

export type CouncilResult = { ok: true; accountId: string } | { ok: false; error: string };

const NEP413_TAG = 2147484061;
const MAX_CALLBACK_URL = 2048;
const BAD_PROOF = "invalid signature proof";
const fail = (error: string): CouncilResult => ({ ok: false, error });

const borshString = (s: string): Buffer => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

/** sha256 of the NEP-413 payload; callbackUrl is Option<String> (0x00 None, 0x01 + string). */
function nep413Hash(message: string, nonce: Buffer, recipient: string, callbackUrl?: string): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  return createHash("sha256")
    .update(Buffer.concat([tag, borshString(message), nonce, borshString(recipient), callbackUrl === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)])]))
    .digest();
}

const isProof = (p: unknown): p is CouncilProof => {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return ["accountId", "publicKey", "signature", "message", "nonce"].every((k) => typeof o[k] === "string" && (o[k] as string).length > 0);
};

/** Checks a NEP-413 signed message: fresh, signed by a full-access key of a DAO council member. */
export async function verifyCouncil(p: unknown, d: { near: NearDeps; daoId: string; now: number }): Promise<CouncilResult> {
  try {
    if (!isProof(p)) return fail(BAD_PROOF);
    const nonce = Buffer.from(p.nonce, "base64");
    if (nonce.length !== 32) return fail(BAD_PROOF);

    let parsed: { action?: unknown; ts?: unknown };
    try {
      parsed = JSON.parse(p.message) as typeof parsed;
    } catch {
      return fail(BAD_PROOF);
    }
    const cb = (p as { callbackUrl?: unknown }).callbackUrl;
    if (cb !== undefined && (typeof cb !== "string" || cb.length === 0 || cb.length > MAX_CALLBACK_URL)) return fail(BAD_PROOF);
    if (!parsed || parsed.action !== AUTH_ACTION || typeof parsed.ts !== "number" || !Number.isFinite(parsed.ts)) return fail(BAD_PROOF);
    if (Math.abs(d.now - parsed.ts) > AUTH_MAX_SKEW_MS) return fail("signature expired, sign again");

    let valid: boolean;
    try {
      valid = PublicKey.fromString(p.publicKey).verify(nep413Hash(p.message, nonce, AUTH_RECIPIENT, cb), Buffer.from(p.signature, "base64"));
    } catch {
      return fail(BAD_PROOF);
    }
    if (!valid) return fail(BAD_PROOF);

    let permission: unknown;
    try {
      permission = await accessKeyPermission(d.near, p.accountId, p.publicKey);
    } catch {
      return fail("that key does not belong to the account");
    }
    if (permission !== "FullAccess") return fail("sign with a full-access key");

    const members = await councilMembers(d.near, d.daoId);
    if (!members.includes(p.accountId)) return fail("only council members can run payments");
    return { ok: true, accountId: p.accountId };
  } catch {
    return fail("could not verify the signature");
  }
}
