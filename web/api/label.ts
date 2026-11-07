import { testnetRpcUrl, type LogEntry, type SpendRequest } from "@termwork/shared";
import { labelPaid, type PaidInfo } from "./_lib/github-write";
import { nodeHandler, scrub, type HandleReq, type HandleRes } from "./_lib/http";
import { parseRepo, payableRepos } from "./_lib/input";
import { makeLimiter } from "./_lib/limits";
import { getRequests, getWorkLog, txStatus, type TxStatus } from "./_lib/near";

export interface LabelConfig {
  mandateId: string;
  daoId: string;
  labelToken: string;
}

export interface LabelDeps {
  txStatus: (hash: string, sender: string) => Promise<TxStatus>;
  getRequests: () => Promise<SpendRequest[]>;
  getWorkLog: () => Promise<LogEntry[]>;
  labelPaid: (p: PaidInfo, d: { token: string }) => Promise<"labelled" | "already">;
  now: () => number;
  /** Repos that may be paid for real (lower-cased owner/name). */
  payable: Set<string>;
  config: LabelConfig;
}
export type { HandleReq, HandleRes };

export const limiter = makeLimiter(30, 100);

const MAX_BODY = 4096;
const FIELDS = new Set(["repo", "number", "txHash", "sender"]);
const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ACCOUNT_RE = /^(?=.{2,64}$)[a-z\d]+(?:[-_][a-z\d]+)*(?:\.[a-z\d]+(?:[-_][a-z\d]+)*)*$/;
const NOT_CONFIRMED: HandleRes = { status: 409, json: { error: "payment not confirmed" } };

function yoctoToNear(y: string): string {
  const s = y.padStart(25, "0");
  const whole = s.slice(0, -24);
  const frac = s.slice(-24).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** The proposal id when the transaction approves one through act_proposal, else null. */
function approvedProposal(tx: TxStatus): number | null {
  for (const a of tx.transaction.actions) {
    if (typeof a !== "object" || !("FunctionCall" in a)) continue;
    const call = (a as { FunctionCall: { method_name: string; args: string } }).FunctionCall;
    if (call.method_name !== "act_proposal") continue;
    try {
      const args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8")) as { id?: unknown; action?: unknown };
      if (args.action === "VoteApprove" && typeof args.id === "number" && Number.isInteger(args.id)) return args.id;
    } catch {
      // not JSON: not an approval
    }
  }
  return null;
}

const succeeded = (s: TxStatus["status"]) => typeof s === "object" && ("SuccessValue" in s || "SuccessReceiptId" in s);

async function run(req: HandleReq, deps: LabelDeps): Promise<HandleRes> {
  if (req.method !== "POST") return { status: 405, json: { error: "use POST" }, headers: { Allow: "POST" } };
  if (req.oversized || new TextEncoder().encode(req.body).length > MAX_BODY) return { status: 413, json: { error: "request body too large (max 4096 bytes)" } };
  const c = deps.config;
  if (!c.mandateId || !c.daoId || !c.labelToken) return { status: 503, json: { error: "Labelling isn't configured on this deployment." } };

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
  if (typeof r.txHash !== "string" || !TX_HASH_RE.test(r.txHash)) return { status: 400, json: { error: "txHash must be a NEAR transaction hash", field: "txHash" } };
  if (typeof r.sender !== "string" || !ACCOUNT_RE.test(r.sender)) return { status: 400, json: { error: "sender must be a NEAR account id", field: "sender" } };
  const repo = parsedRepo.repo;
  const { number, txHash, sender } = { number: r.number, txHash: r.txHash, sender: r.sender };

  const lim = limiter(req.ip, deps.now());
  if (!lim.ok) return { status: 429, json: { error: "too many requests, slow down", retryAfterSec: lim.retryAfterSec } };

  if (!deps.payable.has(repo)) return { status: 403, json: { error: "this repository is not set up for payments" } };

  let tx: TxStatus;
  let requests: SpendRequest[];
  let log: LogEntry[];
  try {
    [tx, requests, log] = await Promise.all([deps.txStatus(txHash, sender), deps.getRequests(), deps.getWorkLog()]);
  } catch {
    return { status: 502, json: { error: "The chain could not be read. Try again in a minute." } };
  }

  // The hash alone proves nothing: the tx must be a successful approval sent to the DAO, and the
  // proposal it approves must be this PR's spend request, executed and recorded in the work log.
  if (!succeeded(tx.status) || tx.transaction.receiver_id !== c.daoId || tx.transaction.signer_id !== sender) return NOT_CONFIRMED;
  const proposalId = approvedProposal(tx);
  if (proposalId === null) return NOT_CONFIRMED;
  const prUrl = `https://github.com/${repo}/pull/${number}`.toLowerCase();
  const match = requests.find((q) => q.proposal_id === proposalId && q.state === "Executed" && q.evidence_url.toLowerCase() === prUrl);
  if (!match) return NOT_CONFIRMED;
  if (!log.some((e) => e.kind === "PaidApproved" && e.evidence_url?.toLowerCase() === prUrl)) return NOT_CONFIRMED;

  try {
    const result = await deps.labelPaid(
      { repo, number, amountNear: yoctoToNear(match.amount), recipient: match.recipient, txHash, receipt: null, receiptHash: match.receipt_hash },
      { token: c.labelToken },
    );
    return { status: 200, json: { result } };
  } catch (e) {
    console.error(`label: labelling ${prUrl} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { status: 502, json: { error: "GitHub could not be updated. Try again in a minute." } };
  }
}

export async function handle(req: HandleReq, deps: LabelDeps & { secrets?: string[] }): Promise<HandleRes> {
  return scrub(await run(req, deps), deps.secrets ?? []);
}

const secrets = () => [process.env.GITHUB_LABEL_TOKEN ?? ""];

/** Vercel Node handler. */
export default nodeHandler(
  (req) => {
    const env = process.env;
    const near = { rpcUrl: testnetRpcUrl(env.NEAR_RPC_URL) };
    const config: LabelConfig = { mandateId: env.MANDATE_ID ?? "", daoId: env.DAO_ID ?? "", labelToken: env.GITHUB_LABEL_TOKEN ?? "" };
    return handle(req, {
      txStatus: (hash, sender) => txStatus(near, hash, sender),
      getRequests: () => getRequests(near, config.mandateId),
      getWorkLog: () => getWorkLog(near, config.mandateId),
      labelPaid: (p, d) => labelPaid(p, d),
      now: () => Date.now(),
      payable: payableRepos(env.PAYABLE_REPOS),
      config,
      secrets: secrets(),
    });
  },
  { maxBody: MAX_BODY, secrets },
);
