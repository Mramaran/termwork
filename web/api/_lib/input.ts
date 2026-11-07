const OWNER_RE = /^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/;
const NAME_RE = /^[A-Za-z\d._-]{1,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Accepts owner/name, a github.com URL or a .git form; returns the lower-cased owner/name. */
export function parseRepo(v: unknown): { repo: string } | { error: string } {
  if (typeof v !== "string") return { error: "repo must be a string" };
  let s = v.trim();
  if (s.length < 3 || s.length > 100) return { error: "repo must look like owner/name" };
  s = s.replace(/^https?:\/\//i, "").replace(/^github\.com\//i, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = s.split("/");
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name || !OWNER_RE.test(owner) || !NAME_RE.test(name) || name === "." || name === "..")
    return { error: "repo must look like owner/name" };
  return { repo: `${owner}/${name}`.toLowerCase() };
}

export type RangeInput = { preset: "week" | "month" } | { preset: "custom"; from: string; to: string };

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
function dayMs(s: string): number | null {
  if (!DATE_RE.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(ms) || day(ms) !== s ? null : ms;
}

/** Resolves a range input to UTC calendar dates, inclusive of both ends. */
export function parseRange(v: unknown, now: number): { from: string; to: string } | { error: string } {
  if (typeof v !== "object" || v === null) return { error: "range must be an object" };
  const r = v as Record<string, unknown>;
  const today = day(now);
  if (r.preset === "week") return { from: day(now - 7 * DAY_MS), to: today };
  if (r.preset === "month") return { from: day(now - 30 * DAY_MS), to: today };
  if (r.preset !== "custom") return { error: "range.preset must be week, month or custom" };
  if (typeof r.from !== "string" || typeof r.to !== "string") return { error: "custom range needs from and to dates" };
  const f = dayMs(r.from);
  const t = dayMs(r.to);
  if (f === null || t === null) return { error: "dates must be real YYYY-MM-DD dates" };
  if (f > t) return { error: "from must not be after to" };
  if (r.to > today) return { error: "to must not be in the future" };
  if ((t - f) / DAY_MS > 366) return { error: "range must be 366 days or fewer" };
  return { from: r.from, to: r.to };
}

/** Repos allowed to be paid for real, from a comma-separated env value; lower-cased. */
export function payableRepos(env: string | undefined): Set<string> {
  return new Set((env ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
