import { describe, expect, it } from "vitest";
import { DEMO_MAX_REQUEST, DEMO_MISSION, DEMO_SPEND_THRESHOLD } from "../src/index.js";

describe("demo mission", () => {
  it("demo mission matches the hired mission", () => {
    expect(DEMO_MISSION.title).toBe("Contributor Rewards Steward");
    expect(DEMO_MISSION.clauses).toHaveLength(4);
    expect(DEMO_MISSION.clauses.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(DEMO_MISSION.clauses.map((c) => c.pays)).toEqual([true, true, true, false]);
    expect(DEMO_MISSION.clauses.map((c) => c.max_amount)).toEqual([
      "500000000000000000000000",
      "200000000000000000000000",
      "500000000000000000000000",
      null,
    ]);
  });

  it("exposes the spend threshold and max request in yoctoNEAR", () => {
    expect(DEMO_SPEND_THRESHOLD).toBe("200000000000000000000000");
    expect(DEMO_MAX_REQUEST).toBe("500000000000000000000000");
  });
});
