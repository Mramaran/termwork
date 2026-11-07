import { describe, it, expect } from "vitest";
import type { MandateView } from "@termwork/shared";
import { decisionMessages } from "../src/prompts.js";
import type { PullRequestFact } from "../src/sources/types.js";

const mandate = { mission: { title: "Contributor Rewards Steward", clauses: [] } } as unknown as MandateView;
const pr: PullRequestFact = {
  url: "https://github.com/termwork/demo/pull/1",
  number: 1,
  title: "fix typo",
  author: "alice",
  firstTime: true,
  changedLines: 12,
  labels: [],
  mergedAt: "2026-11-01T00:00:00Z",
  nearAccount: "alice.demo.testnet",
};

describe("decisionMessages", () => {
  it("gives the model the PR's NEAR account so clause 4 can be judged", () => {
    const user = JSON.parse(decisionMessages(mandate, pr)[1]!.content as string);
    expect(user.near_account).toBe("alice.demo.testnet");
  });

  it("tells the model a small code fix is never trivial", () => {
    const system = decisionMessages(mandate, pr)[0]!.content as string;
    expect(system).toContain("A change to code that fixes a bug or adds behaviour is never trivial, however few lines it changes.");
  });

  it("sends near_account null when the PR names no account", () => {
    const user = JSON.parse(decisionMessages(mandate, { ...pr, nearAccount: null })[1]!.content as string);
    expect(user.near_account).toBeNull();
  });
});
