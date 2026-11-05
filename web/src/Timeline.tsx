import { useEffect, useState } from "react";
import type { Clause, LogEntry } from "@termwork/shared";
import { explorerAccount, fetchReceipt, isReceiptHash, fmtNear, receiptBadge, type Receipt } from "./chain";

export const safeHttp = (u: string | null | undefined): string | null => {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : null;
  } catch {
    return null;
  }
};

function ReceiptBadge({ hash }: { hash: string }) {
  const [receipt, setReceipt] = useState<Receipt | null | undefined>(undefined);
  useEffect(() => {
    void fetchReceipt(hash).then(setReceipt);
  }, [hash]);
  const badge = receiptBadge(receipt === undefined ? null : receipt);
  const label = receipt === undefined ? "inference receipt" : badge.label;
  const tone = receipt === undefined ? "none" : badge.tone;
  return (
    <a
      className={`badge badge-${tone}`}
      href={`/receipts/${hash}.json`}
      target="_blank"
      rel="noreferrer"
      title={`receipt ${hash}`}
    >
      {label}
    </a>
  );
}

export function Timeline({ log, clauses }: { log: LogEntry[]; clauses: Clause[] }) {
  const clause = (id: number | null) => (id == null ? null : clauses.find((c) => c.id === id));
  return (
    <ol className="timeline">
      {[...log].reverse().map((e) => {
        const ev = safeHttp(e.evidence_url);
        const c = clause(e.clause_id);
        return (
          <li key={e.index} id={`log-${e.index}`} className={`tl tl-${e.kind}`}>
            <div className="tl-head">
              <span className="tl-idx">#{e.index}</span>
              <span className="tl-kind">{e.kind}</span>
              {e.amount && <span className="tl-amt">{fmtNear(e.amount)} NEAR</span>}
              <time className="tl-time">{new Date(e.timestamp_ms).toLocaleString()}</time>
            </div>
            <div className="tl-body">
              {c && <span className="tl-clause">clause {c.id}</span>}
              {e.recipient && (
                <a href={explorerAccount(e.recipient)} target="_blank" rel="noreferrer">
                  {e.recipient}
                </a>
              )}
              {ev && (
                <a href={ev} target="_blank" rel="noreferrer">
                  pull request
                </a>
              )}
              {isReceiptHash(e.receipt_hash) && <ReceiptBadge hash={e.receipt_hash} />}
            </div>
            {e.note && <p className="tl-note">{e.note}</p>}
          </li>
        );
      })}
      {log.length === 0 && <li className="empty">No work logged yet.</li>}
    </ol>
  );
}
