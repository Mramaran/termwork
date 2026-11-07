// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  connectedAccount: vi.fn(async (): Promise<string | null> => null),
  signCouncilMessage: vi.fn(async () => ({ accountId: "me.testnet", proof: true }) as never),
  vote: vi.fn(async (): Promise<string | null> => "HASH1"),
  WALLET_EVENT: "termwork-wallet",
}));
const chain = vi.hoisted(() => ({
  councilMembers: vi.fn(async (): Promise<string[]> => ["me.testnet"]),
  explorerTx: (h: string) => `https://explorer.test/txns/${h}`,
}));
vi.mock("../wallet", () => wallet);
vi.mock("../chain", () => chain);

import { AnalyseRepo, DEMO_REPO } from "./AnalyseRepo";

type Row = Record<string, unknown>;
const row = (over: Row): Row => ({
  url: "https://github.com/o/r/pull/1",
  number: 1,
  title: "t",
  author: "alice",
  firstTime: true,
  mergedAt: "2026-11-01T00:00:00Z",
  nearAccount: "alice.testnet",
  status: "ready",
  amountNear: null,
  reason: "ready to pay",
  receiptHash: null,
  proposalId: null,
  ...over,
});
const analysis = (rows: Row[], over: Row = {}) => ({ repo: "o/r", from: "a", to: "b", payable: true, total: rows.length, capped: false, suggestions: [], fit: "ok", rows, ...over });

type Handler = (body: Record<string, unknown>) => { status: number; body: unknown } | undefined;
interface Call {
  url: string;
  body: Record<string, unknown> | null;
}
function mockApi(handlers: { analyse?: Handler[]; pay?: Handler; label?: Handler; paid?: unknown[] }) {
  const calls: Call[] = [];
  let analyseN = 0;
  const f = vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body });
    let r: { status: number; body: unknown } | undefined;
    if (url === "/api/analyse") {
      const hs = handlers.analyse ?? [];
      r = hs[Math.min(analyseN++, hs.length - 1)]?.(body!);
    } else if (url === "/api/pay") r = handlers.pay?.(body!);
    else if (url === "/api/label") r = handlers.label?.(body!) ?? { status: 200, body: { labelled: true } };
    else if (url === "/api/paid") r = { status: 200, body: { items: handlers.paid ?? [] } };
    r ??= { status: 500, body: { error: "unmocked" } };
    return { ok: r.status < 300, status: r.status, json: async () => r!.body };
  });
  vi.stubGlobal("fetch", f);
  return calls;
}
const ok = (rows: Row[], over: Row = {}): Handler => () => ({ status: 200, body: analysis(rows, over) });

beforeEach(() => {
  wallet.connectedAccount.mockResolvedValue(null);
  wallet.signCouncilMessage.mockResolvedValue({ accountId: "me.testnet" } as never);
  wallet.vote.mockResolvedValue("HASH1");
  chain.councilMembers.mockResolvedValue(["me.testnet"]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const typeRepo = (v: string) => fireEvent.change(screen.getByLabelText("Repository"), { target: { value: v } });
const analyse = () => fireEvent.click(screen.getByRole("button", { name: "Analyse" }));
const callsTo = (calls: Call[], url: string) => calls.filter((c) => c.url === url);

describe("AnalyseRepo", () => {
  it("defaults to Last 1 month and posts repo + range", async () => {
    const calls = mockApi({ analyse: [ok([])] });
    render(<AnalyseRepo />);
    expect((screen.getByLabelText("Last 1 month") as HTMLInputElement).checked).toBe(true);
    typeRepo(" near/x ");
    analyse();
    await waitFor(() => expect(callsTo(calls, "/api/analyse")).toHaveLength(1));
    expect(callsTo(calls, "/api/analyse")[0]!.body).toEqual({ repo: " near/x ", range: { preset: "month" } });
  });

  it("custom shows two date inputs and posts the dates", async () => {
    const calls = mockApi({ analyse: [ok([])] });
    const { container } = render(<AnalyseRepo />);
    expect(container.querySelectorAll('input[type="date"]')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("Custom"));
    const dates = container.querySelectorAll('input[type="date"]');
    expect(dates).toHaveLength(2);
    fireEvent.change(dates[0]!, { target: { value: "2026-10-01" } });
    fireEvent.change(dates[1]!, { target: { value: "2026-10-31" } });
    typeRepo("o/r");
    analyse();
    await waitFor(() => expect(callsTo(calls, "/api/analyse")).toHaveLength(1));
    expect(callsTo(calls, "/api/analyse")[0]!.body).toEqual({ repo: "o/r", range: { preset: "custom", from: "2026-10-01", to: "2026-10-31" } });
  });

  it("renders each status copy", async () => {
    const rows = [
      row({ number: 1, status: "paid", amountNear: "0.5", reason: "paid by the agent" }),
      row({ number: 2, status: "pending", amountNear: "2", proposalId: 4 }),
      row({ number: 3, status: "ready" }),
      row({ number: 4, status: "unclaimed", amountNear: "0.3", nearAccount: null }),
      row({ number: 5, status: "would_pay", amountNear: "0.2", nearAccount: "bob.testnet" }),
      row({ number: 6, status: "skipped", reason: "not a first-time contributor", firstTime: false }),
    ];
    mockApi({
      analyse: [ok(rows, { payable: false })],
      paid: [],
    });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    expect(await screen.findByText("Waiting for council approval")).toBeTruthy();
    expect(screen.getByText("Ready to pay")).toBeTruthy();
    expect(screen.getByText("Earns 0.3 NEAR · unclaimed")).toBeTruthy();
    expect(screen.getByText("Would pay 0.2 NEAR to bob.testnet")).toBeTruthy();
    expect(screen.getByText("Skipped · not a first-time contributor")).toBeTruthy();
    expect(screen.getByText("Paid 0.5 NEAR")).toBeTruthy();
  });

  it("shows the capped message", async () => {
    mockApi({ analyse: [ok([row({})], { capped: true, total: 41 })] });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    expect(await screen.findByText("Showing the first 1 of 41. Narrow the range.")).toBeTruthy();
  });

  it("poor fit shows suggestions; clicking one re-runs with that repo", async () => {
    const calls = mockApi({
      analyse: [
        () => ({ status: 200, body: analysis([], { fit: "no_merged_in_range", rows: [], suggestions: ["near/near-cli-rs"] }) }),
        ok([]),
      ],
    });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    fireEvent.click(await screen.findByRole("button", { name: "near/near-cli-rs" }));
    await waitFor(() => expect(callsTo(calls, "/api/analyse")).toHaveLength(2));
    expect(callsTo(calls, "/api/analyse")[1]!.body).toMatchObject({ repo: "near/near-cli-rs" });
    expect((screen.getByLabelText("Repository") as HTMLInputElement).value).toBe("near/near-cli-rs");
  });

  it("not found shows suggestions", async () => {
    mockApi({ analyse: [() => ({ status: 404, body: { fit: "not_found", error: "repository not found", suggestions: ["near/near-sdk-rs"] } })] });
    render(<AnalyseRepo />);
    typeRepo("o/missing");
    analyse();
    expect(await screen.findByRole("button", { name: "near/near-sdk-rs" })).toBeTruthy();
    expect(screen.getByText(/could not be found/)).toBeTruthy();
  });

  it("shows the server error message for a 502", async () => {
    mockApi({ analyse: [() => ({ status: 502, body: { error: "The AI request failed. Try again in a minute." } })] });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    expect((await screen.findByRole("alert")).textContent).toContain("The AI request failed. Try again in a minute.");
  });

  it("a wallet connected from the header enables Run payments without a reload", async () => {
    mockApi({ analyse: [ok([row({})])] });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    await screen.findByText("Ready to pay");
    expect(screen.queryByRole("button", { name: "Run payments" })).toBeNull();
    wallet.connectedAccount.mockResolvedValue("me.testnet");
    window.dispatchEvent(new Event("termwork-wallet"));
    expect(await screen.findByRole("button", { name: "Run payments" })).toBeTruthy();
  });

  it("one click analyses the demo repo over the last month, with steps shown while it runs", async () => {
    const calls = mockApi({ analyse: [ok([row({})])] });
    render(<AnalyseRepo />);
    fireEvent.click(screen.getByRole("button", { name: "Analyse our demo repo" }));
    expect(screen.getByText("Reading merged pull requests from GitHub")).toBeTruthy();
    await screen.findByText("Ready to pay");
    expect(callsTo(calls, "/api/analyse")[0]!.body).toEqual({ repo: DEMO_REPO, range: { preset: "month" } });
    expect(screen.getByText(/connect your wallet at the top of the page/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "watch a full term" }).getAttribute("href")).toBe("#watch");
  });

  it("Run payments hidden for a non-council wallet, visible for a council member", async () => {
    wallet.connectedAccount.mockResolvedValue("bob.testnet");
    mockApi({ analyse: [ok([row({})])] });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    await screen.findByText("Ready to pay");
    expect(await screen.findByText(/not a council member/)).toBeTruthy();
    await waitFor(() => expect(chain.councilMembers).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Run payments" })).toBeNull();
    cleanup();

    wallet.connectedAccount.mockResolvedValue("me.testnet");
    mockApi({ analyse: [ok([row({})])] });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    expect(await screen.findByRole("button", { name: "Run payments" })).toBeTruthy();
  });

  it("wallet refuses to sign: message shown and no pay call", async () => {
    wallet.connectedAccount.mockResolvedValue("me.testnet");
    wallet.signCouncilMessage.mockRejectedValue(new Error("Your wallet did not sign the message."));
    const calls = mockApi({ analyse: [ok([row({})])] });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    fireEvent.click(await screen.findByRole("button", { name: "Run payments" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Your wallet did not sign the message.");
    expect(callsTo(calls, "/api/pay")).toHaveLength(0);
  });

  it("pays ready rows in order, then refreshes the analysis", async () => {
    wallet.connectedAccount.mockResolvedValue("me.testnet");
    const first = [row({ number: 7, status: "ready" }), row({ number: 3, status: "skipped", reason: "x", firstTime: false }), row({ number: 9, status: "ready" })];
    const after = [row({ number: 7, status: "paid", amountNear: "0.5" }), row({ number: 9, status: "pending", amountNear: "2", proposalId: 12 })];
    const calls = mockApi({
      analyse: [ok(first), ok(after)],
      pay: () => ({ status: 200, body: { kind: "spend", txHash: "H", amountNear: "0.5", recipient: "alice.testnet" } }),
    });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    fireEvent.click(await screen.findByRole("button", { name: "Run payments" }));
    expect(await screen.findByText("Waiting for council approval")).toBeTruthy();
    expect(wallet.signCouncilMessage).toHaveBeenCalledTimes(1);
    const pays = callsTo(calls, "/api/pay");
    expect(pays.map((c) => c.body!.number)).toEqual([7, 9]);
    expect(pays[0]!.body).toMatchObject({ repo: "o/r", range: { preset: "month" }, proof: { accountId: "me.testnet" } });
    expect(callsTo(calls, "/api/analyse")).toHaveLength(2);
    // order: both pays happen before the second analyse
    const order = calls.map((c) => c.url).filter((u) => u === "/api/pay" || u === "/api/analyse");
    expect(order).toEqual(["/api/analyse", "/api/pay", "/api/pay", "/api/analyse"]);
  });

  it("a duplicate on one row does not stop the next row", async () => {
    wallet.connectedAccount.mockResolvedValue("me.testnet");
    const rows = [row({ number: 7 }), row({ number: 9 })];
    const calls = mockApi({
      analyse: [ok(rows), ok(rows)],
      pay: (b) => (b.number === 7 ? { status: 409, body: { error: "already paid or pending" } } : { status: 200, body: { kind: "spend", txHash: "H" } }),
    });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    fireEvent.click(await screen.findByRole("button", { name: "Run payments" }));
    expect((await screen.findByRole("alert")).textContent).toContain("PR #7: already paid or pending");
    expect(callsTo(calls, "/api/pay").map((c) => c.body!.number)).toEqual([7, 9]);
  });

  it("a skip answer from /api/pay is listed and the run continues", async () => {
    wallet.connectedAccount.mockResolvedValue("me.testnet");
    const rows = [row({ number: 7 }), row({ number: 9 })];
    const calls = mockApi({
      analyse: [ok(rows), ok(rows)],
      pay: (b) => (b.number === 7 ? { status: 200, body: { kind: "skip", reason: "account does not exist" } } : { status: 200, body: { kind: "spend", txHash: "H" } }),
    });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    fireEvent.click(await screen.findByRole("button", { name: "Run payments" }));
    expect((await screen.findByRole("alert")).textContent).toContain("PR #7: skipped · account does not exist");
    expect(callsTo(calls, "/api/pay").map((c) => c.body!.number)).toEqual([7, 9]);
  });

  it("a global 409 stops the run", async () => {
    wallet.connectedAccount.mockResolvedValue("me.testnet");
    const rows = [row({ number: 7 }), row({ number: 9 })];
    const calls = mockApi({
      analyse: [ok(rows), ok(rows)],
      pay: () => ({ status: 409, body: { error: "The agent's budget is used up." } }),
    });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    fireEvent.click(await screen.findByRole("button", { name: "Run payments" }));
    expect((await screen.findByRole("alert")).textContent).toContain("budget is used up");
    expect(callsTo(calls, "/api/pay")).toHaveLength(1);
  });

  it("keeps the pay failure message when the refresh also fails", async () => {
    wallet.connectedAccount.mockResolvedValue("me.testnet");
    const calls = mockApi({
      analyse: [ok([row({ number: 7 })]), () => ({ status: 502, body: { error: "GitHub could not be read." } })],
      pay: () => ({ status: 409, body: { error: "The agent is not active (expired or fired)." } }),
    });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    fireEvent.click(await screen.findByRole("button", { name: "Run payments" }));
    await waitFor(() => expect(callsTo(calls, "/api/analyse")).toHaveLength(2));
    const t = (await screen.findByRole("alert")).textContent!;
    expect(t).toContain("PR #7: The agent is not active");
    expect(t).toContain("GitHub could not be read.");
  });

  it("Approve & pay with no hash skips the label and says the vote was sent", async () => {
    wallet.connectedAccount.mockResolvedValue("me.testnet");
    wallet.vote.mockResolvedValue(null);
    const pending = [row({ number: 9, status: "pending", amountNear: "2", proposalId: 12 })];
    const calls = mockApi({ analyse: [ok(pending), ok(pending)] });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    fireEvent.click(await screen.findByRole("button", { name: "Approve & pay" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Vote sent. The paid label will appear once it is confirmed.");
    expect(callsTo(calls, "/api/label")).toHaveLength(0);
    await waitFor(() => expect(callsTo(calls, "/api/analyse")).toHaveLength(2));
  });

  it("Approve & pay votes then labels", async () => {
    wallet.connectedAccount.mockResolvedValue("me.testnet");
    const pending = [row({ number: 9, status: "pending", amountNear: "2", proposalId: 12 })];
    const calls = mockApi({ analyse: [ok(pending), ok([row({ number: 9, status: "paid", amountNear: "2" })])] });
    render(<AnalyseRepo />);
    typeRepo("o/r");
    analyse();
    fireEvent.click(await screen.findByRole("button", { name: "Approve & pay" }));
    await waitFor(() => expect(callsTo(calls, "/api/label")).toHaveLength(1));
    expect(wallet.vote).toHaveBeenCalledWith(12, true);
    expect(callsTo(calls, "/api/label")[0]!.body).toEqual({ repo: "o/r", number: 9, txHash: "HASH1", sender: "me.testnet" });
    await waitFor(() => expect(callsTo(calls, "/api/analyse")).toHaveLength(2));
  });

  it("paid panel lists items with transaction links and the fallback link", async () => {
    mockApi({
      analyse: [ok([])],
      paid: [
        { prUrl: "https://github.com/o/r/pull/1", repo: "o/r", number: 1, title: "Fix typo", recipient: "alice.testnet", amountNear: "0.5", via: "direct", timestampMs: 1762000000000, txHash: "TX1", fallbackHref: "https://explorer.test/address/m" },
        { prUrl: "https://github.com/o/r/pull/2", repo: "o/r", number: 2, title: null, recipient: "bob.testnet", amountNear: "2", via: "dao", timestampMs: 1762100000000, txHash: null, fallbackHref: "https://explorer.test/address/m" },
      ],
    });
    render(<AnalyseRepo />);
    const panel = (await screen.findByRole("heading", { name: "Paid PRs" })).closest("section")!;
    expect(within(panel).getByRole("link", { name: "Fix typo" }).getAttribute("href")).toBe("https://github.com/o/r/pull/1");
    expect(within(panel).getByText("direct")).toBeTruthy();
    expect(within(panel).getByText("DAO-approved")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "View transaction" }).getAttribute("href")).toBe("https://explorer.test/txns/TX1");
    expect(within(panel).getByRole("link", { name: "View on explorer" }).getAttribute("href")).toBe("https://explorer.test/address/m");
  });
});
