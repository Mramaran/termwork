import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { loadConfig } from "@termwork/shared";
import { parseCompletion, receiptHash, type InferenceReceipt } from "./receipts.js";

export type { InferenceReceipt } from "./receipts.js";
export { receiptHash } from "./receipts.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  model?: string;
  baseUrl?: string;
  allowUnverified?: boolean;
  signatureRetries?: number;
  retryDelayMs?: number;
}

const BASE_URL = "https://cloud-api.near.ai";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Address that produced an EIP-191 personal_sign signature over `message`, or null if malformed. */
export function recoverPersonalSigner(message: string, signatureHex: string): string | null {
  try {
    const sig = hexToBytes(signatureHex.replace(/^0x/, ""));
    if (sig.length !== 65) return null;
    const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
    if (v !== 0 && v !== 1) return null;
    const m = new TextEncoder().encode(message);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${m.length}`);
    const digest = keccak_256(new Uint8Array([...prefix, ...m]));
    const recovered = new Uint8Array(65);
    recovered[0] = v;
    recovered.set(sig.subarray(0, 64), 1);
    const pub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
    const uncompressed = secp256k1.Point.fromBytes(pub).toBytes(false);
    return "0x" + bytesToHex(keccak_256(uncompressed.subarray(1)).slice(-20));
  } catch {
    return null;
  }
}

async function httpError(res: Response, ctx: string): Promise<Error> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  return new Error(`${ctx}: ${res.status}${detail ? ` - ${detail}` : ""}`);
}

interface SignatureResp {
  text: string;
  signature: string;
  signing_address?: string;
  signature_kind?: string;
}
interface AttestationReport {
  gateway_attestation?: { signing_address?: string; request_nonce?: string };
  model_attestations?: { signing_address?: string; request_nonce?: string }[];
}

/**
 * Checks, and only these: the signed text commits to sha256(request body), sha256(response body) and (for a
 * model-TEE signature) the model id; the signature recovers to a signing address listed in the attestation
 * report; every attestation in the report echoes our fresh nonce.
 * Not checked: the TDX quote and the NVIDIA GPU evidence (nvidia_payload / NRAS), so this does not prove the
 * signing address is bound to genuine TEE hardware.
 */
export function verifyEvidence(a: {
  requestBody: string;
  responseText: string;
  model: string;
  nonce: string;
  signature: SignatureResp;
  report: AttestationReport;
}): boolean {
  const { signature: s, report: r, nonce } = a;
  // Only a model-TEE signature binds the model id; gateway or unknown kinds are never verified.
  if (s?.signature_kind !== "provider_tee") return false;
  const parts = typeof s?.text === "string" ? s.text.split(":") : [];
  if (parts.length !== 3 || parts[0] !== a.model) return false;
  if (parts[1] !== sha256(a.requestBody) || parts[2] !== sha256(a.responseText)) return false;
  const signer = recoverPersonalSigner(s.text, s.signature ?? "");
  if (!signer) return false;
  const allowed = (r.model_attestations ?? []).map((m) => m.signing_address);
  if (!allowed.some((x) => typeof x === "string" && x.toLowerCase() === signer)) return false;
  const models = r.model_attestations ?? [];
  return (
    r.gateway_attestation?.request_nonce === nonce &&
    models.length > 0 &&
    models.every((m) => m.request_nonce === nonce)
  );
}

export async function complete(
  messages: ChatMessage[],
  key: string,
  opts: CompleteOptions = {},
): Promise<{ text: string; receipt: InferenceReceipt; hash: string }> {
  const cfg = loadConfig();
  const model = opts.model ?? cfg.NEARAI_MODEL;
  if (!model) throw new Error("NEARAI_MODEL is not set");
  const allowUnverified = opts.allowUnverified ?? cfg.NEARAI_ALLOW_UNVERIFIED;
  const base = opts.baseUrl ?? BASE_URL;
  const headers = { accept: "application/json", Authorization: `Bearer ${key}` };

  // Model must be hosted by NEAR AI (TEE) unless explicitly overridden.
  const mres = await fetch(`${base}/v1/models`, { headers });
  if (!mres.ok) throw await httpError(mres, "Model list request failed");
  const models = ((await mres.json()) as { data?: { id: string; owned_by?: string }[] }).data ?? [];
  const info = models.find((m) => m.id === model);
  if (!info) throw new Error(`model ${model} not found in the NEAR AI model list`);
  const nearai = info.owned_by === "nearai";
  if (!nearai && !allowUnverified) {
    throw new Error(
      `model ${model} has owned_by "${info.owned_by}", not "nearai"; set NEARAI_ALLOW_UNVERIFIED=1 to use it unverified`,
    );
  }

  const requestBody = JSON.stringify({ model, messages, stream: false });
  const cres = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: requestBody,
  });
  if (!cres.ok) throw await httpError(cres, "Chat completion request failed");
  const responseText = await cres.text();
  const { id: chatId, text } = parseCompletion(responseText);
  if (!chatId) throw new Error("completion response has no id");

  const nonce = randomBytes(32).toString("hex");
  let signature: SignatureResp | null = null;
  let report: AttestationReport | null = null;
  let verified = false;

  if (nearai) {
    const ares = await fetch(
      `${base}/v1/attestation/report?${new URLSearchParams({ model, nonce, signing_algo: "ecdsa" })}`,
      { headers },
    );
    if (!ares.ok) throw await httpError(ares, "Attestation request failed");
    report = (await ares.json()) as AttestationReport;

    // The signature is cached on the serving node, so it may 404 briefly; retry.
    const retries = opts.signatureRetries ?? 5;
    const sigUrl = `${base}/v1/signature/${encodeURIComponent(chatId)}?${new URLSearchParams({ model, signing_algo: "ecdsa" })}`;
    for (let i = 1; ; i++) {
      const sres = await fetch(sigUrl, { headers });
      if (sres.ok) {
        signature = (await sres.json()) as SignatureResp;
        break;
      }
      if (sres.status !== 404 || i >= retries) throw await httpError(sres, "Signature request failed");
      await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 1000));
    }
    verified = verifyEvidence({ requestBody, responseText, model, nonce, signature, report });
  }

  const receipt: InferenceReceipt = {
    model,
    requestBody,
    responseText,
    chatId,
    signature,
    attestation: report,
    nonce,
    verified,
    verifiedScope: verified ? "response-signature+model+nonce" : "none",
    mode: "live",
    createdAt: new Date().toISOString(),
  };
  return { text, receipt, hash: receiptHash(receipt) };
}

async function smoke(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.NEARAI_API_KEY) {
    console.log("skipped: NEARAI_API_KEY not set");
    return;
  }
  const out = await complete([{ role: "user", content: "Reply with the single word: ok" }], cfg.NEARAI_API_KEY);
  console.log(`model=${out.receipt.model} verified=${out.receipt.verified} hash=${out.hash} text=${JSON.stringify(out.text)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--smoke")) {
  smoke().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
