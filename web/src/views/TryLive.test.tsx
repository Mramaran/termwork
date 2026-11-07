// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunYourself } from "./RunYourself";
import { TryLive } from "./TryLive";

const OK = (verified: boolean) => ({
  answer: { qualifies: true, clause_id: "c1", amount_near: "0.2", rationale: "A small docs fix." },
  rules: [
    { rule: "amount within the maximum request", pass: true },
    { rule: "recipient exists on-chain", pass: true, note: "skipped in the playground" },
    { rule: "first-time contributor", pass: false },
  ],
  result: "would pay",
  amountNear: "0.2",
  receipt: { verified, model: "m", signature: { signing_address: "0xabc" }, attestation: {} },
  receiptHash: "h",
});

const respond = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 300, status, json: async () => body }));

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  vi.unstubAllGlobals();
});

describe("TryLive", () => {
  it("preset fills the form", () => {
    render(<TryLive />);
    fireEvent.click(screen.getByRole("button", { name: "Big feature" }));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("feat: dark mode");
    expect((screen.getByLabelText("Changed lines") as HTMLInputElement).value).toBe("340");
    expect((screen.getByLabelText("NEAR account") as HTMLInputElement).value).toBe("dave.testnet");
    expect((screen.getByLabelText("Feature") as HTMLInputElement).checked).toBe(true);
  });

  it("shows AI said, rules and result on 200", async () => {
    const f = respond(200, OK(true));
    vi.stubGlobal("fetch", f);
    render(<TryLive />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent" }));
    expect(await screen.findByText("A small docs fix.")).toBeTruthy();
    expect(screen.getByText(/would pay/)).toBeTruthy();
    expect(screen.getByText(/skipped in the playground/)).toBeTruthy();
    expect(screen.getByText(/Fail: first-time contributor/)).toBeTruthy();
    expect(screen.getByText(/Pass: amount within the maximum request/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /full receipt/ })).toBeTruthy();
    expect(screen.getByText("0xabc")).toBeTruthy();
    expect(screen.getByText(/Nothing is paid\. This calls the same model/)).toBeTruthy();
    const init = (f.mock.calls[0] as unknown as [string, { body: string }])[1];
    expect(JSON.parse(init.body)).toEqual({ title: "fix: handle empty config file", changedLines: 24, feature: false, nearAccount: "alice.testnet" });
  });

  it("shows error and no badge on 502", async () => {
    vi.stubGlobal("fetch", respond(502, { error: "The model call failed." }));
    render(<TryLive />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The model call failed.");
    expect(screen.queryByText(/verified inference/)).toBeNull();
    expect(screen.queryByText(/would pay/)).toBeNull();
  });

  it("shows an unreadable answer as such, not as a refusal", async () => {
    const body = { ...OK(true), answer: { error: "no JSON found" }, result: "would skip" };
    vi.stubGlobal("fetch", respond(200, body));
    render(<TryLive />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent" }));
    expect(await screen.findByText(/couldn't be read as a decision/)).toBeTruthy();
    expect(screen.queryByText(/does not qualify/)).toBeNull();
    expect(screen.getByText(/would skip/)).toBeTruthy();
    expect(screen.getByText(/Fail: first-time contributor/)).toBeTruthy();
  });

  it("verified badge only when receipt.verified is true", async () => {
    vi.stubGlobal("fetch", respond(200, OK(false)));
    render(<TryLive />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent" }));
    await waitFor(() => expect(screen.getByText("unverified")).toBeTruthy());
    expect(screen.queryByText("verified inference")).toBeNull();
    cleanup();
    vi.stubGlobal("fetch", respond(200, OK(true)));
    render(<TryLive />);
    fireEvent.click(screen.getByRole("button", { name: "Ask the agent" }));
    expect(await screen.findByText("verified inference")).toBeTruthy();
  });
});

describe("RunYourself", () => {
  it("run-yourself shows faucet note", () => {
    render(<RunYourself />);
    expect(screen.getByText(/No API keys needed\. It uses about 30 testnet NEAR from the public faucet/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Copy/ })).toHaveLength(3);
  });

  it("links to README sections that exist", () => {
    render(<RunYourself />);
    const hrefs = screen.getAllByRole("link", { name: "README section" }).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      "https://github.com/Mramaran/termwork#the-end-to-end-demo",
      "https://github.com/Mramaran/termwork#the-end-to-end-demo",
      "https://github.com/Mramaran/termwork#tests",
    ]);
  });

  it("copy shows Copied on success", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<RunYourself />);
    fireEvent.click(screen.getByRole("button", { name: "Copy command 1" }));
    expect(await screen.findByText(/Copied/)).toBeTruthy();
    expect(writeText).toHaveBeenCalled();
  });

  it("copy failure says so", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("no"); } }, configurable: true });
    document.execCommand = vi.fn(() => false);
    render(<RunYourself />);
    fireEvent.click(screen.getByRole("button", { name: "Copy command 1" }));
    expect(await screen.findByText(/Copy failed/)).toBeTruthy();
  });
});
