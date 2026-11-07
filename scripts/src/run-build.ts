import { createHash } from "node:crypto";
import type { LogEntry, MandateView, Mission, SpendRequest } from "@termwork/shared";
import { parseCompletion, type InferenceReceipt } from "../../agent/src/receipts.js";
import type { PullRequestFact } from "../../agent/src/sources/types.js";
import { parseDecision } from "../../agent/src/validate.js";

/** The parts of demo-output.json the export reads. It holds public ids and hashes only. */
export interface DemoOutput {
  startedAt: string;
  accounts: { dao: string; mandate: string; renewalReport: string; contributors: Record<string, string> };
  proposals: Record<string, number>;
  txs: Record<string, { hash: string; explorer?: string }>;
  termEnded: { explorer?: string; rpcError: string };
  agentAttempt: { result: string; rpcError?: string };
  /** The pull requests the agent worked (real-PR runs). Fixture runs leave it out and export-run reads fixtures/prs.json. */
  prFacts?: PullRequestFact[];
}

/** One big-spend request and the DAO's decision on it. */
export interface BigSpend {
  prNumber: number | null;
  prUrl: string;
  requestId: number;
  proposalId: number;
  amount: string;
  recipient: string;
  requestTx: string | null;
  /** The council's votes, in order. When approved, the last one executed the payment. */
  voteTxs: string[];
  approved: boolean;
  /** The DAO proposal status (Approved, Rejected), else the request state. */
  state: string;
}

export interface AiAnswer {
  qualifies: boolean;
  clause_id: number;
  amount_near: string;
  rationale: string;
}

export interface RunPr {
  url: string;
  number: number;
  title: string;
  firstTime: boolean;
  changedLines: number;
  labels: string[];
  nearAccount: string | null;
  ai: AiAnswer | null;
  receiptHash: string | null;
  verified: boolean;
  outcome: "paid" | "requested" | "skipped";
  outcomeNote: string;
  amount: string | null;
  tx: string | null;
  logIndex: number | null;
}

export interface RunData {
  recordedAt: string;
  network: "testnet";
  mandate: string;
  dao: string;
  model: string;
  mission: Mission;
  spendThreshold: string;
  maxRequest: string;
  termSecs: number;
  hire: { proposalId: number; proposeTx: string; voteTxs: string[] };
  prs: RunPr[];
  bigSpend: { requestId: number; proposalId: number; requestTx: string | null; rejectTxs: string[]; state: string };
  /** Every big-spend request with the DAO's decision; bigSpend above is the first, kept for older readers. */
  bigSpends: BigSpend[];
  renewal: { reportText: string; reportHash: string; logIndex: number; proposalTx: string | null; receiptHash: string; rejectTxs: string[] };
  budget: { total: string; spent: string; availableAtReport: string };
  end: {
    termEndedTx: string;
    termEndedError: string;
    fireProposeTx: string;
    fireVoteTxs: string[];
    sweepTx: string;
    firedAmount: string;
    sweptAmount: string;
    agentAttempt: string;
  };
  log: LogEntry[];
}

export interface BuildInput {
  demo: DemoOutput;
  mandate: MandateView;
  log: LogEntry[];
  requests: SpendRequest[];
  /** DAO get_proposal results; each is read for `id` and `status`. */
  proposals: unknown[];
  receipts: Record<string, InferenceReceipt>;
  /** receipts/index.json: PR url or `renewal:<n>` -> receipt hash. */
  index: Record<string, string>;
  prFacts: PullRequestFact[];
  /** Keys: `paid:<log index>`, `request:<request id>`, `renewal`. A missing key means the hash was not found. */
  txLookup: Record<string, string>;
}

const ONE_NEAR = 10n ** 24n;
/** Yocto string -> "0.2" (trailing zeros trimmed). Used only in the prose notes. */
function nearText(y: string): string {
  const v = BigInt(y);
  const frac = (v % ONE_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return `${v / ONE_NEAR}${frac ? "." + frac : ""}`;
}

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null) throw new Error(`run.json: missing ${what}`);
  return v;
};

function txsWithPrefix(demo: DemoOutput, prefix: string): string[] {
  return Object.keys(demo.txs)
    .filter((k) => k.startsWith(prefix))
    .sort()
    .map((k) => demo.txs[k]!.hash);
}

/** Parses the model's decision out of a stored receipt; null when it cannot be parsed. */
export function aiFromReceipt(r: InferenceReceipt | undefined): AiAnswer | null {
  if (!r) return null;
  let text: string;
  try {
    text = parseCompletion(r.responseText).text;
  } catch {
    text = r.responseText;
  }
  const d = parseDecision(text);
  return "error" in d ? null : d;
}

export function buildRun(input: BuildInput): RunData {
  const { demo, mandate, log, requests, receipts, index, prFacts, txLookup } = input;

  const prs: RunPr[] = prFacts.map((pr) => {
    const entry = log.find((e) => e.evidence_url === pr.url && ["Paid", "PaidApproved", "Requested", "Work"].includes(e.kind));
    const request = requests.find((q) => q.evidence_url === pr.url);
    const hash = entry?.receipt_hash ?? index[pr.url] ?? null;
    const receipt = hash ? receipts[hash] : undefined;
    let outcome: RunPr["outcome"] = "skipped";
    let outcomeNote = "no work-log entry for this pull request";
    let amount: string | null = null;
    let tx: string | null = null;
    if (entry?.kind === "Paid" || entry?.kind === "PaidApproved") {
      outcome = "paid";
      amount = entry.amount;
      outcomeNote = `paid ${nearText(entry.amount ?? "0")} NEAR under clause ${entry.clause_id}`;
      tx = txLookup[`paid:${entry.index}`] ?? null;
    } else if (entry?.kind === "Requested") {
      outcome = "requested";
      amount = entry.amount;
      outcomeNote = `asked the DAO for ${nearText(entry.amount ?? "0")} NEAR (over the spend threshold)`;
      tx = request ? (txLookup[`request:${request.id}`] ?? null) : null;
    } else if (entry) {
      outcomeNote = (entry.note ?? "skipped").replace(/^skipped:\s*/i, "");
    }
    return {
      url: pr.url,
      number: pr.number,
      title: pr.title,
      firstTime: pr.firstTime,
      changedLines: pr.changedLines,
      labels: pr.labels,
      nearAccount: pr.nearAccount,
      ai: aiFromReceipt(receipt),
      receiptHash: hash,
      verified: receipt?.verified === true,
      outcome,
      outcomeNote,
      amount,
      tx,
      logIndex: entry?.index ?? null,
    };
  });

  const bigPr = prs.find((p) => p.outcome === "requested");
  const bigReq = need(
    requests.find((q) => q.evidence_url === bigPr?.url),
    "the big-spend request",
  );
  const proposalId = need(bigReq.proposal_id, "the big-spend proposal id");
  const proposalStatus = (id: number | null): string | undefined =>
    (input.proposals.find((p) => (p as { id?: number } | null)?.id === id) as { status?: string } | undefined)?.status;
  const proposal = { status: proposalStatus(proposalId) };
  const bigSpends: BigSpend[] = requests.map((q) => {
    const status = proposalStatus(q.proposal_id);
    const perRequest = txsWithPrefix(demo, `bigSpend.r${q.id}.vote`);
    return {
      prNumber: prs.find((p) => p.url === q.evidence_url)?.number ?? null,
      prUrl: q.evidence_url,
      requestId: q.id,
      proposalId: need(q.proposal_id, `the proposal id of request ${q.id}`),
      amount: q.amount,
      recipient: q.recipient,
      requestTx: txLookup[`request:${q.id}`] ?? null,
      voteTxs: perRequest.length > 0 ? perRequest : q.id === bigReq.id ? txsWithPrefix(demo, "bigSpend.reject") : [],
      approved: status === "Approved" || q.state === "Executed",
      state: status ?? q.state,
    };
  });

  const renewalEntry = need(
    log.find((e) => e.kind === "RenewalProposed"),
    "the RenewalProposed log entry",
  );
  const reportText = demo.accounts.renewalReport;
  const reportHash = need(renewalEntry.receipt_hash, "the report hash on the RenewalProposed entry");
  if (createHash("sha256").update(reportText, "utf8").digest("hex") !== reportHash)
    throw new Error("run.json: the saved renewal report does not hash to the on-chain report hash");
  const renewalReceiptHash = need(index["renewal:1"], "receipts/index.json renewal:1");

  const paidBefore = log
    .filter((e) => (e.kind === "Paid" || e.kind === "PaidApproved") && e.index < renewalEntry.index)
    .reduce((s, e) => s + BigInt(e.amount ?? "0"), 0n);
  const fired = need(
    log.find((e) => e.kind === "Fired"),
    "the Fired log entry",
  );
  const swept = need(
    log.find((e) => e.kind === "Swept"),
    "the Swept log entry",
  );
  const tx = (name: string): string => need(demo.txs[name]?.hash, `demo-output tx ${name}`);

  return {
    recordedAt: demo.startedAt,
    network: "testnet",
    mandate: demo.accounts.mandate,
    dao: demo.accounts.dao,
    model: need(receipts[renewalReceiptHash]?.model, "the renewal receipt model"),
    mission: need(mandate.mission, "the mission"),
    spendThreshold: mandate.spend_threshold,
    maxRequest: mandate.max_request,
    termSecs: Math.round((mandate.term_end_ms - mandate.term_start_ms) / 1000),
    hire: { proposalId: need(demo.proposals.hire, "hire proposal id"), proposeTx: tx("hire.propose"), voteTxs: txsWithPrefix(demo, "hire.vote") },
    prs,
    bigSpend: {
      requestId: bigReq.id,
      proposalId,
      requestTx: txLookup[`request:${bigReq.id}`] ?? null,
      rejectTxs: txsWithPrefix(demo, "bigSpend.reject"),
      state: proposal.status ?? bigReq.state,
    },
    bigSpends,
    renewal: {
      reportText,
      reportHash,
      logIndex: renewalEntry.index,
      proposalTx: txLookup["renewal"] ?? null,
      receiptHash: renewalReceiptHash,
      rejectTxs: txsWithPrefix(demo, "renewal.reject"),
    },
    budget: { total: mandate.budget_total, spent: mandate.budget_spent, availableAtReport: (BigInt(mandate.budget_total) - paidBefore).toString() },
    end: {
      termEndedTx: tx("termEnded.spend"),
      termEndedError: demo.termEnded.rpcError,
      fireProposeTx: tx("fire.propose"),
      fireVoteTxs: txsWithPrefix(demo, "fire.vote"),
      sweepTx: tx("sweep"),
      firedAmount: need(fired.amount, "Fired amount"),
      sweptAmount: need(swept.amount, "Swept amount"),
      agentAttempt: demo.agentAttempt.result,
    },
    log,
  };
}

/** One transaction as the nearblocks v3 account list returns it (only the fields used). */
export interface ChainTx {
  method: string;
  hash: string;
  ok: boolean;
  blockMs: number;
}

/**
 * Matches the mandate's transactions to log entries by method name and order, never by guessing.
 * The n-th successful `spend` is the n-th Paid entry, the n-th `request_spend` is request n, and
 * `propose_renewal` is the renewal. A match is dropped if its block time is not at or before the
 * log entry's time (within 30 s), so a mismatch yields a missing hash.
 */
export function matchTxs(txns: ChainTx[], log: LogEntry[], requests: SpendRequest[]): Record<string, string> {
  const ordered = txns.filter((t) => t.ok).sort((a, b) => a.blockMs - b.blockMs);
  const by = (m: string) => ordered.filter((t) => t.method === m);
  const out: Record<string, string> = {};
  const near = (t: ChainTx | undefined, logMs: number): string | undefined => (t && t.blockMs <= logMs + 1000 && logMs - t.blockMs <= 30_000 ? t.hash : undefined);
  const spends = by("spend");
  log
    .filter((e) => e.kind === "Paid")
    .forEach((e, n) => {
      const h = near(spends[n], e.timestamp_ms);
      if (h) out[`paid:${e.index}`] = h;
    });
  const reqTxs = by("request_spend");
  const reqLog = log.filter((e) => e.kind === "Requested");
  requests.forEach((q, n) => {
    const h = near(reqTxs[n], reqLog[n]?.timestamp_ms ?? 0);
    if (h) out[`request:${q.id}`] = h;
  });
  const renewal = log.find((e) => e.kind === "RenewalProposed");
  const h = renewal ? near(by("propose_renewal")[0], renewal.timestamp_ms) : undefined;
  if (h) out["renewal"] = h;
  return out;
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["an ed25519 private key", /ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/],
  ["an sk- API key", /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/],
];

/** Throws if the serialised run holds anything that looks like a private key or API key. */
export function assertNoSecrets(json: string): void {
  for (const [what, re] of SECRET_PATTERNS) if (re.test(json)) throw new Error(`refusing to write run.json: a value looks like ${what}`);
}

/** Serialises and scans; the only way export-run produces the file text. */
export function serializeRun(run: RunData): string {
  const json = JSON.stringify(run, null, 2) + "\n";
  assertNoSecrets(json);
  return json;
}
