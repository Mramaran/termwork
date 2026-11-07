import { describe, expect, it } from "vitest";
import { makeLimiter } from "./limits";

const T = 1_700_000_000_000;

describe("makeLimiter", () => {
  it("refuses the 3rd call from one IP within a minute", () => {
    const l = makeLimiter(2, 100);
    expect(l("a", T).ok).toBe(true);
    expect(l("a", T + 1).ok).toBe(true);
    const r = l("a", T + 2);
    expect(r.ok).toBe(false);
    expect(l("a", T + 60_001).ok).toBe(true);
  });
  it("enforces the daily cap across IPs and reset clears both", () => {
    const l = makeLimiter(2, 3);
    expect(l("a", T).ok).toBe(true);
    expect(l("a", T + 1).ok).toBe(true);
    expect(l("b", T + 2).ok).toBe(true);
    expect(l("c", T + 3).ok).toBe(false);
    l.reset();
    expect(l("c", T + 4).ok).toBe(true);
    expect(l("a", T + 5).ok).toBe(true);
    expect(l("a", T + 6).ok).toBe(true);
    expect(l("a", T + 7).ok).toBe(false);
  });
});
