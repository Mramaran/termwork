import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PullRequestFact, SourceAdapter } from "./types.js";

export type { PullRequestFact, SourceAdapter } from "./types.js";

const DEFAULT_PATH = fileURLToPath(new URL("../../../fixtures/prs.json", import.meta.url));

export function fixturesAdapter(path: string = DEFAULT_PATH): SourceAdapter {
  return {
    async listMerged(): Promise<PullRequestFact[]> {
      return JSON.parse(await readFile(path, "utf8")) as PullRequestFact[];
    },
  };
}
