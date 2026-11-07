import type { LogEntry, MandateView, SpendRequest } from "@termwork/shared";

/** Server-side NEAR JSON-RPC helpers (fetch based). */
export interface NearDeps {
  rpcUrl: string;
  fetchFn?: typeof fetch;
}

/** The parts of an EXPERIMENTAL_tx_status result the server reads. */
export interface TxStatus {
  status: { SuccessValue: string } | { SuccessReceiptId: string } | { Failure: unknown } | "NotStarted" | "Started";
  transaction: {
    signer_id: string;
    receiver_id: string;
    actions: Array<{ FunctionCall: { method_name: string; args: string } } | string | Record<string, unknown>>;
  };
}

type RpcError = { message?: string; data?: unknown; cause?: { name?: string } };
let rpcId = 0;

async function rpc<T>(d: NearDeps, method: string, params: unknown): Promise<T> {
  const res = await (d.fetchFn ?? fetch)(d.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: RpcError };
  if (json.error) {
    const e = json.error;
    throw new Error(`${e.cause?.name ?? ""} ${e.message ?? ""} ${typeof e.data === "string" ? e.data : ""}`.trim());
  }
  return json.result as T;
}

export async function rpcView<T>(d: NearDeps, account: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>(d, "query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (r.error) throw new Error(r.error);
  return JSON.parse(Buffer.from(r.result ?? []).toString("utf8")) as T;
}

export async function accountExists(d: NearDeps, id: string): Promise<boolean> {
  try {
    await rpc(d, "query", { request_type: "view_account", finality: "optimistic", account_id: id });
    return true;
  } catch (e) {
    if (/UNKNOWN_ACCOUNT|does not exist/i.test((e as Error).message)) return false;
    throw e;
  }
}

export const getMandate = (d: NearDeps, mandateId: string): Promise<MandateView> => rpcView<MandateView>(d, mandateId, "get_mandate");

export const getRequests = (d: NearDeps, mandateId: string): Promise<SpendRequest[]> =>
  rpcView<SpendRequest[]>(d, mandateId, "get_requests");

const PAGE = 100;

/** The whole work log, read 100 entries at a time. */
export async function getWorkLog(d: NearDeps, mandateId: string): Promise<LogEntry[]> {
  const all: LogEntry[] = [];
  for (;;) {
    const page = await rpcView<LogEntry[]>(d, mandateId, "get_work_log", { from: all.length, limit: PAGE });
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/** Council members from the Sputnik policy (Group roles). */
export async function councilMembers(d: NearDeps, daoId: string): Promise<string[]> {
  const p = await rpcView<{ roles: { kind: unknown }[] }>(d, daoId, "get_policy");
  return p.roles.flatMap((r) => (r.kind && typeof r.kind === "object" && "Group" in r.kind ? (r.kind as { Group: string[] }).Group : []));
}

export const txStatus = (d: NearDeps, hash: string, sender: string): Promise<TxStatus> =>
  rpc<TxStatus>(d, "EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
