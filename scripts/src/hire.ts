import { KeyPair } from "near-api-js";
import { ONE_NEAR, isMain, loadState, near, saveState, setEnv, view, waitFor, type State } from "./chain.js";
import { decide, propose } from "./dao.js";

export const DEMO_MISSION = {
  title: "Contributor Rewards Steward",
  clauses: [
    { id: 1, text: "Reward first-time contributors whose pull requests are merged into the repo, within 48 hours of the merge.", max_amount: near("0.5").toString(), pays: true },
    { id: 2, text: "Standard reward: 0.2 NEAR per qualifying pull request.", max_amount: near("0.2").toString(), pays: true },
    {
      id: 3,
      text: "A larger pull request (a `feature` label, or more than 200 changed lines) deserves 0.5 NEAR. Because that is over the spend threshold, it goes to a DAO vote instead of being paid directly.",
      max_amount: near("0.5").toString(),
      pays: true,
    },
    { id: 4, text: "Never pay a pull request twice, or one without a NEAR account given in its body.", max_amount: null, pays: false },
  ],
};

/** Generates the agent keypair (written to .env as AGENT_PRIVATE_KEY, never printed), proposes `hire` and approves it with 2 council votes. */
export async function hireAgent(state: State, termSecs: number, log: (s: string) => void = console.log) {
  if (!state.mandateId) throw new Error("no mandate deployed; run deploy first");
  const kp = KeyPair.fromRandom("ed25519");
  setEnv({ AGENT_PRIVATE_KEY: kp.toString() });
  state.agentPublicKey = kp.getPublicKey().toString();
  const args = {
    mission: DEMO_MISSION,
    spend_threshold: near("0.2").toString(),
    max_request: near("0.5").toString(),
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
