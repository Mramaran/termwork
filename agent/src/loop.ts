import { accountExists, viewMandate, type Config, type LogEntry, type MandateView, type Renewal, type SpendRequest } from "@termwork/shared";
import { complete } from "./nearai.js";
import { decisionMessages, reportMessages } from "./prompts.js";
import { loadReplay, saveReceipt } from "./receipts.js";
import { checkCitations } from "./report.js";
import type { PullRequestFact, SourceAdapter } from "./sources/types.js";
import { parseDecision, validate, type Action } from "./validate.js";

export interface ModelOutput {
  text: string;
  hash: string;
}

export interface SignerResponse {
  status: number;
  json: { txHash?: string; error?: string; rpcError?: unknown };
}

/** Everything the loop touches outside itself. Tests inject mocks for all of it. */
export interface LoopDeps {
  now(): number;
  getMandate(): Promise<MandateView>;
  getWorkLog(from: number, limit: number): Promise<LogEntry[]>;
  getRenewal(): Promise<Renewal | null>;
  getRequests(): Promise<SpendRequest[]>;
  source: SourceAdapter;
  exists(accountId: string): Promise<boolean>;
  /** Model decision for one PR. null = no decision available (skip this tick). Throws on model failure. */
  decide(pr: PullRequestFact, m: MandateView): Promise<ModelOutput | null>;
  generateReport(m: MandateView, log: LogEntry[], previousError?: string): Promise<ModelOutput | null>;
  signer: { post(path: string, body: unknown): Promise<SignerResponse> };
  log(line: string): void;
}

export interface TickResult {
  stopped: boolean;
}

const PAGE = 100;
const RPC_RETRY_PREFIX = "recipient check failed (rpc)";

async function readFullLog(d: LoopDeps): Promise<LogEntry[]> {
  const all: LogEntry[] = [];
  for (;;) {
    const page = await d.getWorkLog(all.length, PAGE);
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/** PRs the chain already knows about: paid, pending a vote, or logged as work (except transient rpc failures). */
function handledSet(log: LogEntry[], requests: SpendRequest[]): Set<string> {
  const s = new Set<string>();
  for (const e of log) {
    if (!e.evidence_url) continue;
    if (e.kind === "Paid" || e.kind === "PaidApproved") s.add(e.evidence_url);
    else if (e.kind === "Work" && !(e.note ?? "").startsWith(RPC_RETRY_PREFIX)) s.add(e.evidence_url);
  }
  for (const r of requests) if (r.state === "Pending") s.add(r.evidence_url);
  return s;
}

/** Calls the signer once. Never retries: a 504 means the outcome is unknown and the next tick re-reads the chain. */
async function send(d: LoopDeps, label: string, path: string, body: unknown): Promise<boolean> {
  try {
    const res = await d.signer.post(path, body);
    if (res.status === 200) {
      d.log(`${label}: ok tx=${res.json.txHash ?? "?"}`);
      return true;
    }
    if (res.status === 504) d.log(`${label}: outcome unknown, will re-check chain next tick`);
    else d.log(`${label}: signer ${res.status} ${res.json.error ?? ""}`.trim());
  } catch (e) {
    d.log(`${label}: signer unreachable: ${(e as Error).message}`);
  }
  return false;
}

async function act(d: LoopDeps, a: Action, receiptHash: string | null): Promise<void> {
  const rh = receiptHash ?? "";
  if (a.kind === "spend") {
    await send(d, `spend ${a.evidenceUrl}`, "/spend", {
      recipient: a.recipient,
      amount: a.amountYocto,
      clause_id: a.clauseId,
      evidence_url: a.evidenceUrl,
      receipt_hash: rh,
    });
  } else if (a.kind === "request") {
    await send(d, `request ${a.evidenceUrl}`, "/request_spend", {
      recipient: a.recipient,
      amount: a.amountYocto,
      clause_id: a.clauseId,
      evidence_url: a.evidenceUrl,
      receipt_hash: rh,
      rationale: a.rationale,
    });
  } else {
    await send(d, `log ${a.evidenceUrl} (${a.summary})`, "/log_work", {
      clause_id: a.clauseId,
      summary: a.summary,
      evidence_url: a.evidenceUrl,
      receipt_hash: receiptHash,
    });
  }
}

async function fileRenewal(d: LoopDeps, m: MandateView, termSecs: number): Promise<void> {
  const log = await readFullLog(d);
  const indices = new Set(log.map((e) => e.index));
  let reason = "";
  let previous: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    let out: ModelOutput | null;
    try {
      out = await d.generateReport(m, log, previous);
    } catch (e) {
      d.log(`renewal: report generation failed: ${(e as Error).message}`);
      return; // retry next tick
    }
    if (!out) {
      d.log("renewal: no stored receipt for the report, skipping");
      return;
    }
    const check = checkCitations(out.text, indices);
    if (check.ok) {
      await send(d, "renewal", "/propose_renewal", {
        report_text: out.text,
        requested_term_secs: termSecs,
        requested_topup: "0",
      });
      return;
    }
    reason = check.reason;
    previous = reason;
    d.log(`renewal: report attempt ${attempt + 1} rejected: ${reason}`);
  }
  await send(d, "renewal note", "/log_work", {
    clause_id: 1,
    summary: `renewal report rejected: ${reason}`,
    evidence_url: null,
    receipt_hash: null,
  });
}

export async function tick(d: LoopDeps): Promise<TickResult> {
  const m = await d.getMandate();
  if (m.status !== "Active") {
    d.log(`mandate status is ${m.status}, stopping`);
    return { stopped: true };
  }
  const now = d.now();
  if (now >= m.term_end_ms) {
    d.log("term ended, expiring");
    await send(d, "expire", "/expire", {});
    return { stopped: true };
  }

  const [log, requests, prs] = await Promise.all([readFullLog(d), d.getRequests(), d.source.listMerged()]);
  const handled = handledSet(log, requests);

  for (const pr of prs) {
    if (handled.has(pr.url)) continue;
    try {
      const out = await d.decide(pr, m);
      if (!out) continue;
      const action = await validate(parseDecision(out.text), pr, m, handled, d.exists);
      await act(d, action, out.hash);
    } catch (e) {
      d.log(`pr ${pr.url}: skipped this tick: ${(e as Error).message}`);
    }
  }

  const termMs = m.term_end_ms - m.term_start_ms;
  const windowStart = m.term_end_ms - Math.floor((termMs * 30) / 100);
  if (now >= windowStart) {
    const renewal = await d.getRenewal();
    const filedThisTerm = renewal !== null && renewal.timestamp_ms >= m.term_start_ms;
    if (!filedThisTerm) await fileRenewal(d, m, Math.floor(termMs / 1000));
  }
  return { stopped: false };
}

/** Builds the real dependencies: chain views, signer HTTP, NEAR AI (live) or stored receipts (replay). */
export function realDeps(cfg: Config, source: SourceAdapter): LoopDeps {
  const modelOutput = async (messages: Parameters<typeof complete>[0], key: string): Promise<ModelOutput | null> => {
    if (cfg.AGENT_MODE === "replay") {
      const r = loadReplay(key);
      return r ? { text: r.text, hash: r.hash } : null;
    }
    const r = await complete(messages, cfg.NEARAI_API_KEY);
    return { text: r.text, hash: saveReceipt(r.receipt, undefined, key) };
  };
  return {
    now: () => Date.now(),
    getMandate: () => viewMandate<MandateView>("get_mandate"),
    getWorkLog: (from, limit) => viewMandate<LogEntry[]>("get_work_log", { from, limit }),
    getRenewal: () => viewMandate<Renewal | null>("get_renewal"),
    getRequests: () => viewMandate<SpendRequest[]>("get_requests"),
    source,
    exists: accountExists,
    decide: async (pr, m) => {
      const out = await modelOutput(decisionMessages(m, pr), pr.url);
      if (!out) console.log(`no stored receipt for ${pr.url}`);
      return out;
    },
    generateReport: async (m, log, previousError) => {
      const key = `renewal:${m.term_number}`;
      const out = await modelOutput(reportMessages(m, log, previousError), key);
      if (!out) console.log(`no stored receipt for ${key}`);
      return out;
    },
    signer: {
      async post(path, body) {
        const res = await fetch(`${cfg.SIGNER_URL}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.SIGNER_TOKEN}` },
          body: JSON.stringify(body),
        });
        let json: SignerResponse["json"] = {};
        try {
          json = (await res.json()) as SignerResponse["json"];
        } catch {
          /* non-JSON body */
        }
        return { status: res.status, json };
      },
    },
    log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
  };
}
