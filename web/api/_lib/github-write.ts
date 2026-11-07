import type { InferenceReceipt } from "../../../agent/src/nearai";

/** A payment that landed on-chain, as it is reported back to the pull request. */
export interface PaidInfo {
  repo: string;
  number: number;
  amountNear: string;
  recipient: string;
  txHash: string;
  receipt: InferenceReceipt | null;
  /** The receipt hash sent on-chain as receipt_hash. */
  receiptHash: string;
}

const API = "https://api.github.com";
const LABEL_COLOR = "2ea44f";
const MARKER_RE = /<!-- mission-dao-paid tx=([A-Za-z0-9]+) -->/;

const marker = (txHash: string) => `<!-- mission-dao-paid tx=${txHash} -->`;
const labelName = (amountNear: string) => `💰 paid ${amountNear} NEAR`;
const repoPath = (repo: string) => repo.split("/").map(encodeURIComponent).join("/");

/**
 * The receipt fields that fit in a comment. A live receipt carries the attestation report (hundreds of KB),
 * far over GitHub's 65,536-character comment limit, so attestation, requestBody and responseText stay out.
 */
function trimReceipt(r: InferenceReceipt, receiptHash: string) {
  return {
    model: r.model,
    chatId: r.chatId,
    nonce: r.nonce,
    verified: r.verified,
    verifiedScope: r.verifiedScope,
    mode: r.mode,
    createdAt: r.createdAt,
    signature: r.signature,
    receiptHash,
  };
}

/** The comment posted on a paid pull request. The first line is a machine-readable marker. */
export function paidComment(p: PaidInfo): string {
  const lines = [
    marker(p.txHash),
    `💰 Paid **${p.amountNear} NEAR** to \`${p.recipient}\` by the Mission DAO contributor-rewards agent.`,
    "",
    `- Transaction: https://testnet.nearblocks.io/txns/${p.txHash}`,
  ];
  if (p.receipt !== null)
    lines.push("", "<details><summary>Agent decision receipt</summary>", "", "```json", JSON.stringify(trimReceipt(p.receipt, p.receiptHash), null, 2), "```", "</details>");
  return lines.join("\n");
}

function client(token: string | undefined, fetchFn: typeof fetch) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "termwork-agent",
    "content-type": "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return (method: string, path: string, body?: unknown) =>
    fetchFn(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${what}`);
  return res;
}

/** Transaction hashes from the paid-comment markers on the issue, in comment order. */
async function markerHashes(call: ReturnType<typeof client>, repo: string, number: number): Promise<string[]> {
  const res = await ok(await call("GET", `/repos/${repoPath(repo)}/issues/${number}/comments?per_page=100`), "list comments");
  const comments = (await res.json()) as Array<{ body?: string | null }>;
  return comments.flatMap((c) => {
    const m = MARKER_RE.exec(c.body ?? "");
    return m ? [m[1]!] : [];
  });
}

/**
 * Posts the paid comment, then labels the pull request "💰 paid <amount> NEAR". The comment goes first so a
 * failed comment never leaves a label that would make a retry return "already". Idempotent: an existing
 * label returns "already"; an existing marker comment for this tx gets only the label.
 */
export async function labelPaid(p: PaidInfo, d: { token: string; fetchFn?: typeof fetch }): Promise<"labelled" | "already"> {
  const call = client(d.token, d.fetchFn ?? fetch);
  const issue = `/repos/${repoPath(p.repo)}/issues/${p.number}`;
  const name = labelName(p.amountNear);

  const existing = (await (await ok(await call("GET", `${issue}/labels?per_page=100`), "list labels")).json()) as Array<{ name: string }>;
  if (existing.some((l) => l.name === name)) return "already";

  if (!(await markerHashes(call, p.repo, p.number)).includes(p.txHash))
    await ok(await call("POST", `${issue}/comments`, { body: paidComment(p) }), "post comment");

  const created = await call("POST", `/repos/${repoPath(p.repo)}/labels`, { name, color: LABEL_COLOR });
  if (!created.ok && !(created.status === 422 && (await created.text()).includes("already_exists")))
    throw new Error(`GitHub ${created.status} on create label`);
  await ok(await call("POST", `${issue}/labels`, { labels: [name] }), "add label");
  return "labelled";
}

/** The transaction hash from the paid comment on the pull request, or null when there is none. */
export async function findPaidTx(repo: string, number: number, d: { token?: string; fetchFn?: typeof fetch }): Promise<string | null> {
  return (await markerHashes(client(d.token, d.fetchFn ?? fetch), repo, number))[0] ?? null;
}
