import { testnetRpcUrl, type LogEntry } from "@termwork/shared";
import { findPaidTx } from "./_lib/github-write";
import { nodeHandler, scrub, type HandleReq, type HandleRes } from "./_lib/http";
import { payableRepos } from "./_lib/input";
import { makeLimiter } from "./_lib/limits";
import { getWorkLog } from "./_lib/near";
import { yoctoToNear } from "./_lib/near-format";

export interface PaidItem {
  prUrl: string;
  repo: string;
  number: number;
  title: string | null;
  recipient: string;
  amountNear: string;
  via: "direct" | "dao";
  timestampMs: number;
  txHash: string | null;
  fallbackHref: string;
}

export interface PaidDeps {
  getWorkLog: () => Promise<LogEntry[]>;
  findPaidTx: (repo: string, number: number) => Promise<string | null>;
  getTitle: (repo: string, number: number) => Promise<string | null>;
  now: () => number;
  /** Repos that may be paid for real (lower-cased owner/name). */
  payable: Set<string>;
  mandateId: string;
  /** Secret strings scrubbed from every response. */
  secrets?: string[];
}
export type { HandleReq, HandleRes };

export const limiter = makeLimiter(20, 2000);

const CACHE_MS = 30_000;
const CONCURRENCY = 5;
const PR_URL_RE = /^https:\/\/github\.com\/([A-Za-z\d-]+)\/([A-Za-z\d._-]+)\/pull\/(\d{1,10})$/;

/** PR title from the plain pulls endpoint (core quota, not the search quota that /api/pay needs). Null on any failure. */
export async function fetchTitle(repo: string, number: number, opts: { token?: string; fetchFn?: typeof fetch } = {}): Promise<string | null> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "termwork-agent" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  try {
    const res = await (opts.fetchFn ?? fetch)(`https://api.github.com/repos/${repo}/pulls/${number}`, { headers });
    if (!res.ok) return null;
    const title = ((await res.json()) as { title?: unknown }).title;
    return typeof title === "string" ? title : null;
  } catch {
    return null;
  }
}

let cache: { at: number; mandateId: string; items: PaidItem[] } | null = null;

/** Clears the 30 s response cache (for tests). */
export function resetCache(): void {
  cache = null;
}

async function mapLimited<T, R>(xs: T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, xs.length) }, async () => {
      while (next < xs.length) {
        const i = next++;
        out[i] = await fn(xs[i]!);
      }
    }),
  );
  return out;
}

async function build(deps: PaidDeps, log: LogEntry[]): Promise<PaidItem[]> {
  const fallbackHref = `https://testnet.nearblocks.io/address/${deps.mandateId}`;
  const paid: Array<{ e: LogEntry; repo: string; number: number }> = [];
  for (const e of log) {
    if (e.kind !== "Paid" && e.kind !== "PaidApproved") continue;
    const m = PR_URL_RE.exec(e.evidence_url ?? "");
    if (!m) continue;
    const repo = `${m[1]}/${m[2]}`;
    if (!deps.payable.has(repo.toLowerCase())) continue;
    paid.push({ e, repo, number: Number(m[3]) });
  }
  paid.sort((a, b) => b.e.timestamp_ms - a.e.timestamp_ms);

  return mapLimited(paid, async ({ e, repo, number }): Promise<PaidItem> => {
    const [title, txHash] = await Promise.all([
      deps.getTitle(repo, number).catch(() => null),
      deps.findPaidTx(repo, number).catch(() => null),
    ]);
    return {
      prUrl: e.evidence_url!,
      repo,
      number,
      title,
      recipient: e.recipient ?? "",
      amountNear: yoctoToNear(e.amount ?? "0"),
      via: e.kind === "PaidApproved" ? "dao" : "direct",
      timestampMs: e.timestamp_ms,
      txHash,
      fallbackHref,
    };
  });
}

async function run(req: HandleReq, deps: PaidDeps): Promise<HandleRes> {
  if (req.method !== "GET") return { status: 405, json: { error: "use GET" }, headers: { Allow: "GET" } };
  if (!deps.mandateId) return { status: 503, json: { error: "Paid PRs aren't configured on this deployment." } };

  const now = deps.now();
  const lim = limiter(req.ip, now);
  if (!lim.ok) return { status: 429, json: { error: "too many requests, slow down", retryAfterSec: lim.retryAfterSec } };

  if (cache && cache.mandateId === deps.mandateId && now - cache.at >= 0 && now - cache.at < CACHE_MS) return { status: 200, json: { items: cache.items } };

  let log: LogEntry[];
  try {
    log = await deps.getWorkLog();
  } catch {
    return { status: 502, json: { error: "The chain could not be read. Try again in a minute." } };
  }
  const items = await build(deps, log);
  cache = { at: now, mandateId: deps.mandateId, items };
  return { status: 200, json: { items } };
}

export async function handle(req: HandleReq, deps: PaidDeps): Promise<HandleRes> {
  return scrub(await run(req, deps), deps.secrets ?? []);
}

const secrets = () => [process.env.GITHUB_TOKEN ?? ""];

/** Vercel Node handler. */
export default nodeHandler(
  (req) => {
    const env = process.env;
    const near = { rpcUrl: testnetRpcUrl(env.NEAR_RPC_URL) };
    const mandateId = env.MANDATE_ID ?? "";
    const token = env.GITHUB_TOKEN || undefined;
    return handle(req, {
      getWorkLog: () => getWorkLog(near, mandateId),
      findPaidTx: (repo, number) => findPaidTx(repo, number, { token }),
      getTitle: (repo, number) => fetchTitle(repo, number, { token }),
      now: () => Date.now(),
      payable: payableRepos(env.PAYABLE_REPOS),
      mandateId,
      secrets: secrets(),
    });
  },
  { maxBody: 0, secrets },
);
