import { loadConfig, requireConfig } from "@termwork/shared";
import { realDeps, tick } from "./loop.js";
import { fixturesAdapter } from "./sources/fixtures.js";
import { githubAdapter } from "./sources/github.js";

const cfg = loadConfig();
requireConfig(cfg, ["MANDATE_ID", "SIGNER_TOKEN"]);
if (cfg.AGENT_MODE === "live") requireConfig(cfg, ["NEARAI_API_KEY", "NEARAI_MODEL"]);
if (cfg.SOURCE === "github") requireConfig(cfg, ["GITHUB_REPO"]);

const source = cfg.SOURCE === "github" ? githubAdapter(cfg.GITHUB_REPO, fetch, cfg.GITHUB_TOKEN) : fixturesAdapter();
const deps = realDeps(cfg, source);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

deps.log(`agent started (mode=${cfg.AGENT_MODE}, source=${cfg.SOURCE}, interval=${cfg.LOOP_INTERVAL_MS}ms)`);
for (;;) {
  try {
    const r = await tick(deps);
    if (r.stopped) {
      deps.log("mandate is no longer active, agent stopped");
      break;
    }
  } catch (e) {
    deps.log(`tick failed: ${(e as Error).message}`);
  }
  await sleep(cfg.LOOP_INTERVAL_MS);
}
