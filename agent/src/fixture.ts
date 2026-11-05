import type { LogEntry, MandateView } from "@termwork/shared";
import type { ChatMessage } from "./nearai.js";
import type { InferenceReceipt } from "./receipts.js";
import type { PullRequestFact } from "./sources/types.js";

/** Receipts made in fixture mode name this "model". It is a rule table, not an AI model. */
export const FIXTURE_MODEL = "fixture-rules";

/** Clause ids of the demo mission (spec section 2): 1 eligibility, 2 standard reward, 3 big reward (vote), 4 never pay twice. */
const CLAUSE_STANDARD = 2;
const CLAUSE_BIG = 3;
const BIG_LINES = 200;

/**
 * Deterministic stand-in for the model: applies the mission rules in code.
 * Returns the same strict JSON the model is asked for. No network, no randomness.
 */
export function fixtureDecision(pr: PullRequestFact): string {
  if (!pr.firstTime) {
    return JSON.stringify({ qualifies: false, clause_id: 1, amount_near: "0", rationale: `${pr.author} has an earlier merged pull request, so clause 1 (first-time contributors) does not apply.` });
  }
  if (pr.labels.includes("feature") || pr.changedLines > BIG_LINES) {
    return JSON.stringify({
      qualifies: true,
      clause_id: CLAUSE_BIG,
      amount_near: "0.5",
      rationale: `First-time contributor; ${pr.changedLines} changed lines${pr.labels.includes("feature") ? " and a feature label" : ""} make this a larger pull request (clause 3), which needs a DAO vote.`,
    });
  }
  return JSON.stringify({
    qualifies: true,
    clause_id: CLAUSE_STANDARD,
    amount_near: "0.2",
    rationale: `First-time contributor with a small merged pull request (${pr.changedLines} changed lines): standard reward under clause 2.`,
  });
}

function nearText(yocto: string | null): string {
  if (!yocto) return "0";
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").slice(0, 3).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Fixture renewal report. Every claim cites the index of a real work-log entry as [#n]. */
export function fixtureReport(m: MandateView, log: LogEntry[]): string {
  const paid = log.filter((e) => e.kind === "Paid" || e.kind === "PaidApproved");
  const requested = log.filter((e) => e.kind === "Requested");
  const skipped = log.filter((e) => e.kind === "Work");
  const line = (e: LogEntry, what: string) => `- [#${e.index}] ${what}${e.evidence_url ? ` (${e.evidence_url})` : ""}`;
  const out: string[] = [];
  out.push(`Renewal case, term ${m.term_number}. Written by the fixture rule engine, not by an AI model.`);
  out.push("", "Paid");
  if (paid.length === 0) out.push("- nothing was paid this term");
  for (const e of paid) out.push(line(e, `paid ${nearText(e.amount)} NEAR under clause ${e.clause_id ?? "?"}`));
  out.push("", "Sent to vote");
  if (requested.length === 0) out.push("- no big-spend requests this term");
  for (const e of requested) out.push(line(e, `asked the DAO for ${nearText(e.amount)} NEAR under clause ${e.clause_id ?? "?"}; the DAO decides`));
  out.push("", "Skipped");
  if (skipped.length === 0) out.push("- nothing was skipped");
  for (const e of skipped) out.push(line(e, (e.note ?? "logged without payment").slice(0, 160)));
  out.push("", "Budget left", `- ${nearText(m.budget_available)} NEAR available, ${nearText(m.budget_spent)} NEAR spent`);
  const anchor = log[0];
  if (anchor) out[out.length - 1] += ` (term opened at [#${anchor.index}])`;
  out.push("", "Next term", "- keep applying clauses 1 to 4 to new merged pull requests and send anything over the threshold to a vote");
  return out.join("\n");
}

/** A receipt that says plainly what it is: produced by rules, no model, not verified. */
export function fixtureReceipt(messages: ChatMessage[], text: string, key: string): InferenceReceipt {
  return {
    model: FIXTURE_MODEL,
    requestBody: { model: FIXTURE_MODEL, messages },
    responseText: JSON.stringify({ id: `fixture:${key}`, model: FIXTURE_MODEL, choices: [{ message: { role: "assistant", content: text } }] }),
    chatId: `fixture:${key}`,
    signature: null,
    attestation: null,
    nonce: "",
    verified: false,
    verifiedScope: "none",
    mode: "fixture",
    createdAt: new Date().toISOString(),
  };
}
