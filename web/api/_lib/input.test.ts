import { describe, expect, it } from "vitest";
import { parseRepo, parseRange, payableRepos } from "./input";

const NOW = Date.parse("2026-11-07T12:00:00Z");

describe("parseRepo", () => {
  it.each([
    " near/near-cli-rs ",
    "https://github.com/near/near-cli-rs",
    "https://github.com/near/near-cli-rs/",
    "near/near-cli-rs.git",
    "github.com/Near/Near-Cli-Rs",
  ])("normalises %j", (v) => {
    expect(parseRepo(v)).toEqual({ repo: "near/near-cli-rs" });
  });
  it.each(["", "near", "a/b/c", "near/../x", "a".repeat(200), 5, null])("rejects %j", (v) => {
    expect(parseRepo(v)).toHaveProperty("error");
  });
});

describe("parseRange", () => {
  it("week", () => expect(parseRange({ preset: "week" }, NOW)).toEqual({ from: "2026-10-31", to: "2026-11-07" }));
  it("month", () => expect(parseRange({ preset: "month" }, NOW)).toEqual({ from: "2026-10-08", to: "2026-11-07" }));
  it("custom valid", () =>
    expect(parseRange({ preset: "custom", from: "2026-09-01", to: "2026-09-30" }, NOW)).toEqual({ from: "2026-09-01", to: "2026-09-30" }));
  it("from after to", () => expect(parseRange({ preset: "custom", from: "2026-09-30", to: "2026-09-01" }, NOW)).toHaveProperty("error"));
  it("to in the future", () => expect(parseRange({ preset: "custom", from: "2026-11-01", to: "2026-11-08" }, NOW)).toHaveProperty("error"));
  it("span over 366 days", () => expect(parseRange({ preset: "custom", from: "2025-01-01", to: "2026-11-01" }, NOW)).toHaveProperty("error"));
  it("bad format", () => expect(parseRange({ preset: "custom", from: "9/1/2026", to: "2026-09-30" }, NOW)).toHaveProperty("error"));
  it("rejects impossible dates and unknown presets", () => {
    expect(parseRange({ preset: "custom", from: "2026-02-30", to: "2026-03-01" }, NOW)).toHaveProperty("error");
    expect(parseRange({ preset: "year" }, NOW)).toHaveProperty("error");
    expect(parseRange(null, NOW)).toHaveProperty("error");
  });
});

describe("payableRepos", () => {
  it("lower-cases and splits", () => {
    const s = payableRepos("Mramaran/Mission-Dao-Demo, near/x");
    expect(s.has("mramaran/mission-dao-demo")).toBe(true);
    expect(s.has("near/x")).toBe(true);
    expect(s.size).toBe(2);
  });
  it("empty when undefined", () => expect(payableRepos(undefined).size).toBe(0));
});
