import { useRef } from "react";
import type { StepId } from "../run";

export const STEP_ORDER: StepId[] = ["hire", "work", "vote", "renew", "fired"];
const LABEL: Record<StepId, string> = { hire: "Hire", work: "Work", vote: "Vote", renew: "Renew", fired: "Fired" };

interface Props {
  selected: StepId;
  onSelect: (id: StepId) => void;
}

/** Five numbered steps. Left and Right move between them; Enter or click selects (a native button). */
export function Stepper({ selected, onSelect }: Props) {
  const refs = useRef<Partial<Record<StepId, HTMLButtonElement | null>>>({});

  const move = (from: StepId, delta: number) => {
    const next = STEP_ORDER[Math.min(STEP_ORDER.length - 1, Math.max(0, STEP_ORDER.indexOf(from) + delta))]!;
    onSelect(next);
    refs.current[next]?.focus();
  };

  return (
    <ol className="steps" aria-label="Lifecycle">
      {STEP_ORDER.map((id) => (
        <li key={id} className={`done${id === "fired" ? " fired" : ""}${id === selected ? " selected" : ""}`}>
          <button
            type="button"
            ref={(el) => {
              refs.current[id] = el;
            }}
            aria-current={id === selected ? "step" : undefined}
            onClick={() => onSelect(id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") {
                e.preventDefault();
                move(id, 1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                move(id, -1);
              }
            }}
          >
            {LABEL[id]}
          </button>
        </li>
      ))}
    </ol>
  );
}
