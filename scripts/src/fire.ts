import { TGAS, accessKeysOf, balanceOf, call, fmtNear, isMain, loadState, sleep, view, waitFor, type State } from "./chain.js";
import { decide, propose } from "./dao.js";

export async function sweep(state: State, caller: string = state.members[2]!): Promise<string> {
  return (await call(caller, state.mandateId!, "sweep", {}, { gas: 100n * TGAS })).hash;
}

/** Proposes `fire`, approves it with 2 council votes, waits for status Fired and an empty key list. */
export async function fireAgent(state: State, reason: string, log: (s: string) => void = console.log) {
  const mandate = state.mandateId!;
  const p = await propose(state, state.members[0]!, "Fire the agent", mandate, "fire", { reason });
  const d = await decide(state, p.id, true);
  await waitFor("status Fired", async () => (await view<string>(mandate, "get_status")) === "Fired", 45_000);
  const keys = await waitFor("empty key list", async () => ((await accessKeysOf(mandate)).length === 0 ? [] : undefined), 30_000);
  log(`  fired: proposal ${p.id}, access keys: ${JSON.stringify(keys)}`);
  return { proposalId: p.id, proposeHash: p.hash, voteHashes: d.hashes };
}

if (isMain(import.meta.url)) {
  const state = loadState();
  (async () => {
    const before = await balanceOf(state.daoId);
    await fireAgent(state, "fired from the command line");
    await sweep(state);
    await sleep(5000);
    console.log(`returned to DAO: ${fmtNear((await balanceOf(state.daoId)) - before)} NEAR`);
  })().catch((e) => {
    console.error(`fire failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
