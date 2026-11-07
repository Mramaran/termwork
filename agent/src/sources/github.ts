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

const isRateLimit = (e: unknown): boolean => e instanceof GitHubError && (e.retryAfterSec !== null || e.status === 429);

/** Shared GitHub REST helpers: authenticated GET and the per-run prior-merged cache. */
function githubClient(repo: string, fetchFn: FetchFn, token: string | undefined) {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "termwork-agent" };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function get<T>(url: string): Promise<T> {
    const res = await fetchFn(url, { headers });
    if (!res.ok) throw new GitHubError(res.status, retryAfterOf(res), `GitHub ${res.status} for ${url}`);
    return (await res.json()) as T;
  }

  const cache = new Map<string, Promise<number>>();
  /** Merged PRs by this author in the repo before `mergedAt`, over the whole history. */
  function priorMerged(author: string, mergedAt: string): Promise<number> {
    const q = encodeURIComponent(`is:pr is:merged author:${author} repo:${repo} merged:<${mergedAt}`);
    let hit = cache.get(q);
    if (!hit) {
      hit = get<{ total_count: number }>(`https://api.github.com/search/issues?q=${q}`).then((r) => r.total_count);
      cache.set(q, hit);
    }
    return hit;
  }

  async function factFor(number: number): Promise<PullRequestFact | null> {
    const pr = await get<PullDetail>(`https://api.github.com/repos/${repo}/pulls/${number}`);
    if (!pr.user?.login || !pr.merged_at) return null;
    const prior = await priorMerged(pr.user.login, pr.merged_at);
    return {
      url: pr.html_url,
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      firstTime: prior === 0,
      changedLines: pr.additions + pr.deletions,
      labels: pr.labels.map((l) => l.name),
      mergedAt: pr.merged_at,
      nearAccount: parseNearAccount(pr.body),
    };
  }

  return { get, factFor };
}

/** Public GitHub REST API adapter. "First-time" = the author has no earlier merged PR in the repo. */
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
  const gh = githubClient(repo, opts.fetchFn ?? fetch, opts.token);
  const q = encodeURIComponent(`repo:${repo} is:pr is:merged merged:${from}..${to}`);
  const search = await gh.get<{ total_count: number; items: Array<{ number: number }> }>(
    `https://api.github.com/search/issues?q=${q}&per_page=${cap}`,
  );
  const prs: PullRequestFact[] = [];
  for (const hit of search.items.slice(0, cap)) {
    try {
      const fact = await gh.factFor(hit.number);
      if (fact) prs.push(fact);
    } catch (e) {
      if (isRateLimit(e)) throw e;
      // facts for this PR could not be fetched; skip it and keep going
    }
  }
  return { prs, total: search.total_count, capped: search.total_count > cap };
}

/** Facts for one merged PR, or null when it does not exist or is not merged. */
export async function getMergedPr(repo: string, number: number, opts: ReadOpts = {}): Promise<PullRequestFact | null> {
  const gh = githubClient(repo, opts.fetchFn ?? fetch, opts.token);
  try {
    return await gh.factFor(number);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}
