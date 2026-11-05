import { JsonRpcProvider, nearToYocto as nearApiNearToYocto } from "near-api-js";
import { loadConfig } from "./config.js";

let cached: { network: string; provider: JsonRpcProvider } | undefined;

export function getProvider(): JsonRpcProvider {
  const { NEAR_NETWORK, NEAR_RPC_URL } = loadConfig();
  if (!cached || cached.network !== NEAR_NETWORK) {
    const url = NEAR_RPC_URL;
    cached = { network: NEAR_NETWORK, provider: new JsonRpcProvider({ url }) };
  }
  return cached.provider;
}

async function view<T>(contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  if (!contractId) throw new Error(`cannot call ${method}: contract id is not configured`);
  const res = await getProvider().callFunction<any>({ contractId, method, args });
  return res as T;
}

export function viewMandate<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return view<T>(loadConfig().MANDATE_ID, method, args);
}

export function viewDao<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return view<T>(loadConfig().DAO_ID, method, args);
}

/** Public keys (ed25519:...) currently on the account. */
export async function accessKeys(accountId: string): Promise<string[]> {
  const list = await getProvider().viewAccessKeyList({ accountId, finalityQuery: { finality: "optimistic" } });
  return list.keys.map((k) => k.public_key);
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await getProvider().viewAccount({ accountId, blockQuery: { finality: "optimistic" } });
    return true;
  } catch (e) {
    const msg = String((e as { type?: string })?.type ?? "") + String((e as Error)?.message ?? "");
    if (/AccountDoesNotExist|does not exist|UNKNOWN_ACCOUNT/i.test(msg)) return false;
    throw e;
  }
}

/** Converts a NEAR amount string like "1.5" to a yoctoNEAR decimal string. */
export function nearToYocto(s: string): string {
  return String(nearApiNearToYocto(s as `${number}`));
}
