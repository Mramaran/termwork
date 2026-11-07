export interface PullRequestFact {
  url: string;
  number: number;
  title: string;
  author: string;
  firstTime: boolean;
  /** How many of the author's merged PRs in this repo were merged earlier inside the same review window. Absent when no window applies. */
  earlierInWindow?: number;
  changedLines: number;
  labels: string[];
  mergedAt: string;
  nearAccount: string | null;
}

export interface SourceAdapter {
  listMerged(): Promise<PullRequestFact[]>;
}
