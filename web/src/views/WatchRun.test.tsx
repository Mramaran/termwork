// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE } from "../run.fixture";

vi.mock("../chain", async (orig) => ({
  ...(await orig<typeof import("../chain")>()),
  accessKeys: vi.fn(),
  fetchReceipt: vi.fn(async () => ({ verified: true })),
}));

import { accessKeys } from "../chain";
import { App } from "../App";
import { WatchRun } from "./WatchRun";

const keysMock = vi.mocked(accessKeys);

beforeEach(() => {
  keysMock.mockReset();
  keysMock.mockResolvedValue([]);
  window.location.hash = "";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => FIXTURE })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stepBtn = (name: string) => screen.getByRole("button", { name: new RegExp(`^\d?\s*${name}$`) });

describe("WatchRun", () => {
  it("opens on fired step with all five steps shown", async () => {
    render(<WatchRun run={FIXTURE} />);
    const list = screen.getByRole("list", { name: /lifecycle/i });
    const buttons = within(list).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Hire", "Work", "Vote", "Renew", "Fired"]);
    expect(buttons[4]!.getAttribute("aria-current")).toBe("step");
    expect(buttons.slice(0, 4).every((b) => !b.hasAttribute("aria-current"))).toBe(true);
    expect(buttons.every((b) => b.closest("li")!.classList.contains("done"))).toBe(true);
    expect(screen.getByText(/The agent's next attempt was rejected/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Keys on this account right now: none/)).toBeTruthy());
  });

  it("clicking Work shows five PR lines with AI reasons", () => {
    render(<WatchRun run={FIXTURE} />);
    fireEvent.click(stepBtn("Work"));
    expect(stepBtn("Work").getAttribute("aria-current")).toBe("step");
    expect(screen.getAllByText(/^PR #\d+ "/)).toHaveLength(5);
    const withAi = FIXTURE.prs.filter((p) => p.ai);
    expect(screen.getAllByText(/^Reason:/)).toHaveLength(withAi.length);
    expect(screen.getByText(`Reason: ${withAi[0]!.ai!.rationale}`)).toBeTruthy();
  });

  it("steps render from run.json when live status fails", async () => {
    keysMock.mockRejectedValue(new Error("rpc down"));
    render(<WatchRun run={FIXTURE} />);
    await waitFor(() => expect(screen.getByText(/couldn't check right now/i)).toBeTruthy());
    const item = screen.getByText(/Agent keys on-chain/).closest("li")!;
    expect(item.textContent).not.toContain("✓");
    expect(item.querySelector(".ok-chip")).toBeNull();
    expect(screen.getByText(/The agent's next attempt was rejected/)).toBeTruthy();
  });

  it("ticks live-keys when the key list is empty", async () => {
    render(<WatchRun run={FIXTURE} />);
    await waitFor(() => expect(screen.getByText(/Agent keys on-chain/).closest("li")!.querySelector(".ok-chip")).not.toBeNull());
  });

  it("stepper moves with Left and Right", () => {
    render(<WatchRun run={FIXTURE} />);
    fireEvent.keyDown(stepBtn("Fired"), { key: "ArrowLeft" });
    expect(stepBtn("Renew").getAttribute("aria-current")).toBe("step");
    fireEvent.keyDown(stepBtn("Renew"), { key: "ArrowRight" });
    expect(stepBtn("Fired").getAttribute("aria-current")).toBe("step");
    fireEvent.keyDown(stepBtn("Fired"), { key: "ArrowRight" });
    expect(stepBtn("Fired").getAttribute("aria-current")).toBe("step");
  });
});

describe("App", () => {
  it("header has exact tagline and no forbidden words", async () => {
    render(<App />);
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toBe("Termwork");
    expect(within(header).getByText("The AI agent that has to earn its next term.")).toBeTruthy();
    expect(within(header).getByText("Hired by vote. Renewed on evidence. Fired on-chain.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("list", { name: /lifecycle/i })).toBeTruthy());
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/claude|anthropic|→|·/i);
  });

  it("tabs follow the URL hash", async () => {
    window.location.hash = "#live";
    render(<App />);
    expect(screen.getByRole("link", { name: /Try the AI live/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("list", { name: /lifecycle/i })).toBeNull();
    window.location.hash = "#watch";
    fireEvent(window, new HashChangeEvent("hashchange"));
    await waitFor(() => expect(screen.getByRole("list", { name: /lifecycle/i })).toBeTruthy());
  });

  it("verify strip can be dismissed", async () => {
    render(<App />);
    expect(screen.getByText(/Verify in 60 seconds/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/Verify in 60 seconds/)).toBeNull();
  });
});
