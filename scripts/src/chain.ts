import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Account } from "near-api-js";
import { accountFor, provider } from "./accounts.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ONE_NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const FACTORY = "sputnikv2.testnet";
export const BOND = ONE_NEAR / 10n; // 0.1 NEAR
/** Fresh build from source (cargo near build); preferred when present. */
export const BUILT_WASM_PATH = join(ROOT, "contracts", "mandate", "target", "near", "termwork_mandate.wasm");
/** Prebuilt wasm committed for judges without a Rust toolchain; see contracts/mandate/res/README.md. */
export const PREBUILT_WASM_PATH = join(ROOT, "contracts", "mandate", "res", "termwork_mandate.wasm");
/** The wasm deploy uses: the local build if it exists, else the committed one. */
export function resolveWasmPath(): string {
  return existsSync(BUILT_WASM_PATH) ? BUILT_WASM_PATH : PREBUILT_WASM_PATH;
}
export const STATE_PATH = join(ROOT, ".termwork-state.json");
export const ENV_PATH = join(ROOT, ".env");

export const near = (s: string): bigint => {
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * ONE_NEAR + BigInt(f.padEnd(24, "0").slice(0, 24));
};
export const fmtNear = (y: bigint, digits = 3): string => {
  const neg = y < 0n;
  const v = neg ? -y : y;
  const frac = (v % ONE_NEAR).toString().padStart(24, "0").slice(0, digits);
  return `${neg ? "-" : ""}${v / ONE_NEAR}.${frac}`;
};
export const explorerTx = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = (id: string): string => `https://testnet.nearblocks.io/address/${id}`;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Account ids and role names for a testnet run. Holds no secrets: keys live in ~/.near-credentials and .env. */
export interface State {
  suffix: string;
  members: string[];
  daoId: string;
  mandateId?: string;
  contributors: Record<string, string>;
  agentPublicKey?: string;
  requestProposalId?: number;
}

export function loadState(): State {
  if (!existsSync(STATE_PATH)) throw new Error("no .termwork-state.json yet; run `npm run -w scripts setup-dao` first");
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
}
export const saveState = (s: State): void => writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

/** Sets or replaces KEY=value lines in .env, creating the file if needed. Values are never printed. */
export function setEnv(values: Record<string, string>): void {
  let lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  lines = lines.filter((l, i) => l !== "" || i < lines.length - 1);
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
}

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider().callFunction<any>({ contractId, method, args })) as T;
}

export async function balanceOf(id: string): Promise<bigint> {
  const a = await provider().viewAccount({ accountId: id, blockQuery: { finality: "final" } });
  return BigInt(a.amount);
}

export async function accessKeysOf(id: string): Promise<string[]> {
  const l = await provider().viewAccessKeyList({ accountId: id, finalityQuery: { finality: "final" } });
  return l.keys.map((k) => k.public_key);
}

/** Latest block time in ms: the clock the contract compares term_end against. */
export async function chainTimeMs(): Promise<number> {
  const b = await provider().viewBlock({ finality: "optimistic" });
  return Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
}

export interface Sent {
  hash: string;
}

/** Signs and sends a function call from `from`; waits for the transaction outcome and throws if it failed. */
export async function call(
  from: string | Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  opts: { deposit?: bigint; gas?: bigint } = {},
): Promise<Sent> {
  const acct = typeof from === "string" ? accountFor(from) : from;
  // A key created seconds ago may not be visible on the RPC node that answers yet; the transaction was never
  // accepted in that case, so retrying is safe.
  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = await acct.callFunctionRaw({
        contractId,
        methodName,
        args,
        deposit: opts.deposit ?? 0n,
        gas: opts.gas ?? 300n * TGAS,
      });
      return { hash: outcome.transaction.hash };
    } catch (e) {
      if (attempt >= 6 || !/Access key .* does not exist|UnknownAccessKey/i.test((e as Error).message)) throw e;
      await sleep(3000);
    }
  }
}

export async function waitFor<T>(
  label: string,
  fn: () => Promise<T | undefined | false | null>,
  timeoutMs = 90_000,
  everyMs = 2_500,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let lastError = "";
  for (;;) {
    let v: T | undefined | false | null;
    try {
      v = await fn();
    } catch (e) {
      lastError = (e as Error).message; // transient rpc errors: keep polling until the deadline
      v = undefined;
    }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}${lastError ? ` (last error: ${lastError.slice(0, 200)})` : ""}`);
    await sleep(everyMs);
  }
}

/** True when this module is the process entry point (so scripts can export functions and still be CLIs). */
export const isMain = (metaUrl: string): boolean => !!process.argv[1] && fileURLToPath(metaUrl) === resolve(process.argv[1]);
