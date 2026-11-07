import type { PullRequestFact, SourceAdapter } from "./types.js";

const NEAR_RE = /^near:\s*([a-z0-9._-]+\.testnet)\s*$/im;

export function parseNearAccount(body: string | null | undefined): string | null {
  return NEAR_RE.exec(body ?? "")?.[1] ?? null;
}

type FetchFn = typeof fetch;

export interface RangeResult {
  prs: PullRequestFact[];
  total: number;
  capped: boolean;
}

export class GitHubError extends Error {
  constructor(
    public status: number,
    public retryAfterSec: number | null,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

interface PullDetail {
  html_url: string;
  number: number;
  title: string;
  body: string | null;
  user: { login: string } | null;
  additions: number;
  deletions: number;
  labels: Array<{ name: string }>;
  merged_at: string | null;
}

function retryAfterOf(res: Response): number | null {
  const h = res.headers;
  const retry = Number(h?.get("retry-after"));
  if (h?.get("retry-after") && Number.isFinite(retry)) return Math.max(0, Math.ceil(retry));
  if (h?.get("x-ratelimit-remaining") === "0") {
    const reset = Number(h.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) return Math.max(0, Math.ceil(reset - Date.now() / 1000));
  }
  return null;
}

/** Raised internally when a run would exceed its per-run author search budget. */
class AuthorCapError extends Error {}

/** GitHub allows 30 searches a minute; one is the range search, so keep author searches well under it. */
const MAX_AUTHOR_SEARCHES = 25;

const isRateLimit = (e: unknown): boolean => e instanceof GitHubError && (e.retryAfterSec !== null || e.status === 429);

/** Shared GitHub REST helpers: authenticated GET and the per-run prior-merged cache. */
function githubClient(repo: string, fetchFn: FetchFn, token: string | undefined, maxAuthors = Infinity) {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "termwork-agent" };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function get<T>(url: string): Promise<T> {
    const res = await fetchFn(url, { headers });
    if (!res.ok) throw new GitHubError(res.status, retryAfterOf(res), `GitHub ${res.status} for ${url}`);
    return (await res.json()) as T;
  }

  const cache = new Map<string, Promise<string[]>>();
  /** One search per author: the merged_at of their merged PRs in the repo (first 100). */
  function mergedTimes(author: string): Promise<string[]> {
    let hit = cache.get(author);
    if (!hit) {
      if (cache.size >= maxAuthors) return Promise.reject(new AuthorCapError());
      const q = encodeURIComponent(`repo:${repo} is:pr is:merged author:${author}`);
      hit = get<{ items: Array<{ pull_request?: { merged_at?: string | null } }> }>(
        `https://api.github.com/search/issues?q=${q}&per_page=100`,
      ).then((r) => r.items.flatMap((i) => (i.pull_request?.merged_at ? [i.pull_request.merged_at] : [])));
      cache.set(author, hit);
    }
    return hit;
  }

  /** `windowStart` (YYYY-MM-DD) turns on the per-window count of the author's earlier merged PRs. */
  async function factFor(number: number, windowStart?: string): Promise<PullRequestFact | null> {
    const pr = await get<PullDetail>(`https://api.github.com/repos/${repo}/pulls/${number}`);
    if (!pr.user?.login || !pr.merged_at) return null;
    const mergedAt = pr.merged_at;
    const times = await mergedTimes(pr.user.login);
    const merged = Date.parse(mergedAt);
    const firstTime = !times.some((t) => Date.parse(t) < merged);
    const start = windowStart ? Date.parse(`${windowStart}T00:00:00Z`) : NaN;
    const window = Number.isNaN(start) ? {} : { earlierInWindow: times.filter((t) => Date.parse(t) >= start && Date.parse(t) < merged).length };
    return {
      url: pr.html_url,
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      firstTime,
      ...window,
      changedLines: pr.additions + pr.deletions,
      labels: pr.labels.map((l) => l.name),
      mergedAt: pr.merged_at,
      nearAccount: parseNearAccount(pr.body),
    };
  }

  return { get, factFor };
}

/** Public GitHub REST API adapter. "First-time" = the author has no earlier merged PR in the repo (shown, not a pay rule). */
export function githubAdapter(
  repo: string = process.env.GITHUB_REPO ?? "",
  fetchFn: FetchFn = fetch,
  token: string | undefined = process.env.GITHUB_TOKEN,
): SourceAdapter {
  const gh = githubClient(repo, fetchFn, token);
  return {
    async listMerged(): Promise<PullRequestFact[]> {
      if (!repo) throw new Error("GITHUB_REPO is not set");
      const closed = await gh.get<Array<{ number: number; merged_at: string | null }>>(
        `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`,
      );
      const out: PullRequestFact[] = [];
      for (const c of closed.filter((p) => p.merged_at)) {
        try {
          const fact = await gh.factFor(c.number);
          if (fact) out.push(fact);
        } catch {
          // facts for this PR could not be fetched; skip it and keep going
        }
      }
      return out;
    },
  };
}

interface ReadOpts {
  fetchFn?: FetchFn;
  token?: string;
}

/** Merged PRs in the repo between two dates (YYYY-MM-DD, inclusive), at most `cap` facts. */
export async function listMergedInRange(
  repo: string,
  from: string,
  to: string,
  opts: ReadOpts & { cap?: number } = {},
): Promise<RangeResult> {
  const cap = opts.cap ?? 30;
  const gh = githubClient(repo, opts.fetchFn ?? fetch, opts.token, MAX_AUTHOR_SEARCHES);
  const q = encodeURIComponent(`repo:${repo} is:pr is:merged merged:${from}..${to}`);
  const search = await gh.get<{ total_count: number; items: Array<{ number: number }> }>(
    `https://api.github.com/search/issues?q=${q}&per_page=${cap}`,
  );
  const prs: PullRequestFact[] = [];
  let failures = 0;
  let overAuthorCap = false;
  for (const hit of search.items.slice(0, cap)) {
    try {
      const fact = await gh.factFor(hit.number, from);
      if (fact) prs.push(fact);
    } catch (e) {
      if (e instanceof AuthorCapError) {
        overAuthorCap = true;
        continue;
      }
      if (isRateLimit(e)) throw e;
      failures++;
      // facts for this PR could not be fetched; skip it and keep going
    }
  }
  if (prs.length === 0 && failures > 0 && !overAuthorCap) throw new GitHubError(502, null, "GitHub could not return pull request details");
  return { prs, total: search.total_count, capped: search.total_count > cap || overAuthorCap };
}

/** Facts for one merged PR, or null when it does not exist or is not merged. */
export async function getMergedPr(repo: string, number: number, opts: ReadOpts & { windowStart?: string } = {}): Promise<PullRequestFact | null> {
  const gh = githubClient(repo, opts.fetchFn ?? fetch, opts.token);
  try {
    return await gh.factFor(number, opts.windowStart);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}
