import { describe, expect, it } from "vitest";
import { DEMO_MISSION } from "@termwork/shared";
import { sputnikPolicy } from "../src/dao.js";

describe("sputnikPolicy", () => {
  it("defaults to a threshold of 2", () => {
    expect(sputnikPolicy(["a", "b", "c"]).default_vote_policy.threshold).toBe("2");
  });

  it("takes a threshold of 1 and keeps the council group as given", () => {
    const p = sputnikPolicy(["a", "b"], "1");
    expect(p.default_vote_policy.threshold).toBe("1");
    const council = p.roles.find((r) => r.name === "council")!;
    expect(council.kind).toEqual({ Group: ["a", "b"] });
  });
});

describe("DEMO_MISSION clause 1", () => {
  it("rewards merges inside the review window, with no 48 hours", () => {
    const text = DEMO_MISSION.clauses[0]!.text;
    expect(text).toBe("Reward first-time contributors whose pull requests were merged inside the review window the steward is asked to check.");
    expect(text).not.toContain("48 hours");
  });
});
