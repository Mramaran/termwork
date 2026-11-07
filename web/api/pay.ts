import { testnetRpcUrl, type LogEntry, type MandateView, type SpendRequest } from "@termwork/shared";
import { complete } from "../../agent/src/nearai";
import { decisionMessages } from "../../agent/src/prompts";
import { GitHubError, getMergedPr } from "../../agent/src/sources/github";
import { parseDecision, validate } from "../../agent/src/validate";
import { accountFactory, buildOps, OutcomeUnknownError, type Ops } from "../../signer/src/ops";
import { verifyCouncil, type CouncilResult } from "./_lib/auth";
import { labelPaid, type PaidInfo } from "./_lib/github-write";
import { nodeHandler, scrub, type HandleReq, type HandleRes } from "./_lib/http";
import { parseRange, parseRepo, payableRepos } from "./_lib/input";
import { makeLimiter } from "./_lib/limits";
import { yoctoToNear } from "./_lib/near-format";
import { accountExists, getMandate, getRequests, getWorkLog } from "./_lib/near";

export interface PayConfig {
  privateKey: string;
  mandateId: string;
  daoId: string;
  apiKey: string;
  model: string;
  githubToken: string;
  /** Optional: without it the payment still happens but the PR is not labelled. */
  labelToken: string;
}

export interface PayDeps {
  /** Checks the council proof against the given clock. */
  verifyCouncil: (proof: unknown, now: number) => Promise<CouncilResult>;
  getMergedPr: typeof getMergedPr;
  complete: typeof complete;
  getMandate: () => Promise<MandateView>;
  getWorkLog: () => Promise<LogEntry[]>;
  getRequests: () => Promise<SpendRequest[]>;
  accountExists: (id: string) => Promise<boolean>;
  /** The agent's signing operations, built only once a payment is due. */
  ops: () => Pick<Ops, "spend" | "request_spend">;
  labelPaid: (p: PaidInfo, d: { token: string }) => Promise<"labelled" | "already">;
  now: () => number;
  /** Secret strings scrubbed from every response. */
  secrets?: string[];
  /** Repos that may be paid for real (lower-cased owner/name). */
  payable: Set<string>;
  config: PayConfig;
}
export type { HandleReq, HandleRes };

export const limiter = makeLimiter(30, 100);

const MAX_BODY = 4096;
const FIELDS = new Set(["repo", "number", "range", "proof"]);
const DUPLICATE = "already paid or pending";
const NOT_ACTIVE = "The agent is not active (expired or fired).";

const MAX_RATIONALE_BYTES = 2048;
const RPC_CHECK_PREFIX = "recipient check failed (rpc)";

/** Cuts text to at most maxBytes of UTF-8, never splitting a character. */
function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

const errText =(e: unknown, secrets: string[]): string =>
  (scrub({ status: 0, json: { m: e instanceof Error ? e.message : String(e) } }, secrets).json as { m: string }).m;

/** Maps a failed send to a response. Contract panics arrive inside the error message. */
function sendFailure(e: unknown, secrets: string[]): HandleRes {
  if (e instanceof OutcomeUnknownError) return { status: 504, json: { error: "outcome unknown, refresh before retrying" } };
  const msg = e instanceof Error ? e.message : String(e);
  if (/already paid/i.test(msg)) return { status: 409, json: { error: DUPLICATE } };
  // fire() and expiry delete the agent's access key, so signing fails with a missing-key error.
  if (/not active|term ended|access key|AccessKeyDoesNotExist/i.test(msg)) return { status: 409, json: { error: NOT_ACTIVE } };
  if (/insufficient budget/i.test(msg)) return { status: 409, json: { error: "The agent's budget is used up." } };
  console.error(`pay: send failed: ${errText(e, secrets)}`);
  return { status: 502, json: { error: "The payment could not be sent. Try again in a minute." } };
}

async function run(req: HandleReq, deps: PayDeps): Promise<HandleRes> {
  if (req.method !== "POST") return { status: 405, json: { error: "use POST" }, headers: { Allow: "POST" } };
  if (req.oversized || new TextEncoder().encode(req.body).length > MAX_BODY) return { status: 413, json: { error: "request body too large (max 4096 bytes)" } };
  const c = deps.config;
  if (!c.privateKey || !c.mandateId || !c.daoId || !c.apiKey || !c.model || !c.githubToken)
    return { status: 503, json: { error: "Payments aren't configured on this deployment." } };

  let input: unknown;
  try {
    input = JSON.parse(req.body);
  } catch {
    return { status: 400, json: { error: "body must be valid JSON", field: "body" } };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { status: 400, json: { error: "body must be a JSON object", field: "body" } };
  const r = input as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!FIELDS.has(k)) return { status: 400, json: { error: `unknown field: ${k.slice(0, 40)}`, field: k.slice(0, 40) } };
  const parsedRepo = parseRepo(r.repo);
  if ("error" in parsedRepo) return { status: 400, json: { error: parsedRepo.error, field: "repo" } };
  if (typeof r.number !== "number" || !Number.isInteger(r.number) || r.number < 1 || r.number > 1_000_000_000)
    return { status: 400, json: { error: "number must be a positive integer", field: "number" } };
  const range = parseRange(r.range, deps.now());
  if ("error" in range) return { status: 400, json: { error: range.error, field: "range" } };
  if (typeof r.proof !== "object" || r.proof === null || Array.isArray(r.proof)) return { status: 400, json: { error: "proof must be an object", field: "proof" } };
  const repo = parsedRepo.repo;
  const number = r.number;

  const lim = limiter(req.ip, deps.now());
  if (!lim.ok) return { status: 429, json: { error: "too many requests, slow down", retryAfterSec: lim.retryAfterSec } };

  if (!deps.payable.has(repo)) return { status: 403, json: { error: "this repository is not set up for payments" } };

  const auth = await deps.verifyCouncil(r.proof, deps.now());
  if (!auth.ok) return { status: 401, json: { error: auth.error } };

  let pr: Awaited<ReturnType<typeof getMergedPr>>;
  try {
    pr = await deps.getMergedPr(repo, number, { token: c.githubToken });
  } catch (e) {
    if (e instanceof GitHubError && (e.retryAfterSec !== null || e.status === 429))
      return { status: 429, json: { error: "GitHub rate limit reached, try again shortly.", retryAfterSec: e.retryAfterSec ?? 60 } };
    return { status: 502, json: { error: "GitHub could not be read. Try again in a minute." } };
  }
  if (!pr) return { status: 404, json: { error: "pull request not found or not merged" } };
  const mergedDay = pr.mergedAt.slice(0, 10);
  if (mergedDay < range.from || mergedDay > range.to) return { status: 404, json: { error: "pull request was not merged in the chosen range" } };

  let mandate: MandateView;
  let handled: Set<string>;
  try {
    const [log, requests, m] = await Promise.all([deps.getWorkLog(), deps.getRequests(), deps.getMandate()]);
    handled = new Set([
      ...log.filter((e) => (e.kind === "Paid" || e.kind === "PaidApproved") && e.evidence_url).map((e) => e.evidence_url!),
      ...requests.filter((q) => q.state === "Pending").map((q) => q.evidence_url),
    ]);
    mandate = m;
  } catch {
    return { status: 502, json: { error: "The chain could not be read. Try again in a minute." } };
  }
  if (handled.has(pr.url)) return { status: 409, json: { error: DUPLICATE } };

  // A fired or expired agent has no access key left, so there is nothing to sign with.
  if (mandate.status !== "Active" || mandate.term_end_ms <= deps.now()) return { status: 409, json: { error: NOT_ACTIVE } };

  let out: Awaited<ReturnType<typeof complete>>;
  try {
    out = await deps.complete(decisionMessages(mandate, pr), c.apiKey, { model: c.model });
  } catch (e) {
    console.error(`pay: AI request failed for ${pr.url}: ${errText(e, deps.secrets ?? [])}`);
    return { status: 502, json: { error: "The AI request failed. Try again in a minute." } };
  }
  // Recipient, amount and clause come only from the PR facts and the gated model decision.
  const action = await validate(parseDecision(out.text), pr, mandate, handled, deps.accountExists);
  if (action.kind === "log") {
    // A failed account lookup is a transient chain error, not a decision about the PR.
    if (action.summary.startsWith(RPC_CHECK_PREFIX)) {
      console.error(`pay: ${errText(action.summary, deps.secrets ?? [])} for ${pr.url}`);
      return { status: 502, json: { error: "Could not check the recipient account on NEAR. Try again." } };
    }
    return { status: 200, json: { kind: "skip", reason: action.summary } };
  }

  const amountNear = yoctoToNear(action.amountYocto);
  const args = {
    recipient: action.recipient,
    amount: action.amountYocto,
    clause_id: action.clauseId,
    evidence_url: action.evidenceUrl,
    receipt_hash: out.hash,
  };
  let txHash: string;
  try {
    const ops = deps.ops();
    txHash = (action.kind === "spend" ? await ops.spend(args) : await ops.request_spend({ ...args, rationale: truncateUtf8(action.rationale, MAX_RATIONALE_BYTES) })).txHash;
  } catch (e) {
    return sendFailure(e, deps.secrets ?? []);
  }
  if (action.kind === "request") return { status: 200, json: { kind: "request", txHash, amountNear, recipient: action.recipient } };

  let labelled = false;
  if (c.labelToken) {
    try {
      await deps.labelPaid({ repo, number, amountNear, recipient: action.recipient, txHash, receipt: out.receipt, receiptHash: out.hash }, { token: c.labelToken });
      labelled = true;
    } catch (e) {
      console.error(`pay: labelling ${pr.url} failed: ${errText(e, deps.secrets ?? [])}`);
    }
  }
  return { status: 200, json: { kind: "spend", txHash, amountNear, recipient: action.recipient, labelled } };
}

export async function handle(req: HandleReq, deps: PayDeps): Promise<HandleRes> {
  return scrub(await run(req, deps), deps.secrets ?? []);
}

const secrets = () => [
  process.env.AGENT_PRIVATE_KEY ?? "",
  process.env.NEARAI_API_KEY ?? "",
  process.env.GITHUB_TOKEN ?? "",
  process.env.GITHUB_LABEL_TOKEN ?? "",
];

// One Ops per instance so its queue serialises every send (no nonce reuse across concurrent requests).
let cachedOps: { key: string; ops: Ops } | null = null;
function agentOps(mandateId: string, privateKey: string, rpcUrl: string): Ops {
  const key = `${mandateId}\n${privateKey}\n${rpcUrl}`;
  if (cachedOps?.key !== key) cachedOps = { key, ops: buildOps(accountFactory({ mandateId, privateKey, rpcUrl })) };
  return cachedOps.ops;
}

/** Vercel Node handler. */
export default nodeHandler(
  (req) => {
    const env = process.env;
    const near = { rpcUrl: testnetRpcUrl(env.NEAR_RPC_URL) };
    const config: PayConfig = {
      privateKey: env.AGENT_PRIVATE_KEY ?? "",
      mandateId: env.MANDATE_ID ?? "",
      daoId: env.DAO_ID ?? "",
      apiKey: env.NEARAI_API_KEY ?? "",
      model: env.NEARAI_MODEL ?? "",
      githubToken: env.GITHUB_TOKEN ?? "",
      labelToken: env.GITHUB_LABEL_TOKEN ?? "",
    };
    return handle(req, {
      verifyCouncil: (proof, now) => verifyCouncil(proof, { near, daoId: config.daoId, now }),
      getMergedPr,
      complete,
      getMandate: () => getMandate(near, config.mandateId),
      getWorkLog: () => getWorkLog(near, config.mandateId),
      getRequests: () => getRequests(near, config.mandateId),
      accountExists: (id) => accountExists(near, id),
      ops: () => agentOps(config.mandateId, config.privateKey, near.rpcUrl),
      labelPaid: (p, d) => labelPaid(p, d),
      now: () => Date.now(),
      secrets: secrets(),
      payable: payableRepos(env.PAYABLE_REPOS),
      config,
    });
  },
  { maxBody: MAX_BODY, secrets },
);
