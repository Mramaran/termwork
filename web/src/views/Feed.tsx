import { useEffect, useRef } from "react";
import { linkifyCitations } from "../chain";
import type { FeedLine } from "../run";

type Marker = "ai" | "ok" | "no" | "vote" | "none";

const MARK_LABEL: Record<Marker, string> = { ai: "AI answer", ok: "confirmed", no: "refused", vote: "DAO vote", none: "" };

function markerFor(line: FeedLine): Marker {
  if (line.detail || /^AI said/.test(line.text)) return "ai";
  if (/^Rules: ✗|^Result: skipped/.test(line.text)) return "no";
  if (/vote|proposal|council|DAO/i.test(line.text) && line.tone !== "info") return "vote";
  if (line.tone === "bad") return "no";
  if (line.tone === "ok" || line.tone === "warn") return "ok";
  return "none";
}

interface Props {
  lines: FeedLine[];
  /** Renew report: citation [#n] click. */
  onCite?: (index: number) => void;
  /** PR number whose first line should be scrolled to and highlighted. */
  focusPr?: number | null;
}

function Text({ text, onCite }: { text: string; onCite?: Props["onCite"] }) {
  if (!onCite || !/\[#\d+\]/.test(text)) return <>{text}</>;
  return (
    <>
      {linkifyCitations(text).map((p, i) =>
        p.kind === "text" ? (
          <span key={i}>{p.text}</span>
        ) : (
          <button key={i} type="button" className="cite" onClick={() => onCite(p.index)} aria-label={`Show pull request ${p.index} in the Work step`}>
            {p.text}
          </button>
        ),
      )}
    </>
  );
}

export function Feed({ lines, onCite, focusPr }: Props) {
  const focusRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    focusRef.current?.scrollIntoView?.({ block: "center" });
  }, [focusPr]);

  return (
    <div className="log" role="log" aria-label="What happened">
      {lines.map((l, i) => {
        const m = markerFor(l);
        const isFocus = focusPr != null && l.text.startsWith(`PR #${focusPr} `);
        const long = l.text.length > 140 || l.text.includes("\n");
        return (
          <div key={i} className={`entry${isFocus ? " focus" : ""}`}>
            <p ref={isFocus ? focusRef : undefined} className={long ? "long" : undefined}>
              <span className={`mk ${m}`} aria-hidden="true" />
              {m !== "none" && <span className="sr">{MARK_LABEL[m]}: </span>}
              <span className={m === "no" && /^Rules:|^Result:/.test(l.text) ? "no-text" : undefined}>
                <Text text={l.text} onCite={onCite} />
              </span>
            </p>
            {l.detail?.ai && <p className="reason"><span className="mk none" aria-hidden="true" /><span>Reason: {l.detail.ai.rationale}</span></p>}
          </div>
        );
      })}
    </div>
  );
}

export function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      <span><i className="mk ai" aria-hidden="true" />AI answer</span>
      <span><i className="mk vote" aria-hidden="true" />DAO vote</span>
      <span><i className="mk ok" aria-hidden="true" />confirmed</span>
      <span><i className="mk no" aria-hidden="true" />refused</span>
    </div>
  );
}
