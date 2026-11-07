import { MAX_PRS_PER_CONTRIBUTOR, testnetRpcUrl, type LogEntry, type MandateView, type SpendRequest } from "@termwork/shared";
import { complete } from "../../agent/src/nearai";
import { decisionMessages } from "../../agent/src/prompts";
import { GitHubError, listMergedInRange } from "../../agent/src/sources/github";
import type { PullRequestFact } from "../../agent/src/sources/types";
import { OVER_LIMIT, parseDecision, validate } from "../../agent/src/validate";
import { nodeHandler, scrub, type HandleReq, type HandleRes } from "./_lib/http";
import { parseRange, parseRepo, payableRepos } from "./_lib/input";
import { makeLimiter } from "./_lib/limits";
import { yoctoToNear } from "./_lib/near-format";
import { getMandate, getRequests, getWorkLog } from "./_lib/near";

export interface AnalyseDeps {
  listMergedInRange: typeof listMergedInRange;
  complete: typeof complete;
  getMandate: () => Promise<MandateView>;
  getWorkLog: () => Promise<LogEntry[]>;
  getRequests: () => Promise<SpendRequest[]>;
  now: () => number;
  /** Secret strings scrubbed from every response. */
  secrets?: string[];
  /** The mandate contract account; empty when the deployment is not configured. */
  mandateId: string;
  /** Repos that may be paid for real (lower-cased owner/name). */
  payable: Set<string>;
  /** NEAR AI credentials, supplied by the default export from process.env. */
  apiKey?: string;
  model?: string;
  githubToken?: string;
}
export type { HandleReq, HandleRes };

export type Row = {
  url: string;
  number: number;
  title: string;
  author: string;
  firstTime: boolean;
  mergedAt: string;
  nearAccount: string | null;
  status: "paid" | "pending" | "ready" | "unclaimed" | "would_pay" | "skipped";
  amountNear: string | null;
  reason: string;
  receiptHash: string | null;
  proposalId: number | null;
};

/** Non-payable path only: each request makes model calls. */
export const limiter = makeLimiter(2, 100);
/** Payable path: chain and GitHub reads only, and the UI refreshes it after paying. */
export const payableLimiter = makeLimiter(20, 1000);

const MAX_BODY = 1024;
const CONCURRENCY = 5;
const PLACEHOLDER_ACCOUNT = "unclaimed.testnet";
const FIXED_SUGGESTIONS = ["near/near-cli-rs", "near/near-sdk-rs"];

function suggestionsFor(repo: string, payable: Set<string>): string[] {
  const first = [...payable][0];
  const list = [...(first ? [first] : []), ...FIXED_SUGGESTIONS];
  return list.filter((r, i) => r !== repo && list.indexOf(r) === i);
}

/** Runs fn over items with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const baseRow = (p: PullRequestFact): Omit<Row, "status" | "amountNear" | "reason" | "receiptHash" | "proposalId"> => ({
  url: p.url,
  number: p.number,
  title: p.title,
  author: p.author,
  firstTime: p.firstTime,
  mergedAt: p.mergedAt,
  nearAccount: p.nearAccount,
});

const overLimit = (p: PullRequestFact) => (p.earlierInWindow ?? 0) >= MAX_PRS_PER_CONTRIBUTOR;

/** Payable repo: statuses come from the chain only, no model call. */
function payableRow(p: PullRequestFact, paid: Map<string, LogEntry>, pending: Map<string, SpendRequest>): Row {
  const b = baseRow(p);
  const done = paid.get(p.url);
  if (done)
    return {
      ...b,
      status: "paid",
      amountNear: done.amount ? yoctoToNear(done.amount) : null,
      reason: done.kind === "PaidApproved" ? "paid after DAO approval" : "paid by the agent",
      receiptHash: done.receipt_hash,
      proposalId: null,
    };
  const req = pending.get(p.url);
  if (req)
    return {
      ...b,
      status: "pending",
      amountNear: yoctoToNear(req.amount),
      reason: "waiting for council approval",
      receiptHash: req.receipt_hash,
      proposalId: req.proposal_id,
    };
  if (overLimit(p)) return { ...b, status: "skipped", amountNear: null, reason: OVER_LIMIT, receiptHash: null, proposalId: null };
  if (!p.nearAccount)
    return { ...b, status: "unclaimed", amountNear: null, reason: "no NEAR account in the pull request", receiptHash: null, proposalId: null };
  return { ...b, status: "ready", amountNear: null, reason: "ready to pay", receiptHash: null, proposalId: null };
}

/** Non-payable repo: the model decides, the fixed rules gate it, nothing is paid. */
async function decidedRow(p: PullRequestFact, mandate: MandateView, deps: AnalyseDeps, stats: { calls: number; failed: number }): Promise<Row> {
  const b = baseRow(p);
  if (overLimit(p)) return { ...b, status: "skipped", amountNear: null, reason: OVER_LIMIT, receiptHash: null, proposalId: null };
  let out: Awaited<ReturnType<typeof complete>>;
  stats.calls++;
  try {
    out = await deps.complete(decisionMessages(mandate, p), deps.apiKey ?? "", { model: deps.model ?? "" });
  } catch (e) {
    stats.failed++;
    const msg = (scrub({ status: 0, json: { m: e instanceof Error ? e.message : String(e) } }, deps.secrets ?? []).json as { m: string }).m;
    console.error(`analyse: AI request failed for ${p.url}: ${msg}`);
    return { ...b, status: "skipped", amountNear: null, reason: "the AI request failed", receiptHash: null, proposalId: null };
  }
  // An unclaimed PR is checked with a placeholder account so the amount is still computed; the recipient is dropped.
  const probe = p.nearAccount ? p : { ...p, nearAccount: PLACEHOLDER_ACCOUNT };
  const action = await validate(parseDecision(out.text), probe, mandate, new Set(), async () => true);
  if (action.kind === "log")
    return { ...b, status: "skipped", amountNear: null, reason: action.summary, receiptHash: out.hash, proposalId: null };
  const amountNear = yoctoToNear(action.amountYocto);
  const reason = action.kind === "request" ? "would go to a DAO vote" : "would be paid directly";
  return p.nearAccount
    ? { ...b, status: "would_pay", amountNear, reason, receiptHash: out.hash, proposalId: null }
    : { ...b, status: "unclaimed", amountNear, reason: "no NEAR account in the pull request", receiptHash: out.hash, proposalId: null };
}

async function run(req: HandleReq, deps: AnalyseDeps): Promise<HandleRes> {
  if (req.method !== "POST") return { status: 405, json: { error: "use POST" }, headers: { Allow: "POST" } };
  if (req.oversized || new TextEncoder().encode(req.body).length > MAX_BODY) return { status: 413, json: { error: "request body too large (max 1024 bytes)" } };
  if (!deps.mandateId) return { status: 503, json: { error: "The live analysis isn't configured on this deployment." } };

  let input: unknown;
  try {
    input = JSON.parse(req.body);
  } catch {
    return { status: 400, json: { error: "body must be valid JSON", field: "body" } };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { status: 400, json: { error: "body must be a JSON object", field: "body" } };
  const r = input as Record<string, unknown>;
  const parsedRepo = parseRepo(r.repo);
  if ("error" in parsedRepo) return { status: 400, json: { error: parsedRepo.error, field: "repo" } };
  const now = deps.now();
  const range = parseRange(r.range, now);
  if ("error" in range) return { status: 400, json: { error: range.error, field: "range" } };
  const repo = parsedRepo.repo;
  const payable = deps.payable.has(repo);
  if (!payable && (!deps.apiKey || !deps.model))
    return { status: 503, json: { error: "The live AI demo isn't configured on this deployment." } };

  const lim = (payable ? payableLimiter : limiter)(req.ip, now);
  if (!lim.ok) return { status: 429, json: { error: "too many requests, slow down", retryAfterSec: lim.retryAfterSec } };

  const suggestions = suggestionsFor(repo, deps.payable);
  let listed: Awaited<ReturnType<typeof listMergedInRange>>;
  try {
    listed = await deps.listMergedInRange(repo, range.from, range.to, { token: deps.githubToken });
  } catch (e) {
    if (e instanceof GitHubError) {
      if (e.retryAfterSec !== null || e.status === 429)
        return { status: 429, json: { error: "GitHub rate limit reached, try again shortly.", retryAfterSec: e.retryAfterSec ?? 60 } };
      if (e.status === 404) return { status: 404, json: { fit: "not_found", error: "repository not found", suggestions } };
      if (e.status === 502) return { status: 502, json: { error: e.message } };
    }
    return { status: 502, json: { error: "GitHub could not be read. Try again in a minute." } };
  }

  const head = { repo, from: range.from, to: range.to, payable, total: listed.total, capped: listed.capped, suggestions };
  if (listed.prs.length === 0) return { status: 200, json: { ...head, fit: "no_merged_in_range", rows: [] } };

  let rows: Row[];
  try {
    if (payable) {
      const [log, requests] = await Promise.all([deps.getWorkLog(), deps.getRequests()]);
      const paid = new Map(log.filter((e) => (e.kind === "Paid" || e.kind === "PaidApproved") && e.evidence_url).map((e) => [e.evidence_url!, e]));
      const pending = new Map(requests.filter((q) => q.state === "Pending").map((q) => [q.evidence_url, q]));
      rows = listed.prs.map((p) => payableRow(p, paid, pending));
    } else {
      const mandate = await deps.getMandate();
      const stats = { calls: 0, failed: 0 };
      rows = await mapLimit(listed.prs, CONCURRENCY, (p) => decidedRow(p, mandate, deps, stats));
      if (stats.calls > 0 && stats.failed === stats.calls)
        return { status: 502, json: { error: "The AI request failed. Try again in a minute." } };
    }
  } catch {
    return { status: 502, json: { error: "The chain could not be read. Try again in a minute." } };
  }
  return { status: 200, json: { ...head, fit: "ok", rows } };
}

export async function handle(req: HandleReq, deps: AnalyseDeps): Promise<HandleRes> {
  return scrub(await run(req, deps), deps.secrets ?? []);
}

const secrets = () => [process.env.NEARAI_API_KEY ?? "", process.env.GITHUB_TOKEN ?? ""];

/** Vercel Node handler. */
export default nodeHandler(
  (req) => {
    const near = { rpcUrl: testnetRpcUrl(process.env.NEAR_RPC_URL) };
    const mandateId = process.env.MANDATE_ID ?? "";
    return handle(req, {
      listMergedInRange,
      complete,
      getMandate: () => getMandate(near, mandateId),
      getWorkLog: () => getWorkLog(near, mandateId),
      getRequests: () => getRequests(near, mandateId),
      now: () => Date.now(),
      secrets: secrets(),
      mandateId,
      payable: payableRepos(process.env.PAYABLE_REPOS),
      apiKey: process.env.NEARAI_API_KEY ?? "",
      model: process.env.NEARAI_MODEL ?? "",
      githubToken: process.env.GITHUB_TOKEN || undefined,
    });
  },
  { maxBody: MAX_BODY, secrets },
);
