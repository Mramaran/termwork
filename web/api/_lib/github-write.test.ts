import { describe, expect, it } from "vitest";
import type { InferenceReceipt } from "../../../agent/src/nearai";
import { findPaidTx, labelPaid, paidComment, type PaidInfo } from "./github-write";

/** Shaped like a live receipt: the attestation alone is far over GitHub's comment limit. */
const receipt = {
  model: "m",
  requestBody: { messages: [{ role: "user", content: "prompt" }] },
  responseText: "{...}",
  chatId: "c1",
  signature: { text: "t", signature: "0xsig" },
  attestation: { report: "A".repeat(200_000) },
  nonce: "n1",
  verified: true,
  verifiedScope: "response-signature+model+nonce",
  mode: "live",
  createdAt: "2026-11-07T00:00:00Z",
} as unknown as InferenceReceipt;
const trimmed = {
  model: "m",
  chatId: "c1",
  nonce: "n1",
  verified: true,
  verifiedScope: "response-signature+model+nonce",
  mode: "live",
  createdAt: "2026-11-07T00:00:00Z",
  signature: { text: "t", signature: "0xsig" },
  receiptHash: "rh1",
};
const info = (o: Partial<PaidInfo> = {}): PaidInfo => ({
  repo: "o/r",
  number: 7,
  amountNear: "0.2",
  recipient: "alice.testnet",
  txHash: "TxAbc123",
  receipt,
  receiptHash: "rh1",
  ...o,
});

type Call = { method: string; url: string; body: unknown; auth: string | null };

/** Fake fetch: routes on "METHOD path" (path after api.github.com); records every call. */
function fakeFetch(routes: Record<string, { status?: number; json?: unknown }>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization ?? null });
    const path = url.replace("https://api.github.com", "").split("?")[0];
    const r = routes[`${method} ${path}`];
    if (!r) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const LABEL = "💰 paid 0.2 NEAR";
const BASE = "https://api.github.com/repos/o/r";
const postUrls = (calls: Call[]) => calls.filter((c) => c.method === "POST").map((c) => c.url);

describe("paidComment", () => {
  it("starts with the marker and links the explorer, with the trimmed receipt collapsed", () => {
    const c = paidComment(info());
    expect(c.split("\n")[0]).toBe("<!-- mission-dao-paid tx=TxAbc123 -->");
    expect(c).toContain("💰 Paid **0.2 NEAR** to `alice.testnet` by the Mission DAO contributor-rewards agent.");
    expect(c).toContain("- Transaction: https://testnet.nearblocks.io/txns/TxAbc123");
    expect(c).toContain("<details><summary>Agent decision receipt</summary>");
    expect(c).toContain("```json\n" + JSON.stringify(trimmed, null, 2) + "\n```\n</details>");
    expect(c).not.toMatch(/claude|anthropic/i);
  });

  it("keeps a huge live receipt under the GitHub comment limit, without attestation or prompts", () => {
    expect(JSON.stringify(receipt).length).toBeGreaterThan(65_536);
    const c = paidComment(info());
    expect(c.length).toBeLessThan(65_536);
    expect(c).not.toContain("attestation");
    expect(c).not.toContain("requestBody");
    expect(c).not.toContain("responseText");
    expect(c).toContain('"receiptHash": "rh1"');
  });

  it("has no details block when there is no receipt", () => {
    const c = paidComment(info({ receipt: null }));
    expect(c).not.toContain("<details>");
    expect(c).toContain("https://testnet.nearblocks.io/txns/TxAbc123");
    expect(c).not.toMatch(/claude|anthropic/i);
  });
});

describe("labelPaid", () => {
  it("posts one comment, then creates and adds the label", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/labels": { json: [{ name: "bug" }] },
      "GET /repos/o/r/issues/7/comments": { json: [{ body: "thanks" }] },
      "POST /repos/o/r/issues/7/comments": { status: 201 },
      "POST /repos/o/r/labels": { status: 201 },
      "POST /repos/o/r/issues/7/labels": { json: [] },
    });
    expect(await labelPaid(info(), { token: "tok", fetchFn: f.fn })).toBe("labelled");
    const posts = f.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([`${BASE}/issues/7/comments`, `${BASE}/labels`, `${BASE}/issues/7/labels`]);
    expect((posts[0]!.body as { body: string }).body).toBe(paidComment(info()));
    expect(posts[1]!.body).toMatchObject({ name: LABEL, color: "2ea44f" });
    expect(posts[2]!.body).toEqual({ labels: [LABEL] });
    expect(f.calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("treats a 422 already_exists on label creation as fine", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/labels": { json: [] },
      "GET /repos/o/r/issues/7/comments": { json: [] },
      "POST /repos/o/r/issues/7/comments": { status: 201 },
      "POST /repos/o/r/labels": { status: 422, json: { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }] } },
      "POST /repos/o/r/issues/7/labels": { json: [] },
    });
    expect(await labelPaid(info(), { token: "tok", fetchFn: f.fn })).toBe("labelled");
    expect(postUrls(f.calls)).toHaveLength(3);
  });

  it("throws on any other label-creation failure, after the comment is posted", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/labels": { json: [] },
      "GET /repos/o/r/issues/7/comments": { json: [] },
      "POST /repos/o/r/issues/7/comments": { status: 201 },
      "POST /repos/o/r/labels": { status: 403, json: { message: "Resource not accessible" } },
    });
    await expect(labelPaid(info(), { token: "tok", fetchFn: f.fn })).rejects.toThrow(/403/);
    expect(postUrls(f.calls)).toEqual([`${BASE}/issues/7/comments`, `${BASE}/labels`]);
  });

  it("does not add the label when the comment fails", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/labels": { json: [] },
      "GET /repos/o/r/issues/7/comments": { json: [] },
      "POST /repos/o/r/issues/7/comments": { status: 422, json: { message: "body is too long" } },
    });
    await expect(labelPaid(info(), { token: "tok", fetchFn: f.fn })).rejects.toThrow(/422/);
    expect(postUrls(f.calls)).toEqual([`${BASE}/issues/7/comments`]);
  });

  it("adds only the label when the marker comment for this tx is already there", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/labels": { json: [] },
      "GET /repos/o/r/issues/7/comments": { json: [{ body: paidComment(info()) }] },
      "POST /repos/o/r/labels": { status: 201 },
      "POST /repos/o/r/issues/7/labels": { json: [] },
    });
    expect(await labelPaid(info(), { token: "tok", fetchFn: f.fn })).toBe("labelled");
    expect(postUrls(f.calls)).toEqual([`${BASE}/labels`, `${BASE}/issues/7/labels`]);
  });

  it("still posts the comment when the existing marker is for a different tx", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/labels": { json: [] },
      "GET /repos/o/r/issues/7/comments": { json: [{ body: paidComment(info({ txHash: "Other1" })) }] },
      "POST /repos/o/r/issues/7/comments": { status: 201 },
      "POST /repos/o/r/labels": { status: 201 },
      "POST /repos/o/r/issues/7/labels": { json: [] },
    });
    await labelPaid(info(), { token: "tok", fetchFn: f.fn });
    expect(postUrls(f.calls).filter((u) => u.endsWith("/comments"))).toHaveLength(1);
  });

  it("returns already and makes no POSTs when the PR has the label", async () => {
    const f = fakeFetch({ "GET /repos/o/r/issues/7/labels": { json: [{ name: LABEL }] } });
    expect(await labelPaid(info(), { token: "tok", fetchFn: f.fn })).toBe("already");
    expect(f.calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

describe("findPaidTx", () => {
  it("returns the hash from a comment carrying the marker", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/comments": { json: [{ body: "thanks!" }, { body: paidComment(info({ txHash: "9xYz" })) }] },
    });
    expect(await findPaidTx("o/r", 7, { fetchFn: f.fn })).toBe("9xYz");
    expect(f.calls[0]!.url).toBe("https://api.github.com/repos/o/r/issues/7/comments?per_page=100");
  });

  it("returns null when no comment has the marker", async () => {
    const f = fakeFetch({ "GET /repos/o/r/issues/7/comments": { json: [{ body: "LGTM" }, { body: null }] } });
    expect(await findPaidTx("o/r", 7, { token: "t", fetchFn: f.fn })).toBeNull();
  });
});
