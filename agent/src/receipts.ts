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

/** The assistant message text inside an OpenAI-style completion body. */
export function completionText(responseText: string): string {
  const j = JSON.parse(responseText) as { choices?: { message?: { content?: unknown } }[] };
  const c = j.choices?.[0]?.message?.content;
  if (typeof c !== "string") throw new Error("completion has no choices[0].message.content");
  return c;
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

/** Stored receipt for `key`, as mode "replay". No network. Throws if the stored file does not match its hash. */
export function loadReplay(
  key: string,
  dir: string = DEFAULT_RECEIPTS_DIR,
): { text: string; receipt: InferenceReceipt; hash: string } | null {
  const hash = readIndex(dir)[key];
  if (!hash) return null;
  const stored = JSON.parse(readFileSync(join(dir, `${hash}.json`), "utf8")) as InferenceReceipt;
  if (receiptHash(stored) !== hash) throw new Error(`receipt ${hash} does not match its hash (tampered?)`);
  return { text: completionText(stored.responseText), receipt: { ...stored, mode: "replay" }, hash };
}
