export const MAX_REPORT_BYTES = 4096;

export type CitationCheck = { ok: true } | { ok: false; reason: string };

/** A renewal report must cite at least one work-log entry as `[#n]`, cite only entries that exist, and fit the contract limit. */
export function checkCitations(report: string, logIndices: Set<number>): CitationCheck {
  const bytes = new TextEncoder().encode(report).length;
  if (bytes > MAX_REPORT_BYTES) return { ok: false, reason: `report is ${bytes} bytes, over the ${MAX_REPORT_BYTES} byte limit` };
  const cited = [...report.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
  if (cited.length === 0) return { ok: false, reason: "report has no [#n] citations" };
  const missing = [...new Set(cited.filter((n) => !logIndices.has(n)))];
  if (missing.length) return { ok: false, reason: `cites work-log entries that do not exist: ${missing.map((n) => `#${n}`).join(", ")}` };
  return { ok: true };
}
