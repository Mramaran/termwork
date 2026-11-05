import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InferenceReceipt {
  model: string;
  requestBody: unknown;
  responseText: string;
  chatId: string;
  signature: unknown;
  attestation: unknown;
  nonce: string;
  verified: boolean;
  /** What `verified` covers. The TDX quote and NVIDIA NRAS evidence are never checked. */
  verifiedScope: "response-signature+model+nonce" | "none";
  mode: "live" | "replay";
  createdAt: string;
}

/** Repo-root receipts directory, independent of the process cwd. */
export const DEFAULT_RECEIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "receipts");

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
  }
  return v;
}

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonical(v));
}

/** Lowercase hex sha256 of the canonical JSON of the receipt. */
export function receiptHash(r: InferenceReceipt): string {
  return createHash("sha256").update(canonicalJson(r), "utf8").digest("hex");
}

/** Parses an OpenAI-style completion body once; clear errors instead of a raw SyntaxError. */
export function parseCompletion(responseText: string): { id: string | undefined; text: string } {
  let j: { id?: unknown; choices?: { message?: { content?: unknown } }[] };
  try {
    j = JSON.parse(responseText);
  } catch {
    throw new Error("completion response is not valid JSON");
  }
  const c = j?.choices?.[0]?.message?.content;
  if (typeof c !== "string") throw new Error("completion has no choices[0].message.content");
  return { id: typeof j.id === "string" ? j.id : undefined, text: c };
}

export function completionText(responseText: string): string {
  return parseCompletion(responseText).text;
}

function readIndex(dir: string): Record<string, string> {
  const p = join(dir, "index.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, string>) : {};
}

/** Writes <dir>/<hash>.json; when `key` is given (PR url or `renewal:<n>`) records key -> hash in index.json. */
export function saveReceipt(r: InferenceReceipt, dir: string = DEFAULT_RECEIPTS_DIR, key?: string): string {
  mkdirSync(dir, { recursive: true });
  const hash = receiptHash(r);
  writeFileSync(join(dir, `${hash}.json`), JSON.stringify(r, null, 2));
  if (key !== undefined) {
    const idx = readIndex(dir);
    idx[key] = hash;
    const tmp = join(dir, "index.json.tmp");
    writeFileSync(tmp, JSON.stringify(idx, null, 2));
    renameSync(tmp, join(dir, "index.json"));
  }
  return hash;
}

/** Stored receipt for `key`, unchanged (so receiptHash(receipt) === hash); the wrapper carries mode "replay". No network. Throws if the stored file does not match its hash. */
export function loadReplay(
  key: string,
  dir: string = DEFAULT_RECEIPTS_DIR,
): { text: string; receipt: InferenceReceipt; hash: string; mode: "replay" } | null {
  const hash = readIndex(dir)[key];
  if (!hash) return null;
  const stored = JSON.parse(readFileSync(join(dir, `${hash}.json`), "utf8")) as InferenceReceipt;
  if (receiptHash(stored) !== hash) throw new Error(`receipt ${hash} does not match its hash (tampered?)`);
  return { text: completionText(stored.responseText), receipt: stored, hash, mode: "replay" };
}
