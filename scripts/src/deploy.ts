import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { accountFor, saveKey } from "./accounts.js";
import { BOND, BUILT_WASM_PATH, TGAS, accessKeysOf, call, isMain, loadState, near, resolveWasmPath, saveState, setEnv, waitFor, type State } from "./chain.js";

/**
 * Creates steward.<member 2>, deploys the mandate, calls `new`, then deletes the account's only
 * (full-access) key and asserts the account has no keys left.
 */
export async function deployMandate(state: State, log: (s: string) => void = console.log): Promise<{ hashes: Record<string, string> }> {
  const wasmPath = resolveWasmPath();
  if (!existsSync(wasmPath)) {
    throw new Error(`mandate wasm not found at ${wasmPath}. Build it: cd contracts/mandate && cargo near build non-reproducible-wasm`);
  }
  log(`  wasm: ${wasmPath === BUILT_WASM_PATH ? "local build" : "committed prebuilt"} (${wasmPath})`);
  const owner = state.members[1]!;
  const id = `steward.${owner}`;
  const kp = KeyPair.fromRandom("ed25519");
  const hashes: Record<string, string> = {};
  const created = await accountFor(owner).createSubAccount({
    accountOrPrefix: "steward",
    publicKey: kp.getPublicKey().toString(),
    nearToTransfer: near("3.5"),
  });
  hashes.createAccount = created.transaction.hash;
  saveKey(id, kp); // kept only until the key is deleted below
  const mandate = accountFor(id, kp);
  const pk = kp.getPublicKey().toString();
  await waitFor("new account key to be visible", async () => (await accessKeysOf(id)).includes(pk), 60_000, 2000);
  hashes.deploy = (await mandate.deployContract(readFileSync(wasmPath))).transaction.hash;
  hashes.init = (await call(mandate, id, "new", { dao_id: state.daoId, proposal_bond: BOND.toString() }, { gas: 100n * TGAS })).hash;
  hashes.deleteKey = (await mandate.deleteKey(kp.getPublicKey().toString())).transaction.hash;
  const keys = await waitFor("mandate key list", async () => ((await accessKeysOf(id)).length === 0 ? [] : undefined), 30_000).catch(() => accessKeysOf(id));
  if (keys.length !== 0) throw new Error(`mandate still has access keys after deleteKey: ${keys.join(", ")}`);
  rmSync(join(homedir(), ".near-credentials", "testnet", `${id}.json`), { force: true });
  state.mandateId = id;
  setEnv({ MANDATE_ID: id });
  log(`  mandate: ${id}, access keys: []`);
  return { hashes };
}

if (isMain(import.meta.url)) {
  const state = loadState();
  deployMandate(state)
    .then(() => saveState(state))
    .catch((e) => {
      console.error(`deploy failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
