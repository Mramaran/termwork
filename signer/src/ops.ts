import { Account, KeyPairSigner, JsonRpcProvider } from "near-api-js";

/** Thrown for any malformed request. The server maps it to HTTP 400. */
export class ValidationError extends Error {}

/** The slice of near-api-js Account the signer uses. Everything is called on the mandate, by the mandate. */
export type AccountLike = Pick<Account, "accountId" | "callFunctionRaw">;

export interface TxResult {
  txHash: string;
}

export interface Ops {
  spend(args: unknown): Promise<TxResult>;
  request_spend(args: unknown): Promise<TxResult>;
  log_work(args: unknown): Promise<TxResult>;
  propose_renewal(args: unknown): Promise<TxResult>;
  expire(args: unknown): Promise<TxResult>;
}

export type OpName = keyof Ops;

const TGAS = 10n ** 12n;
/** Explicit gas is mandatory: the default prepay exceeds the agent key's 0.25 NEAR allowance. */
const GAS: Record<OpName, bigint> = {
  spend: 30n * TGAS,
  request_spend: 100n * TGAS,
  log_work: 30n * TGAS,
  propose_renewal: 100n * TGAS,
  expire: 30n * TGAS,
};

const U128_MAX = (1n << 128n) - 1n;
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
// MAX_REPORT_BYTES mirrors the contract. The other limits are signer-side hardening, not contract rules:
// summary/rationale 2048 bytes, URL 2048 chars, receipt hash 128 chars.
const MAX_REPORT_BYTES = 4096;
const MAX_TEXT_BYTES = 2048;
const MAX_URL_CHARS = 2048;
const MAX_HASH_CHARS = 128;

function obj(args: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ValidationError("body must be a JSON object");
  }
  const rec = args as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (!allowed.includes(k)) throw new ValidationError(`unknown field: ${k.slice(0, 40)}`);
  }
  return rec;
}

function accountId(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length < 2 || v.length > 64 || !ACCOUNT_RE.test(v)) {
    throw new ValidationError(`${field} is not a valid NEAR account id`);
  }
  return v;
}

function yocto(v: unknown, field: string, allowZero = false): string {
  if (typeof v !== "string" || !/^(0|[1-9]\d*)$/.test(v)) {
    throw new ValidationError(`${field} must be a decimal integer string (yoctoNEAR)`);
  }
  const n = BigInt(v);
  if (n > U128_MAX) throw new ValidationError(`${field} exceeds u128`);
  if (n === 0n && !allowZero) throw new ValidationError(`${field} must be greater than zero`);
  return v;
}

function clauseId(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) {
    throw new ValidationError("clause_id must be an integer 0-255");
  }
  return v;
}

function httpsUrl(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_URL_CHARS) {
    throw new ValidationError(`${field} must be an https url`);
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ValidationError(`${field} must be an https url`);
  }
  if (u.protocol !== "https:" || !u.hostname) throw new ValidationError(`${field} must be an https url`);
  return v;
}

function text(v: unknown, field: string, maxBytes: number): string {
  if (typeof v !== "string" || v.length === 0) throw new ValidationError(`${field} must be a non-empty string`);
  if (Buffer.byteLength(v, "utf8") > maxBytes) throw new ValidationError(`${field} exceeds ${maxBytes} bytes`);
  return v;
}

function hash(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_HASH_CHARS) {
    throw new ValidationError(`${field} must be a string of 1-${MAX_HASH_CHARS} characters`);
  }
  return v;
}

function optional<T>(v: unknown, f: (x: unknown) => T): T | null {
  return v === undefined || v === null ? null : f(v);
}

function parseSpend(args: unknown) {
  const a = obj(args, ["recipient", "amount", "clause_id", "evidence_url", "receipt_hash"]);
  return {
    recipient: accountId(a.recipient, "recipient"),
    amount: yocto(a.amount, "amount"),
    clause_id: clauseId(a.clause_id),
    evidence_url: httpsUrl(a.evidence_url, "evidence_url"),
    receipt_hash: hash(a.receipt_hash, "receipt_hash"),
  };
}

function parseRequestSpend(args: unknown) {
  const a = obj(args, ["recipient", "amount", "clause_id", "evidence_url", "receipt_hash", "rationale"]);
  return {
    recipient: accountId(a.recipient, "recipient"),
    amount: yocto(a.amount, "amount"),
    clause_id: clauseId(a.clause_id),
    evidence_url: httpsUrl(a.evidence_url, "evidence_url"),
    receipt_hash: hash(a.receipt_hash, "receipt_hash"),
    rationale: text(a.rationale, "rationale", MAX_TEXT_BYTES),
  };
}

function parseLogWork(args: unknown) {
  const a = obj(args, ["clause_id", "summary", "evidence_url", "receipt_hash"]);
  return {
    clause_id: clauseId(a.clause_id),
    summary: text(a.summary, "summary", MAX_TEXT_BYTES),
    evidence_url: optional(a.evidence_url, (x) => httpsUrl(x, "evidence_url")),
    receipt_hash: optional(a.receipt_hash, (x) => hash(x, "receipt_hash")),
  };
}

function parseRenewal(args: unknown) {
  const a = obj(args, ["report_text", "requested_term_secs", "requested_topup"]);
  const secs = a.requested_term_secs;
  if (typeof secs !== "number" || !Number.isSafeInteger(secs) || secs <= 0) {
    throw new ValidationError("requested_term_secs must be a positive integer");
  }
  return {
    report_text: text(a.report_text, "report_text", MAX_REPORT_BYTES),
    requested_term_secs: secs,
    requested_topup: yocto(a.requested_topup, "requested_topup", true),
  };
}

function parseExpire(args: unknown) {
  obj(args ?? {}, []);
  return {};
}

const PARSERS: Record<OpName, (args: unknown) => Record<string, unknown>> = {
  spend: parseSpend,
  request_spend: parseRequestSpend,
  log_work: parseLogWork,
  propose_renewal: parseRenewal,
  expire: parseExpire,
};

/**
 * Builds one function per mandate agent method. Pass a factory to get a fresh Account (and therefore a
 * fresh nonce lookup) for every transaction: near-api-js caches nonces per Account, and a renewal
 * re-adds the agent key with a reset nonce, which would make a cached nonce invalid.
 */
export function buildOps(account: AccountLike | (() => AccountLike)): Ops {
  const get = typeof account === "function" ? account : () => account;
  // Fresh Accounts share no nonce lock, so concurrent sends would read the same nonce. Run one
  // transaction at a time; each still re-fetches its nonce (it starts after the previous one resolved).
  let tail: Promise<unknown> = Promise.resolve();
  const serialise = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
  const make = (name: OpName) => async (args: unknown): Promise<TxResult> => {
    const parsed = PARSERS[name](args);
    return serialise(async () => {
      const acct = get();
      const outcome = await acct.callFunctionRaw({
        contractId: acct.accountId,
        methodName: name,
        args: parsed,
        gas: GAS[name],
        deposit: 0n,
      });
      return { txHash: outcome.transaction.hash };
    });
  };
  return {
    spend: make("spend"),
    request_spend: make("request_spend"),
    log_work: make("log_work"),
    propose_renewal: make("propose_renewal"),
    expire: make("expire"),
  };
}

/** Production wiring: a new Account per call, signed with the agent's function-call key. */
export function accountFactory(opts: { mandateId: string; privateKey: string; rpcUrl: string }): () => Account {
  const signer = KeyPairSigner.fromSecretKey(opts.privateKey as `ed25519:${string}`);
  const provider = new JsonRpcProvider({ url: opts.rpcUrl });
  return () => new Account(opts.mandateId, provider, signer);
}
