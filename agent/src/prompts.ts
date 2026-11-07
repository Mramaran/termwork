import type { LogEntry, MandateView } from "@termwork/shared";
import type { ChatMessage } from "./nearai.js";
import type { PullRequestFact } from "./sources/types.js";

export function decisionMessages(m: MandateView, pr: PullRequestFact): ChatMessage[] {
  const clauses = (m.mission?.clauses ?? [])
    .map((c) => `- clause ${c.id}: ${c.text} (pays: ${c.pays}, max_amount yoctoNEAR: ${c.max_amount ?? "none"})`)
    .join("\n");
  const system = [
    `You are the advisor of Termwork's "${m.mission?.title ?? "steward"}" agent. A DAO hired the agent for a fixed term under this mandate:`,
    clauses,
    `You only advise. Fixed rules outside your control check your answer and decide whether anything is paid, so never claim to have paid or acted.`,
    `Decide whether the merged pull request below earns a reward under one clause.`,
    `"Trivial" means only a typo fix, a whitespace or formatting-only change, or an automated bot update. A change to code that fixes a bug or adds behaviour is never trivial, however few lines it changes.`,
    `Output strict JSON and nothing else, matching: {"qualifies": boolean, "clause_id": number, "amount_near": string, "rationale": string}.`,
    `amount_near is a decimal NEAR amount written as a string, for example "0.2". rationale is one or two sentences.`,
  ].join("\n");
  const user = JSON.stringify({
    url: pr.url,
    title: pr.title,
    author: pr.author,
    changed_lines: pr.changedLines,
    labels: pr.labels,
    merged_at: pr.mergedAt,
    near_account: pr.nearAccount,
  });
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function reportMessages(m: MandateView, log: LogEntry[], previousError?: string): ChatMessage[] {
  const system = [
    `You write the renewal case for Termwork's "${m.mission?.title ?? "steward"}" agent. The agent was hired for one term and asks the DAO to renew it.`,
    `Use only the work log you are given. Cite every claim with the log entry index in the form [#n]; cite only indices that appear in the log.`,
    `Write plain text under 3500 bytes with these sections: Paid, Sent to vote, Skipped, Budget left, Next term.`,
    `Do not invent entries, amounts or outcomes.`,
  ].join("\n");
  const rows = log.map((e) =>
    JSON.stringify({
      index: e.index,
      kind: e.kind,
      clause_id: e.clause_id,
      amount: e.amount,
      recipient: e.recipient,
      evidence_url: e.evidence_url,
      note: e.note,
    }),
  );
  const user = [
    `Budget available (yoctoNEAR): ${m.budget_available}. Budget spent (yoctoNEAR): ${m.budget_spent}.`,
    `Work log, one JSON entry per line:`,
    ...rows,
    ...(previousError ? [`Your previous attempt was rejected: ${previousError}. Fix that.`] : []),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
