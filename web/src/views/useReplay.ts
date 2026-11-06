import { useCallback, useEffect, useState } from "react";
import type { StepId } from "../run";

interface Options {
  msPerStep: number;
  /** Feed lines per step; they appear one at a time, evenly spaced within the step. Defaults to one per step. */
  lineCounts?: Partial<Record<StepId, number>>;
}

interface Pos {
  idx: number;
  /** Lines visible; Infinity means all of them (not replaying). */
  shown: number;
  playing: boolean;
  /** True from play() until the user selects a step, so the view knows a replay reached the current step. */
  replayed: boolean;
}

const wantsReplay = (): boolean => {
  const fromSearch = new URLSearchParams(window.location.search).get("replay");
  const hash = window.location.hash;
  const q = hash.indexOf("?");
  const fromHash = q >= 0 ? new URLSearchParams(hash.slice(q + 1)).get("replay") : null;
  return fromSearch === "1" || fromHash === "1";
};

/** Walks through the steps on a timer. Selecting a step or pausing clears the timer and shows the step in full. */
export function useReplay(stepIds: StepId[], opts: Options) {
  const last = stepIds.length - 1;
  const count = (id: StepId | undefined) => Math.max(1, (id && opts.lineCounts?.[id]) || 1);
  const [pos, setPos] = useState<Pos>(() =>
    wantsReplay() ? { idx: 0, shown: 1, playing: true, replayed: true } : { idx: last, shown: Infinity, playing: false, replayed: false },
  );

  const play = useCallback(() => setPos({ idx: 0, shown: 1, playing: true, replayed: true }), []);
  const pause = useCallback(() => setPos((p) => ({ ...p, playing: false, shown: Infinity })), []);
  const select = useCallback(
    (id: StepId) => setPos({ idx: Math.max(0, stepIds.indexOf(id)), shown: Infinity, playing: false, replayed: false }),
    [stepIds],
  );

  const { idx, shown, playing } = pos;
  const n = count(stepIds[idx]);
  const delay = opts.msPerStep / n;
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      setPos((p) => {
        if (!p.playing) return p;
        if (p.shown < n) return { ...p, shown: p.shown + 1 };
        if (p.idx < last) return { ...p, idx: p.idx + 1, shown: 1 };
        return { ...p, playing: false, shown: Infinity };
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [playing, idx, shown, n, delay, last]);

  return { playing, step: stepIds[idx]!, linesShown: shown, replayed: pos.replayed, play, pause, select };
}
