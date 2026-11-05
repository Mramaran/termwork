import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/** Parses .env text and drops AGENT_PRIVATE_KEY: that key belongs to the signer process only. */
export function parseAgentEnv(text: string): Record<string, string> {
  const parsed = parseEnv(text) as Record<string, string>;
  delete parsed.AGENT_PRIVATE_KEY;
  return parsed;
}

/** Loads a .env file into `target` without AGENT_PRIVATE_KEY and without overriding values already set. A missing file is ignored. */
export function loadAgentEnv(path: string, target: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const [k, v] of Object.entries(parseAgentEnv(text))) if (target[k] === undefined) target[k] = v;
}
