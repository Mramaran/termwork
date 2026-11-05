import { nearToYocto, type MandateView } from "@termwork/shared";
import type { PullRequestFact } from "./sources/types.js";

export interface Decision {
  qualifies: boolean;
  clause_id: number;
  amount_near: string;
  rationale: string;
}

export type Action =
  | { kind: "spend"; recipient: string; amountYocto: string; clauseId: number; evidenceUrl: string }
  | { kind: "request"; recipient: string; amountYocto: string; clauseId: number; evidenceUrl: string; rationale: string }
  | { kind: "log"; clauseId: number; summary: string; evidenceUrl: string };

/** Returns the first balanced {...} substring (string-literal aware), or null. */
function firstBalanced(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}

export function parseDecision(raw: string): Decision | { error: string } {
  const json = firstBalanced(typeof raw === "string" ? raw : "");
  if (!json) return { error: "no JSON object found" };
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return { error: "invalid JSON" };
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { error: "decision is not an object" };
  const r = o as Record<string, unknown>;
  if (typeof r.qualifies !== "boolean") return { error: "missing or invalid field: qualifies" };
  if (typeof r.clause_id !== "number" || !Number.isInteger(r.clause_id)) return { error: "missing or invalid field: clause_id" };
  if (typeof r.amount_near !== "string") return { error: "missing or invalid field: amount_near (must be a string)" };
  if (typeof r.rationale !== "string") return { error: "missing or invalid field: rationale" };
  return { qualifies: r.qualifies, clause_id: r.clause_id, amount_near: r.amount_near, rationale: r.rationale };
}

/** Fixed-rule gate: turns a model decision into exactly one safe action. Never throws. */
export async function validate(
  d: Decision | { error: string },
  pr: PullRequestFact,
  m: MandateView,
  paid: Set<string>,
  exists: (id: string) => Promise<boolean>,
): Promise<Action> {
  const evidenceUrl = pr.url;
  const log = (clauseId: number, summary: string): Action => ({ kind: "log", clauseId, summary, evidenceUrl });
  try {
    const clauses = m.mission?.clauses ?? [];
    const byId = (id: number) => clauses.find((c) => c.id === id);

    if ("error" in d) return log(1, `rejected decision: ${d.error}`);
    if (paid.has(pr.url)) return log(4, "skipped: already paid for this pull request");
    if (!pr.firstTime) return log(1, "skipped: not a first-time contributor");
    if (!pr.nearAccount) return log(4, "skipped: no NEAR account in pull request");
    if (!d.qualifies) return log(byId(d.clause_id) ? d.clause_id : 1, `skipped: ${d.rationale}`);

    const clause = byId(d.clause_id);
    if (!clause) return log(1, `rejected decision: unknown clause ${d.clause_id}`);
    if (!clause.pays) return log(clause.id, `rejected decision: clause ${clause.id} does not authorise payment`);
    if (!/^\d+(\.\d{1,24})?$/.test(d.amount_near)) return log(clause.id, "rejected decision: malformed amount");
    const amount = BigInt(nearToYocto(d.amount_near));
    if (amount <= 0n) return log(clause.id, "rejected decision: amount must be greater than zero");
    if (clause.max_amount !== null && amount > BigInt(clause.max_amount))
      return log(clause.id, "rejected decision: amount exceeds clause maximum");
    if (amount > BigInt(m.max_request)) return log(clause.id, "rejected decision: amount exceeds max_request");

    let found: boolean;
    try {
      found = await exists(pr.nearAccount);
    } catch (e) {
      return log(4, `recipient check failed (rpc): ${(e as Error).message}`);
    }
    if (!found) return log(4, "recipient account does not exist");

    const amountYocto = amount.toString();
    if (amount > BigInt(m.spend_threshold))
      return { kind: "request", recipient: pr.nearAccount, amountYocto, clauseId: clause.id, evidenceUrl, rationale: d.rationale };
    return { kind: "spend", recipient: pr.nearAccount, amountYocto, clauseId: clause.id, evidenceUrl };
  } catch (e) {
    return log(1, `rejected decision: ${(e as Error).message}`);
  }
}
