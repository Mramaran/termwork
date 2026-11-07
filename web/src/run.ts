/** Pure helpers for the judge view: turn the recorded run (public/run.json) into steps, feed lines and checklists. */
import type { LogEntry, Mission } from "@termwork/shared";
import { explorerAccount, explorerTx, fmtNear, publicUrl, type AccessKeyInfo, type Receipt } from "./chain";

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

/** Shape of web/public/run.json, written by scripts/src/run-build.ts. */
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
  /** Every big-spend request with the DAO's decision. Absent in runs recorded before approvals were supported. */
  bigSpends?: {
    prNumber: number | null;
    prUrl: string;
    requestId: number;
    proposalId: number;
    amount: string;
    recipient: string;
    requestTx: string | null;
    voteTxs: string[];
    approved: boolean;
    state: string;
  }[];
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

export type StepId = "hire" | "work" | "vote" | "renew" | "fired";

export interface FeedLine {
  text: string;
  tone: "info" | "ok" | "warn" | "bad";
  detail?: { ai: RunData["prs"][number]["ai"]; rules: string[] };
}

export interface CheckItem {
  label: string;
  href: string | null;
  kind: "tx" | "receipt" | "live-keys" | "report-hash" | "recorded";
  receiptHash?: string;
  tx?: string;
  /** Receipt items only: the response text must equal this for the tick. */
  expectText?: string;
}

export interface Step {
  title: string;
  feed: FeedLine[];
  checks: CheckItem[];
}

/** NEAR text rounded to 3 decimals ("2.433", "0.115"); fmtNear alone truncates. */
const near = (yocto: string | null | undefined): string => (yocto ? fmtNear((BigInt(yocto) + 5n * 10n ** 20n).toString(), 3) : "0");

/** A transaction item; with no hash it links to the mandate's explorer page and is never ticked. */
const txCheck = (label: string, tx: string | null | undefined, run: RunData): CheckItem =>
  tx ? { label, href: explorerTx(tx), kind: "tx", tx } : { label: `${label}, see on explorer`, href: explorerAccount(run.mandate), kind: "tx" };

function duration(secs: number): string {
  if (secs % 60 === 0) {
    const m = secs / 60;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  return `${secs} seconds`;
}

function hireStep(run: RunData): Step {
  const feed: FeedLine[] = [
    { text: `DAO proposal #${run.hire.proposalId}: hire "${run.mission.title}"`, tone: "info" },
    { text: `The council approved it with ${run.hire.voteTxs.length} vote${run.hire.voteTxs.length === 1 ? "" : "s"}`, tone: "ok" },
    ...run.mission.clauses.map((c): FeedLine => ({ text: `Clause ${c.id}: ${c.text}`, tone: "info" })),
    { text: `Budget ${near(run.budget.total)} NEAR, spend limit ${near(run.spendThreshold)} NEAR per payment`, tone: "info" },
    { text: `Term length ${duration(run.termSecs)}`, tone: "info" },
  ];
  const checks: CheckItem[] = [
    txCheck("Hire proposal", run.hire.proposeTx, run),
    ...run.hire.voteTxs.map((h, i) => txCheck(`Council vote ${i + 1}`, h, run)),
    // the vote that passed the proposal ran hire(), which added the agent's key
    txCheck("Agent key created", run.hire.voteTxs[run.hire.voteTxs.length - 1], run),
  ];
  return { title: "Hire", feed, checks };
}

function prLines(run: RunData, pr: RunPr): FeedLine[] {
  const lines: FeedLine[] = [
    {
      text: `PR #${pr.number} "${pr.title}": ${pr.changedLines} changed lines${pr.labels.length ? `, labels: ${pr.labels.join(", ")}` : ""}, NEAR account: ${pr.nearAccount ?? "none"}`,
      tone: "info",
    },
  ];
  const ai = pr.ai;
  const aiText = ai ? `AI said: ${ai.qualifies ? "qualifies" : "does not qualify"}, clause ${ai.clause_id}, ${ai.amount_near} NEAR` : "AI said: no usable answer";
  const mismatch = pr.outcome === "skipped" && ai?.qualifies === true;
  lines.push({
    text: mismatch ? `PR #${pr.number}: AI said yes, the rules said no. ${aiText}` : aiText,
    tone: mismatch ? "warn" : "info",
    detail: { ai, rules: [pr.outcomeNote] },
  });
  if (pr.outcome === "skipped") {
    lines.push({ text: `Rules: ✗ ${pr.outcomeNote}`, tone: "bad" });
    lines.push({ text: "Result: skipped, nothing paid", tone: "bad" });
  } else if (pr.outcome === "requested") {
    lines.push({ text: `Rules: ✓ over the ${near(run.spendThreshold)} NEAR spend limit, so a DAO vote is needed`, tone: "ok" });
    lines.push({ text: `Result: sent to a DAO vote for ${near(pr.amount)} NEAR`, tone: "warn" });
  } else {
    lines.push({ text: `Rules: ✓ ${pr.outcomeNote}`, tone: "ok" });
    lines.push({ text: `Result: paid ${near(pr.amount)} NEAR`, tone: "ok" });
  }
  return lines;
}

function workStep(run: RunData): Step {
  const checks: CheckItem[] = [];
  for (const pr of run.prs) if (pr.outcome === "paid") checks.push(txCheck(`Payment for PR #${pr.number}`, pr.tx, run));
  for (const pr of run.prs) {
    if (pr.receiptHash) checks.push({ label: `AI receipt for PR #${pr.number}`, href: publicUrl(`receipts/${pr.receiptHash}.json`), kind: "receipt", receiptHash: pr.receiptHash });
  }
  checks.push({ label: "Work log (recorded on-chain)", href: explorerAccount(run.mandate), kind: "recorded" });
  return { title: "Work", feed: run.prs.flatMap((pr) => prLines(run, pr)), checks };
}

function voteStep(run: RunData): Step {
  if (run.bigSpends && run.bigSpends.length > 0) {
    const feed: FeedLine[] = [];
    const checks: CheckItem[] = [];
    for (const b of run.bigSpends) {
      const pr = `PR #${b.prNumber ?? "?"}`;
      const votes = `${b.voteTxs.length} vote${b.voteTxs.length === 1 ? "" : "s"}`;
      feed.push({ text: `${pr} asked for ${near(b.amount)} NEAR, over the ${near(run.spendThreshold)} NEAR limit: DAO proposal #${b.proposalId}`, tone: "info" });
      feed.push(
        b.approved
          ? { text: `The council voted YES (${votes}): ${near(b.amount)} NEAR paid to ${b.recipient}`, tone: "ok" }
          : { text: `The council voted NO (${votes}): request ${b.state.toLowerCase()}, no money moved`, tone: "bad" },
      );
      checks.push(txCheck(`${pr} request`, b.requestTx, run));
      b.voteTxs.forEach((h, i) => {
        const last = i === b.voteTxs.length - 1;
        const label = b.approved ? (last ? `${pr} vote ${i + 1} (YES, pays ${near(b.amount)} NEAR)` : `${pr} vote ${i + 1} (YES)`) : `${pr} vote ${i + 1} (NO)`;
        checks.push(txCheck(label, h, run));
      });
    }
    return { title: "Vote", feed, checks };
  }
  const pr = run.prs.find((p) => p.outcome === "requested");
  const feed: FeedLine[] = [
    { text: `PR #${pr?.number ?? "?"} asked for ${near(pr?.amount ?? run.maxRequest)} NEAR, over the ${near(run.spendThreshold)} NEAR limit`, tone: "info" },
    { text: `Filed DAO proposal #${run.bigSpend.proposalId}`, tone: "info" },
    { text: `Council members voted NO (${run.bigSpend.rejectTxs.length} votes)`, tone: "bad" },
    { text: `Request ${run.bigSpend.state.toLowerCase()}: no money moved`, tone: "bad" },
  ];
  const checks: CheckItem[] = [
    txCheck("Request", run.bigSpend.requestTx, run),
    ...run.bigSpend.rejectTxs.map((h, i) => txCheck(`Council vote ${i + 1} (NO)`, h, run)),
  ];
  return { title: "Vote", feed, checks };
}

function renewStep(run: RunData): Step {
  const available = near(run.budget.availableAtReport);
  const feed: FeedLine[] = [
    { text: "The agent's renewal report, verbatim:", tone: "info" },
    { text: run.renewal.reportText, tone: "info" },
    { text: `On-chain figures: budget ${near(run.budget.total)} NEAR, spent ${near(run.budget.spent)} NEAR, available at report time ${available} NEAR`, tone: "ok" },
  ];
  // A known slip in the first recorded report; only flagged when the report actually makes it.
  if (/initial budget/i.test(run.renewal.reportText))
    feed.push({
      text: `The agent's report states amounts in yoctoNEAR and calls the available ${available} NEAR its 'initial budget'. The contract's figures above are authoritative.`,
      tone: "warn",
    });
  const checks: CheckItem[] = [
    txCheck("Renewal proposal", run.renewal.proposalTx, run),
    { label: "Report hash matches on-chain", href: explorerAccount(run.mandate), kind: "report-hash" },
    { label: "Renewal AI receipt", href: publicUrl(`receipts/${run.renewal.receiptHash}.json`), kind: "receipt", receiptHash: run.renewal.receiptHash, expectText: run.renewal.reportText },
  ];
  return { title: "Renew", feed, checks };
}

function firedStep(run: RunData): Step {
  const fired = run.log.find((e) => e.kind === "Fired")?.amount ?? run.end.firedAmount;
  const swept = run.log.find((e) => e.kind === "Swept")?.amount ?? run.end.sweptAmount;
  const feed: FeedLine[] = [
    { text: "The term ended", tone: "info" },
    { text: `A late payment failed on-chain: "${run.end.termEndedError}"`, tone: "bad" },
    { text: "The DAO voted to fire the agent", tone: "ok" },
    { text: "The agent's key was deleted", tone: "ok" },
    {
      text: `Fired: ${near(fired)} NEAR returned to the DAO (all funds above the storage reserve, including the ${near(String(BigInt(run.budget.total) - BigInt(run.budget.spent)))} NEAR of unspent budget)`,
      tone: "ok",
    },
    { text: `Swept ${near(swept)} NEAR`, tone: "ok" },
    { text: `The agent's next attempt was rejected: ${run.end.agentAttempt} (recorded output)`, tone: "bad" },
  ];
  const checks: CheckItem[] = [
    txCheck("Late payment failed (term ended)", run.end.termEndedTx, run),
    txCheck("Fire proposal", run.end.fireProposeTx, run),
    ...run.end.fireVoteTxs.map((h, i) => txCheck(`Fire vote ${i + 1}`, h, run)),
    txCheck("Sweep", run.end.sweepTx, run),
    { label: "Agent keys on-chain: none", href: explorerAccount(run.mandate), kind: "live-keys" },
    { label: "Agent's last attempt (recorded output)", href: null, kind: "recorded" },
  ];
  return { title: "Fired", feed, checks };
}

export function steps(run: RunData): Record<StepId, Step> {
  return { hire: hireStep(run), work: workStep(run), vote: voteStep(run), renew: renewStep(run), fired: firedStep(run) };
}

export async function loadRun(): Promise<RunData> {
  const r = await fetch(publicUrl("run.json"));
  if (!r.ok) throw new Error(`run.json: HTTP ${r.status}`);
  return (await r.json()) as RunData;
}

export async function reportHashMatches(text: string, expectedHex: string): Promise<boolean> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex === expectedHex.toLowerCase();
}

/** The assistant message text inside a stored chat completion body, or null when it can't be read. */
export function messageContent(responseText: string | undefined): string | null {
  if (!responseText) return null;
  try {
    const c = (JSON.parse(responseText) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

export async function confirmCheck(
  item: CheckItem,
  ctx: { keys: AccessKeyInfo[] | null; receipt: (h: string) => Promise<Receipt | null>; reportOk: boolean | null },
): Promise<boolean> {
  switch (item.kind) {
    case "tx":
      return !!item.tx;
    case "receipt":
      if (!item.receiptHash) return false;
      try {
        const r = await ctx.receipt(item.receiptHash);
        if (r?.verified !== true) return false;
        return item.expectText === undefined || messageContent(r.responseText) === item.expectText;
      } catch {
        return false;
      }
    case "live-keys":
      return ctx.keys !== null && ctx.keys.length === 0;
    case "report-hash":
      return ctx.reportOk === true;
    case "recorded":
      return false;
  }
}
