export interface PullRequestFact {
  url: string;
  number: number;
  title: string;
  author: string;
  firstTime: boolean;
  changedLines: number;
  labels: string[];
  mergedAt: string;
  nearAccount: string | null;
}

export interface SourceAdapter {
  listMerged(): Promise<PullRequestFact[]>;
}
