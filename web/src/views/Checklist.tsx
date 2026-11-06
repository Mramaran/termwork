import type { CheckItem } from "../run";

interface Props {
  items: CheckItem[];
  confirmed: Record<string, boolean>;
  /** true once the live key read has failed. */
  keysFailed: boolean;
  keysCount: number | null;
  idPrefix: string;
}

function label(item: CheckItem, keysFailed: boolean, keysCount: number | null): string {
  if (item.kind !== "live-keys") return item.label;
  if (keysFailed) return "Agent keys on-chain: couldn't check right now";
  if (keysCount !== null && keysCount > 0) return `Agent keys on-chain: ${keysCount} still present`;
  return item.label;
}

export function Checklist({ items, confirmed, keysFailed, keysCount, idPrefix }: Props) {
  return (
    <ul className="checks">
      {items.map((item, i) => {
        const ok = confirmed[`${idPrefix}:${i}`] === true;
        const text = label(item, keysFailed, keysCount);
        return (
          <li key={i}>
            {ok ? (
              <span className="ok-chip" role="img" aria-label="confirmed">
                <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M2 6.5l2.6 2.6L10 3.4" /></svg>
              </span>
            ) : (
              <span className="rec" role="img" aria-label="not confirmed">–</span>
            )}
            {item.href ? (
              <a href={item.href} target="_blank" rel="noreferrer">{text}</a>
            ) : (
              <span>{text}{item.kind === "recorded" && !/recorded/i.test(text) ? " (recorded output)" : ""}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
