import { DEMO_MAX_REQUEST, DEMO_MISSION, DEMO_SPEND_THRESHOLD, nearToYocto, type MandateView } from "@termwork/shared";
import { complete } from "../../agent/src/nearai";
import { decisionMessages } from "../../agent/src/prompts";
import { parseDecision, validate, type Decision } from "../../agent/src/validate";
import { checkLimit } from "./limits";

export interface DecideDeps {
  complete: typeof complete;
  now: () => number;
  /** Secret strings scrubbed from every response. */
  secrets?: string[];
  /** NEAR AI credentials, supplied by the default export from process.env. */
  apiKey?: string;
  model?: string;
}
export interface HandleReq {
  method: string;
  body: string;
  ip: string;
  /** Set by the Node handler when the body exceeded the limit and was not buffered. */
  oversized?: boolean;
}
export interface HandleRes {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const MAX_BODY = 2048;
const NEAR_RE = /^(?=.{2,64}$)([a-z\d]+([-_][a-z\d]+)*\.)*[a-z\d]+([-_][a-z\d]+)*$/;
const FIELDS = new Set(["title", "changedLines", "feature", "firstTime", "nearAccount"]);

type Input = { title: string; changedLines: number; feature: boolean; firstTime: boolean; nearAccount: string | null };

function parseInput(body: string): Input | { error: string; field: string } {
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    return { error: "body must be valid JSON", field: "body" };
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return { error: "body must be a JSON object", field: "body" };
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!FIELDS.has(k)) return { error: `unknown field: ${k}`, field: k };
  if (typeof r.title !== "string" || r.title.length < 1 || r.title.length > 200)
    return { error: "title must be 1 to 200 characters", field: "title" };
  if (typeof r.changedLines !== "number" || !Number.isInteger(r.changedLines) || r.changedLines < 0 || r.changedLines > 100000)
    return { error: "changedLines must be an integer from 0 to 100000", field: "changedLines" };
  if (typeof r.feature !== "boolean") return { error: "feature must be true or false", field: "feature" };
  if (typeof r.firstTime !== "boolean") return { error: "firstTime must be true or false", field: "firstTime" };
  let nearAccount: string | null = null;
  if (r.nearAccount !== undefined && r.nearAccount !== "") {
    if (typeof r.nearAccount !== "string" || !NEAR_RE.test(r.nearAccount))
      return { error: "nearAccount is not a valid NEAR account id", field: "nearAccount" };
    nearAccount = r.nearAccount;
  }
  return { title: r.title, changedLines: r.changedLines, feature: r.feature, firstTime: r.firstTime, nearAccount };
}

function yoctoToNear(y: string): string {
  const s = y.padStart(25, "0");
  const whole = s.slice(0, -24);
  const frac = s.slice(-24).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Rules in the order validate() applies them, stopping at the first failure. Computed only from the parsed
 * answer, the request input and the demo mandate; never from validate's free-text summary.
 */
function rulesFor(answer: Decision | { error: string }, input: Input): { rule: string; pass: boolean; note?: string }[] {
  const out: { rule: string; pass: boolean; note?: string }[] = [];
  const stop = (rule: string, pass: boolean) => {
    out.push({ rule, pass });
    return !pass;
  };
  const d = "error" in answer ? null : answer;
  if (stop("decision well-formed", d !== null && /^\d+(\.\d{1,24})?$/.test(d.amount_near))) return out;
  if (!d) return out;
  if (stop("model says it qualifies", d.qualifies)) return out;
  if (stop("first-time contributor", input.firstTime)) return out;
  if (stop("has NEAR account", input.nearAccount !== null)) return out;
  const clause = DEMO_MISSION.clauses.find((c) => c.id === d.clause_id);
  const amount = BigInt(nearToYocto(d.amount_near));
  const withinClause = !!clause && clause.pays && amount > 0n && (clause.max_amount === null || amount <= BigInt(clause.max_amount));
  if (stop("amount above zero and within the clause maximum", withinClause)) return out;
  if (stop("amount within the maximum single request", amount <= BigInt(DEMO_MAX_REQUEST))) return out;
  out.push({ rule: "recipient exists on-chain", pass: true, note: "skipped in the playground" });
  return out;
}

function scrub(res: HandleRes, secrets: string[]): HandleRes {
  const live = secrets.filter((s) => s.length > 0);
  if (!live.length) return res;
  let text = JSON.stringify(res.json);
  for (const s of live) text = text.split(s).join("[redacted]").split(JSON.stringify(s).slice(1, -1)).join("[redacted]");
  return { ...res, json: JSON.parse(text) };
}

async function run(req: HandleReq, deps: DecideDeps): Promise<HandleRes> {
  if (req.method !== "POST") return { status: 405, json: { error: "use POST" }, headers: { Allow: "POST" } };
  if (req.oversized || new TextEncoder().encode(req.body).length > MAX_BODY) return { status: 413, json: { error: "request body too large (max 2048 bytes)" } };
  if (!deps.apiKey || !deps.model)
    return { status: 503, json: { error: "The live AI demo isn't configured on this deployment." } };
  const input = parseInput(req.body);
  if ("error" in input) return { status: 400, json: input };

  const lim = checkLimit(req.ip, deps.now());
  if (!lim.ok) return { status: 429, json: { error: "too many requests, slow down", retryAfterSec: lim.retryAfterSec } };

  const mandate: MandateView = {
    dao_id: "playground",
    mission: DEMO_MISSION,
    status: "Active",
    spend_threshold: DEMO_SPEND_THRESHOLD,
    max_request: DEMO_MAX_REQUEST,
    term_start_ms: 0,
    term_end_ms: 0,
    term_number: 1,
    agent_key: null,
    budget_total: "0",
    budget_spent: "0",
    budget_available: "0",
  };
  const pr = {
    url: "https://github.com/termwork/playground/pull/1",
    number: 1,
    title: input.title,
    author: "playground",
    firstTime: input.firstTime,
    changedLines: input.changedLines,
    labels: input.feature ? ["feature"] : [],
    mergedAt: new Date(deps.now()).toISOString(),
    nearAccount: input.nearAccount,
  };

  const key = deps.apiKey ?? "";
  let out: Awaited<ReturnType<typeof complete>>;
  try {
    out = await deps.complete(decisionMessages(mandate, pr), key, { model: deps.model });
  } catch {
    return { status: 502, json: { error: "The AI request failed. Try again in a minute." } };
  }
  const answer = parseDecision(out.text);
  const action = await validate(answer, pr, mandate, new Set(), async () => true);
  const result = action.kind === "spend" ? "would pay" : action.kind === "request" ? "would go to a DAO vote" : "would skip";
  const amountNear = action.kind === "log" ? "0" : yoctoToNear(action.amountYocto);
  return {
    status: 200,
    json: { answer, rules: rulesFor(answer, input), result, amountNear, receipt: out.receipt, receiptHash: out.hash },
  };
}

export async function handle(req: HandleReq, deps: DecideDeps): Promise<HandleRes> {
  return scrub(await run(req, deps), deps.secrets ?? []);
}

/** Buffers up to the limit; beyond it, keeps draining (discarding) so the connection is not reset. */
async function readBody(req: AsyncIterable<Buffer | string>): Promise<{ body: string; oversized: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    size += b.length;
    if (size > 1_000_000) break;
    if (size <= MAX_BODY) chunks.push(b);
  }
  return size > MAX_BODY ? { body: "", oversized: true } : { body: Buffer.concat(chunks).toString("utf8"), oversized: false };
}

/** Vercel Node handler. */
export default async function handler(
  req: { method?: string; headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } } & AsyncIterable<Buffer | string>,
  res: { statusCode: number; setHeader(k: string, v: string): void; end(s: string): void },
): Promise<void> {
  const h = (k: string) => {
    const v = req.headers[k];
    return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() || undefined;
  };
  const ip = h("x-vercel-forwarded-for") || h("x-real-ip") || h("x-forwarded-for") || req.socket?.remoteAddress || "unknown";
  const apiKey = process.env.NEARAI_API_KEY ?? "";
  const { body, oversized } = req.method === "POST" ? await readBody(req) : { body: "", oversized: false };
  const r = await handle({ method: req.method ?? "GET", body, ip, oversized }, {
    complete,
    now: () => Date.now(),
    secrets: [apiKey],
    apiKey,
    model: process.env.NEARAI_MODEL ?? "",
  });
  res.statusCode = r.status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
  if (r.status === 413) res.setHeader("connection", "close");
  res.end(JSON.stringify(r.json));
}
