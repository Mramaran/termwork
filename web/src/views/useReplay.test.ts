// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepId } from "../run";
import { useReplay } from "./useReplay";

const IDS: StepId[] = ["hire", "work", "vote", "renew", "fired"];

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

/** Advance in small steps so each re-render can schedule the next timer, as real time would. */
const run = (ms: number) => {
  for (let t = 0; t < ms; t += 100) act(() => void vi.advanceTimersByTime(Math.min(100, ms - t)));
};

describe("useReplay", () => {
  it("rests on the fired step showing everything", () => {
    const { result } = renderHook(() => useReplay(IDS, { msPerStep: 4000 }));
    expect(result.current.playing).toBe(false);
    expect(result.current.step).toBe("fired");
    expect(result.current.linesShown).toBe(Infinity);
  });

  it("play walks hire→fired at 4s per step", () => {
    const { result } = renderHook(() => useReplay(IDS, { msPerStep: 4000, lineCounts: { hire: 4, work: 2, vote: 4, renew: 1, fired: 3 } }));
    act(() => result.current.play());
    expect(result.current.playing).toBe(true);
    expect(result.current.step).toBe("hire");
    expect(result.current.linesShown).toBe(1);
    run(1000);
    expect(result.current.linesShown).toBe(2);
    run(3000);
    expect(result.current.step).toBe("work");
    expect(result.current.linesShown).toBe(1);
    run(3999);
    expect(result.current.step).toBe("work");
    run(1);
    expect(result.current.step).toBe("vote");
    run(4000);
    expect(result.current.step).toBe("renew");
    run(4000);
    expect(result.current.step).toBe("fired");
    expect(result.current.playing).toBe(true);
    run(4300); // uneven 3-line split drifts a little on 100 ms chunks
    expect(result.current.playing).toBe(false);
    expect(result.current.step).toBe("fired");
    expect(result.current.linesShown).toBe(Infinity);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("selecting a step stops replay", () => {
    const { result } = renderHook(() => useReplay(IDS, { msPerStep: 4000 }));
    act(() => result.current.play());
    run(4000);
    expect(result.current.step).toBe("work");
    act(() => result.current.select("hire"));
    expect(result.current.playing).toBe(false);
    expect(result.current.step).toBe("hire");
    expect(result.current.linesShown).toBe(Infinity);
    expect(vi.getTimerCount()).toBe(0);
    run(20000);
    expect(result.current.step).toBe("hire");
  });

  it("pause stops the timers", () => {
    const { result } = renderHook(() => useReplay(IDS, { msPerStep: 4000 }));
    act(() => result.current.play());
    act(() => result.current.pause());
    expect(result.current.playing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replay=1 autoplays", () => {
    window.history.replaceState(null, "", "/?replay=1");
    const { result } = renderHook(() => useReplay(IDS, { msPerStep: 4000 }));
    expect(result.current.playing).toBe(true);
    expect(result.current.step).toBe("hire");
  });

  it("replay=1 paints step 1 on the very first render", () => {
    window.history.replaceState(null, "", "/?replay=1");
    let first: { step: string; linesShown: number } | null = null;
    renderHook(() => {
      const r = useReplay(IDS, { msPerStep: 4000 });
      first ??= { step: r.step, linesShown: r.linesShown };
      return r;
    });
    expect(first).toEqual({ step: "hire", linesShown: 1 });
  });
});
