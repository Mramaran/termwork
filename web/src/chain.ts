/** Browser-side chain access: plain fetch against testnet JSON-RPC. No Node-only imports. */
import type { LogEntry, MandateView, Renewal, SpendRequest, Status } from "@termwork/shared";

export const TESTNET_RPC_HOSTS = ["rpc.testnet.near.org", "archival-rpc.testnet.near.org", "test.rpc.fastnear.com", "rpc.testnet.fastnear.com"];
export const DEFAULT_RPC = "https://rpc.testnet.near.org";

export function rpcUrl(v: string | undefined): string {
  if (!v) return DEFAULT_RPC;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error("VITE_NEAR_RPC_URL is not a valid URL");
  }
  if (u.protocol !== "https:" || !TESTNET_RPC_HOSTS.includes(u.hostname.toLowerCase())) {
    throw new Error(`VITE_NEAR_RPC_URL host must be one of: ${TESTNET_RPC_HOSTS.join(", ")}`);
  }
  return v;
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
export const MANDATE_ID = env.VITE_MANDATE_ID ?? "";
export const DAO_ID = env.VITE_DAO_ID ?? "";
export const NETWORK = env.VITE_NETWORK ?? "testnet";
let cachedRpc: string | undefined;
const RPC = (): string => (cachedRpc ??= rpcUrl(env.VITE_NEAR_RPC_URL));

export const explorerTx = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id: string): string => `https://testnet.nearblocks.io/address/${encodeURIComponent(id)}`;

let rpcId = 0;
async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string; data?: unknown; cause?: { name?: string } } };
  if (json.error) throw new Error(`${json.error.cause?.name ?? ""} ${json.error.message ?? ""} ${typeof json.error.data === "string" ? json.error.data : ""}`.trim());
  return json.result as T;
}

export async function viewCall<T>(account: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const args_base64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
  const r = await rpc<{ result?: number[]; error?: string }>("query", { request_type: "call_function", finality: "optimistic", account_id: account, method_name: method, args_base64 });
  if (r.error) throw new Error(r.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result ?? []))) as T;
}

export interface AccessKeyInfo {
  public_key: string;
  access_key: { nonce: number; permission: unknown };
}

export async function accessKeys(account: string): Promise<AccessKeyInfo[]> {
  const r = await rpc<{ keys: AccessKeyInfo[] }>("query", { request_type: "view_access_key_list", finality: "optimistic", account_id: account });
  return r.keys;
}

export type KeyState = "live" | "deleted";
export const keyStatus = (keys: AccessKeyInfo[]): KeyState => (keys.length === 0 ? "deleted" : "live");

/** Measured rejection texts for a deleted key. */
export function classifyKeyError(text: string): "deleted" | "other" {
  return /AccessKeyDoesNotExist|InvalidAccessKey|AccessKeyNotFound|access key .*does not exist/i.test(text) ? "deleted" : "other";
}

export type CitePart = { kind: "text"; text: string } | { kind: "cite"; text: string; index: number; href: string };

export function linkifyCitations(text: string): CitePart[] {
  const out: CitePart[] = [];
  const re = /\[#(\d+)\]/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "cite", text: m[0], index: Number(m[1]), href: `#log-${m[1]}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export interface BudgetBar {
  deposit: string;
  spent: string;
  available: string;
  spentPct: number;
  availablePct: number;
}

export function budgetBar(spent: string, available: string): BudgetBar {
  const s = BigInt(spent);
  const a = BigInt(available);
  const d = s + a;
  const spentPct = d === 0n ? 0 : Number((s * 10000n) / d) / 100;
  return { deposit: d.toString(), spent: s.toString(), available: a.toString(), spentPct, availablePct: d === 0n ? 0 : 100 - spentPct };
}

export function keyEndLink(status: Status, mandateId: string, demo: DemoOutput | null): { href: string; label: string } {
  const t = demo?.txs;
  const tx = status === "Fired" ? (t?.["fire.vote2"] ?? t?.["fire.vote1"] ?? t?.["fire"]) : status === "Expired" ? t?.["expire"] : undefined;
  if (tx && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(tx.hash)) return { href: explorerTx(tx.hash), label: status === "Fired" ? "the transaction that fired the agent" : "the expiry transaction" };
  return { href: explorerAccount(mandateId), label: "the DeleteKey transaction (see DeleteKey on explorer)" };
}

export function fmtNear(yocto: string | null | undefined, digits = 3): string {
  if (!yocto) return "0";
  const y = BigInt(yocto);
  const unit = 10n ** 24n;
  const whole = y / unit;
  const frac = ((y % unit) * 10n ** BigInt(digits)) / unit;
  const f = frac.toString().padStart(digits, "0").replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole.toString();
}

export interface Receipt {
  model?: string;
  verified?: boolean;
  verifiedScope?: string;
  mode?: string;
  responseText?: string;
  createdAt?: string;
}

export function receiptBadge(r: Receipt | null | undefined): { label: string; tone: "ok" | "warn" | "none" } {
  if (!r) return { label: "no receipt", tone: "none" };
  if (r.verified === true) return { label: "verified inference", tone: "ok" };
  if (r.model === "fixture-rules" || r.verifiedScope === "none") return { label: "unverified (fixture rules)", tone: "warn" };
  return { label: "unverified", tone: "warn" };
}

export async function fetchReceipt(hash: string): Promise<Receipt | null> {
  if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
  try {
    const r = await fetch(`/receipts/${hash}.json`);
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return (await r.json()) as Receipt;
  } catch {
    return null;
  }
}

export interface ProposalView {
  id: number;
  proposer: string;
  description: string;
  status: string;
  kind: unknown;
  vote_counts: Record<string, [number, number, number]>;
  votes: Record<string, string>;
  submission_time: string;
}

export interface Snapshot {
  mandate: MandateView;
  log: LogEntry[];
  requests: SpendRequest[];
  renewal: Renewal | null;
  keys: AccessKeyInfo[];
  proposals: ProposalView[];
  status: Status;
}

async function pagedLog(): Promise<LogEntry[]> {
  const all: LogEntry[] = [];
  for (;;) {
    const page = await viewCall<LogEntry[]>(MANDATE_ID, "get_work_log", { from: all.length, limit: 50 });
    all.push(...page);
    if (page.length < 50) return all;
  }
}

export async function loadSnapshot(): Promise<Snapshot> {
  const [mandate, log, requests, renewal, keys] = await Promise.all([
    viewCall<MandateView>(MANDATE_ID, "get_mandate"),
    pagedLog(),
    viewCall<SpendRequest[]>(MANDATE_ID, "get_requests"),
    viewCall<Renewal | null>(MANDATE_ID, "get_renewal"),
    accessKeys(MANDATE_ID),
  ]);
  let proposals: ProposalView[] = [];
  if (DAO_ID) {
    const last = await viewCall<number>(DAO_ID, "get_last_proposal_id");
    const ids = Array.from({ length: last }, (_, i) => i).slice(-12);
    proposals = (await Promise.all(ids.map((id) => viewCall<ProposalView>(DAO_ID, "get_proposal", { id }).catch(() => null)))).filter((p): p is ProposalView => p !== null);
  }
  return { mandate, log, requests, renewal, keys, proposals, status: mandate.status };
}

/** Shape of repo-root demo-output.json (written by scripts/src/demo.ts); every field optional. */
export interface DemoOutput {
  txs?: Record<string, { hash: string; explorer: string }>;
  agentAttempt?: { result: string; rpcError: string };
  termEnded?: { explorer: string; rpcError: string };
  finalAccessKeys?: unknown[];
  accounts?: { mandate?: string; dao?: string; renewalReport?: string };
}

export async function loadDemoOutput(): Promise<DemoOutput | null> {
  try {
    const r = await fetch("/demo-output.json");
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return (await r.json()) as DemoOutput;
  } catch {
    return null;
  }
}

/** Sputnik vote args, as used by scripts/src/dao.ts (gas 300 Tgas). */
export const VOTE_GAS = "300000000000000";
export const voteArgs = (id: number, approve: boolean) => ({ id, action: approve ? "VoteApprove" : "VoteReject" });

export const isReceiptHash = (h: string | null | undefined): h is string => !!h && /^[0-9a-f]{64}$/i.test(h);

/** Council members from the Sputnik policy (Group roles). */
export async function councilMembers(): Promise<string[]> {
  const p = await viewCall<{ roles: { kind: unknown }[] }>(DAO_ID, "get_policy");
  return p.roles.flatMap((r) => (r.kind && typeof r.kind === "object" && "Group" in r.kind ? (r.kind as { Group: string[] }).Group : []));
}
