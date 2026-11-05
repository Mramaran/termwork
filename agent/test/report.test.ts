import { describe, it, expect } from "vitest";
import { checkCitations } from "../src/report.js";

describe("checkCitations", () => {
  it("accepts a cited report", () => {
    expect(checkCitations("Paid alice [#1] and [#2].", new Set([1, 2]))).toEqual({ ok: true });
  });
  it("checkCitations rejects missing index", () => {
    const r = checkCitations("Paid alice [#1] and [#7].", new Set([1, 2]));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/7/);
  });
  it("rejects no citations", () => {
    expect(checkCitations("no cites", new Set([1])).ok).toBe(false);
  });
  it("checkCitations rejects >4096 bytes", () => {
    const big = "[#1] " + "é".repeat(2100); // 2 bytes each in UTF-8, only 2105 chars
    const r = checkCitations(big, new Set([1]));
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/4096/);
  });
});
