import { describe, expect, it } from "vitest";
import type { InferenceReceipt } from "../../../agent/src/nearai";
import { findPaidTx, labelPaid, paidComment, type PaidInfo } from "./github-write";

const receipt = { model: "m", verified: true, chatId: "c1" } as unknown as InferenceReceipt;
const info = (o: Partial<PaidInfo> = {}): PaidInfo => ({
  repo: "o/r",
  number: 7,
  amountNear: "0.2",
  recipient: "alice.testnet",
  txHash: "TxAbc123",
  receipt,
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

describe("paidComment", () => {
  it("starts with the marker and links the explorer, with the receipt collapsed", () => {
    const c = paidComment(info());
    expect(c.split("\n")[0]).toBe("<!-- mission-dao-paid tx=TxAbc123 -->");
    expect(c).toContain("💰 Paid **0.2 NEAR** to `alice.testnet` by the Mission DAO contributor-rewards agent.");
    expect(c).toContain("- Transaction: https://testnet.nearblocks.io/txns/TxAbc123");
    expect(c).toContain("<details><summary>Agent decision receipt</summary>");
    expect(c).toContain("```json\n" + JSON.stringify(receipt, null, 2) + "\n```\n</details>");
    expect(c).not.toMatch(/claude|anthropic/i);
  });

  it("has no details block when there is no receipt", () => {
    const c = paidComment(info({ receipt: null }));
    expect(c).not.toContain("<details>");
    expect(c).toContain("https://testnet.nearblocks.io/txns/TxAbc123");
    expect(c).not.toMatch(/claude|anthropic/i);
  });
});

describe("labelPaid", () => {
  it("creates the label, adds it to the PR and posts one comment", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/labels": { json: [{ name: "bug" }] },
      "POST /repos/o/r/labels": { status: 201 },
      "POST /repos/o/r/issues/7/labels": { json: [] },
      "POST /repos/o/r/issues/7/comments": { status: 201 },
    });
    expect(await labelPaid(info(), { token: "tok", fetchFn: f.fn })).toBe("labelled");
    const posts = f.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/o/r/labels",
      "https://api.github.com/repos/o/r/issues/7/labels",
      "https://api.github.com/repos/o/r/issues/7/comments",
    ]);
    expect(posts[0]!.body).toMatchObject({ name: LABEL, color: "2ea44f" });
    expect(posts[1]!.body).toEqual({ labels: [LABEL] });
    expect((posts[2]!.body as { body: string }).body).toBe(paidComment(info()));
    expect(f.calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  });

  it("treats a 422 already_exists on label creation as fine", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/labels": { json: [] },
      "POST /repos/o/r/labels": { status: 422, json: { message: "Validation Failed", errors: [{ resource: "Label", code: "already_exists", field: "name" }] } },
      "POST /repos/o/r/issues/7/labels": { json: [] },
      "POST /repos/o/r/issues/7/comments": { status: 201 },
    });
    expect(await labelPaid(info(), { token: "tok", fetchFn: f.fn })).toBe("labelled");
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(3);
  });

  it("throws on any other label-creation failure", async () => {
    const f = fakeFetch({
      "GET /repos/o/r/issues/7/labels": { json: [] },
      "POST /repos/o/r/labels": { status: 403, json: { message: "Resource not accessible" } },
    });
    await expect(labelPaid(info(), { token: "tok", fetchFn: f.fn })).rejects.toThrow(/403/);
    expect(f.calls.filter((c) => c.url.endsWith("/comments"))).toHaveLength(0);
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
