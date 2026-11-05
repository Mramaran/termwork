import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";

export const TESTNET_RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
// helper.testnet.near.org is retired; this is the faucet endpoint near-cli-rs uses today.
export const FAUCET_URL = process.env.NEAR_FAUCET_URL ?? "https://helper.nearprotocol.com/account";

const credDir = () => join(homedir(), ".near-credentials", "testnet");

export function provider(): JsonRpcProvider {
  return new JsonRpcProvider({ url: TESTNET_RPC });
}

function saveKey(id: string, kp: KeyPair): void {
  mkdirSync(credDir(), { recursive: true });
  writeFileSync(
    join(credDir(), `${id}.json`),
    JSON.stringify(
      {
        account_id: id,
        public_key: kp.getPublicKey().toString(),
        private_key: kp.toString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

export function loadKey(id: string): KeyPair {
  const f = JSON.parse(readFileSync(join(credDir(), `${id}.json`), "utf8"));
  return KeyPair.fromString(f.private_key as KeyPairString);
}

export function accountFor(id: string, kp: KeyPair = loadKey(id)): Account {
  return new Account(id, provider(), kp.toString() as KeyPairString);
}

/** Creates `id` on testnet through the faucet (funded with 10 NEAR) and stores its key under ~/.near-credentials/testnet/. */
export async function createFundedTestnetAccount(id: string): Promise<KeyPair> {
  const kp = KeyPair.fromRandom("ed25519");
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) {
    throw new Error(`faucet failed for ${id}: HTTP ${res.status} ${await res.text()}`);
  }
  saveKey(id, kp);
  return kp;
}
