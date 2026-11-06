import { KeyPair } from "near-api-js";
import { DEMO_MAX_REQUEST, DEMO_MISSION, DEMO_SPEND_THRESHOLD } from "@termwork/shared";
import { ONE_NEAR, isMain, loadState, saveState, setEnv, view, waitFor, type State } from "./chain.js";
import { decide, propose } from "./dao.js";

/** Generates the agent keypair (written to .env as AGENT_PRIVATE_KEY, never printed), proposes `hire` and approves it with 2 council votes. */
export async function hireAgent(state: State, termSecs: number, log: (s: string) => void = console.log) {
  if (!state.mandateId) throw new Error("no mandate deployed; run deploy first");
  const kp = KeyPair.fromRandom("ed25519");
  setEnv({ AGENT_PRIVATE_KEY: kp.toString() });
  state.agentPublicKey = kp.getPublicKey().toString();
  const args = {
    mission: DEMO_MISSION,
    spend_threshold: DEMO_SPEND_THRESHOLD,
    max_request: DEMO_MAX_REQUEST,
    term_secs: termSecs,
    agent_public_key: state.agentPublicKey,
  };
  const p = await propose(state, state.members[0]!, "Hire the Contributor Rewards Steward", state.mandateId, "hire", args, 2n * ONE_NEAR);
  const d = await decide(state, p.id, true);
  const mandate = await waitFor("mandate Active", async () => {
    const m = await view<{ status: string; term_end_ms: number }>(state.mandateId!, "get_mandate");
    return m.status === "Active" ? m : undefined;
  }, 45_000);
  log(`  hired: proposal ${p.id} approved, term ${termSecs}s`);
  return { agentKey: kp, proposalId: p.id, proposeHash: p.hash, voteHashes: d.hashes, termEndMs: mandate.term_end_ms };
}

if (isMain(import.meta.url)) {
  const i = process.argv.indexOf("--term");
  const term = i >= 0 ? Number(process.argv[i + 1]) : 300;
  if (!Number.isInteger(term) || term <= 0) {
    console.error("usage: hire --term <seconds>");
    process.exit(1);
  }
  const state = loadState();
  hireAgent(state, term)
    .then(() => saveState(state))
    .catch((e) => {
      console.error(`hire failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
