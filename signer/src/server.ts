import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, requireConfig } from "@termwork/shared";
import { accountFactory, buildOps, OutcomeUnknownError, ValidationError, type OpName, type Ops } from "./ops.js";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const ROUTES: OpName[] = ["spend", "request_spend", "log_work", "propose_renewal", "expire"];

export interface SignerServerOptions {
  token: string;
  /** Extra strings (e.g. the private key) scrubbed from any error text before it leaves the process. */
  secrets?: string[];
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time comparison of the presented bearer token against the configured one. */
function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  const presented = m?.[1] ?? "";
  const ok = timingSafeEqual(digest(presented), digest(token));
  return ok && presented.length > 0;
}

export function makeRedactor(secrets: string[]) {
  const needles = new Set<string>();
  for (const s of secrets) {
    if (!s) continue;
    needles.add(s);
    const stripped = s.replace(/^[a-z0-9]+:/i, "");
    if (stripped.length >= 8) needles.add(stripped);
  }
  return (msg: string): string => {
    let out = msg;
    for (const n of needles) out = out.split(n).join("[redacted]");
    return out.replace(/(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,}/g, "[redacted]");
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new ValidationError("body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("body is not valid JSON");
  }
}

export function createSignerServer(ops: Ops, opts: SignerServerOptions): http.Server {
  if (!opts.token) throw new Error("SIGNER_TOKEN is required");
  const redact = makeRedactor([...(opts.secrets ?? []), opts.token]);

  return http.createServer(async (req, res) => {
    try {
      // Auth first, so unauthenticated callers learn nothing about which routes exist.
      if (!tokenOk(req.headers.authorization, opts.token)) {
        return send(res, 401, { error: "unauthorized" });
      }
      const path = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
      if (!(ROUTES as string[]).includes(path)) return send(res, 404, { error: "not found" });
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

      const body = await readJson(req);
      try {
        const { txHash } = await ops[path as OpName](body);
        console.log(`[signer] ${path} ok tx=${txHash}`);
        return send(res, 200, { txHash });
      } catch (e) {
        if (e instanceof OutcomeUnknownError) {
          console.error(`[signer] ${path} outcome unknown (timeout)`);
          return send(res, 504, { error: "outcome unknown — check chain before retrying" });
        }
        if (e instanceof ValidationError) {
          return send(res, 400, { error: redact(e.message) });
        }
        const rpcError = redact(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ");
        console.error(`[signer] ${path} chain error: ${rpcError.slice(0, 300)}`);
        return send(res, 502, { error: "chain call failed", rpcError });
      }
    } catch (e) {
      const status = (e as { status?: number }).status ?? (e instanceof ValidationError ? 400 : 500);
      send(res, status, { error: status === 500 ? "internal error" : redact((e as Error).message) });
    }
  });
}

/** Listens on loopback only. There is deliberately no host parameter. */
export function listenLocal(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.();
  } catch {
    // no .env file; environment only
  }
  const cfg = loadConfig();
  requireConfig(cfg, ["MANDATE_ID", "AGENT_PRIVATE_KEY", "SIGNER_TOKEN"]);
  const port = Number(new URL(cfg.SIGNER_URL).port || 8787);
  const factory = accountFactory({
    mandateId: cfg.MANDATE_ID,
    privateKey: cfg.AGENT_PRIVATE_KEY,
    rpcUrl: cfg.NEAR_RPC_URL,
  });
  const server = createSignerServer(buildOps(factory), {
    token: cfg.SIGNER_TOKEN,
    secrets: [cfg.AGENT_PRIVATE_KEY],
  });
  await listenLocal(server, port);
  console.log(`[signer] listening on http://${HOST}:${port} for ${cfg.MANDATE_ID}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    const redact = makeRedactor([process.env.AGENT_PRIVATE_KEY ?? "", process.env.SIGNER_TOKEN ?? ""]);
    const msg = redact(e instanceof Error ? e.message : "unknown error").replace(/\s+/g, " ");
    console.error(`[signer] failed to start: ${msg}`);
    process.exit(1);
  });
}
