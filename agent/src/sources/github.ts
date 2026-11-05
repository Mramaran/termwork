import type { PullRequestFact, SourceAdapter } from "./types.js";

const NEAR_RE = /^near:\s*([a-z0-9._-]+\.testnet)\s*$/im;

export function parseNearAccount(body: string | null | undefined): string | null {
  return NEAR_RE.exec(body ?? "")?.[1] ?? null;
}

type FetchFn = typeof fetch;

/** Public GitHub REST API adapter. "First-time" = the author has no earlier merged PR in the repo. */
export function githubAdapter(
  repo: string = process.env.GITHUB_REPO ?? "",
  fetchFn: FetchFn = fetch,
  token: string | undefined = process.env.GITHUB_TOKEN,
): SourceAdapter {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "termwork-agent" };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function get<T>(url: string): Promise<T> {
    const res = await fetchFn(url, { headers });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
    return (await res.json()) as T;
  }

  return {
    async listMerged(): Promise<PullRequestFact[]> {
      if (!repo) throw new Error("GITHUB_REPO is not set");
      const closed = await get<Array<{ number: number; merged_at: string | null }>>(
        `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`,
      );
      const out: PullRequestFact[] = [];
      const cache = new Map<string, Promise<number>>();
      const priorMerged = (author: string, mergedAt: string): Promise<number> => {
        const q = encodeURIComponent(`is:pr is:merged author:${author} repo:${repo} merged:<${mergedAt}`);
        let hit = cache.get(q);
        if (!hit) {
          hit = get<{ total_count: number }>(`https://api.github.com/search/issues?q=${q}`).then((r) => r.total_count);
          cache.set(q, hit);
        }
        return hit;
      };
      for (const c of closed.filter((p) => p.merged_at)) {
        try {
          const pr = await get<{
            html_url: string;
            number: number;
            title: string;
            body: string | null;
            user: { login: string } | null;
            additions: number;
            deletions: number;
            labels: Array<{ name: string }>;
            merged_at: string;
          }>(`https://api.github.com/repos/${repo}/pulls/${c.number}`);
          if (!pr.user?.login) continue;
          const prior = await priorMerged(pr.user.login, pr.merged_at);
          out.push({
            url: pr.html_url,
            number: pr.number,
            title: pr.title,
            author: pr.user.login,
            firstTime: prior === 0,
            changedLines: pr.additions + pr.deletions,
            labels: pr.labels.map((l) => l.name),
            mergedAt: pr.merged_at,
            nearAccount: parseNearAccount(pr.body),
          });
        } catch {
          // facts for this PR could not be fetched; skip it and keep going
        }
      }
      return out;
    },
  };
}
