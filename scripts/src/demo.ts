import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig, type LogEntry, type MandateView, type Renewal, type SpendRequest } from "@termwork/shared";
import { realDeps, tick, type LoopDeps } from "../../agent/src/loop.js";
import { DEFAULT_RECEIPTS_DIR, type InferenceReceipt } from "../../agent/src/receipts.js";
import { checkCitations } from "../../agent/src/report.js";
import { fixturesAdapter } from "../../agent/src/sources/fixtures.js";
import type { SourceAdapter } from "../../agent/src/sources/types.js";
import { accountFactory, buildOps } from "../../signer/src/ops.js";
import { createSignerServer, listenLocal } from "../../signer/src/server.js";
import { FaucetLimitError, TESTNET_RPC, accountFor, provider, saveKey } from "./accounts.js";
import { ROOT, ENV_PATH, accessKeysOf, balanceOf, chainTimeMs, explorerTx, fmtNear, near, saveState, sleep, view, waitFor, type State } from "./chain.js";
import { decide, setupDao } from "./dao.js";
import { deployMandate } from "./deploy.js";
import { fireAgent, sweep } from "./fire.js";
import { hireAgent } from "./hire.js";
import { KeyPair } from "near-api-js";

const TERM_SECS = Number(process.env.DEMO_TERM_SECS ?? 300);
const TICK_MS = Number(process.env.DEMO_TICK_MS ?? 5000);
const OUT_PATH = join(ROOT, "demo-output.json");

const out: {
  startedAt: string;
  mode?: string;
  accounts: Record<string, unknown>;
  proposals: Record<string, number>;
  txs: Record<string, { hash: string; explorer: string }>;
  costs: { step: string; members_near: string; seconds: number }[];
  termEnded?: { explorer: string; rpcError: string };
  agentAttempt?: { result: string; rpcError: string };
  finalAccessKeys?: string[];
  returnedToDaoNear?: string;
  assertions: string[];
} = { startedAt: new Date().toISOString(), accounts: {}, proposals: {}, txs: {}, costs: [], assertions: [] };

function tx(name: string, hash: string): void {
  out.txs[name] = { hash, explorer: explorerTx(hash) };
}
function ok(msg: string): void {
  out.assertions.push(msg);
  console.log(`  PASS ${msg}`);
}
function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`expectation failed: ${msg}`);
  ok(msg);
}

let members: string[] = [];
async function membersTotal(): Promise<bigint> {
  let t = 0n;
  for (const m of members) t += await balanceOf(m);
  return t;
}
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n== ${name}`);
  const t0 = Date.now();
  let b0 = members.length ? await membersTotal() : 0n;
  const r = await fn();
  if (b0 === 0n && members.length) b0 = near("10") * BigInt(members.length); // members were created inside this step
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  const spent = members.length && b0 > 0n ? b0 - (await membersTotal()) : 0n;
  out.costs.push({ step: name, members_near: fmtNear(spent), seconds: secs });
  console.log(`  cost: ${fmtNear(spent)} NEAR from the council accounts, ${secs}s`);
  return r;
}

const readLog = async (mandate: string): Promise<LogEntry[]> => {
  const all: LogEntry[] = [];
  for (;;) {
    const page = await view<LogEntry[]>(mandate, "get_work_log", { from: all.length, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
  }
};

async function postSigner(url: string, token: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as { txHash?: string; error?: string; rpcError?: string } };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    /* no .env yet */
  }
  const mode = process.env.AGENT_MODE ?? (process.env.NEARAI_API_KEY ? "live" : "fixture");
  if (mode === "live" && !process.env.NEARAI_MODEL) throw new Error("AGENT_MODE=live needs NEARAI_MODEL (and NEARAI_API_KEY) in .env");
  out.mode = mode;
  console.log(`Termwork end-to-end demo on NEAR testnet (agent mode: ${mode}, term ${TERM_SECS}s)`);
  if (mode === "fixture") console.log("  no NEARAI_API_KEY: decisions come from a deterministic rule table, receipts are labelled fixture-rules, unverified");

  // 1-2. accounts, DAO
  const state: State = await step("1-2. council members (faucet) and the Sputnik DAO", async () => {
    const s = await setupDao();
    members = s.members;
    return s;
  });
  out.accounts = { members: state.members, dao: state.daoId, daoExplorer: `https://testnet.nearblocks.io/address/${state.daoId}` };
  const faucetTotal = BigInt(state.members.length) * near("10");

  // contributors: real testnet accounts so the validator's existence check and payments work
  await step("2b. contributor accounts", async () => {
    const funder = state.members[2]!;
    const fixtureAccounts = [...new Set((await fixturesAdapter().listMerged()).map((p) => p.nearAccount).filter((a): a is string => !!a))];
    for (const fa of fixtureAccounts) {
      const prefix = fa.split(".")[0]!;
      const id = `${prefix}.${funder}`;
      const kp = KeyPair.fromRandom("ed25519");
      await accountFor(funder).createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey().toString(), nearToTransfer: near("0.1") });
      saveKey(id, kp);
      state.contributors[fa] = id;
    }
    console.log(`  ${Object.values(state.contributors).join(", ")}`);
  });
  out.accounts.contributors = state.contributors;

  // 3. mandate
  const dep = await step("3. deploy the mandate and delete its full-access key", () => deployMandate(state));
  const mandateId = state.mandateId!;
  out.accounts.mandate = mandateId;
  out.accounts.mandateExplorer = `https://testnet.nearblocks.io/address/${mandateId}`;
  for (const [k, h] of Object.entries(dep.hashes)) tx(`mandate.${k}`, h);
  must((await accessKeysOf(mandateId)).length === 0, "mandate has no access keys after setup");
  saveState(state);

  // 4. hire
  const hire = await step(`4. propose and vote hire (term ${TERM_SECS}s)`, () => hireAgent(state, TERM_SECS));
  out.proposals.hire = hire.proposalId;
  tx("hire.propose", hire.proposeHash);
  hire.voteHashes.forEach((h, i) => tx(`hire.vote${i + 1}`, h));
  const agentPk = state.agentPublicKey!;
  const keysAfterHire = await accessKeysOf(mandateId);
  must(keysAfterHire.length === 1 && keysAfterHire[0] === agentPk, "agent function-call key is present after hire");
  const termEndMs = hire.termEndMs;
  const mandateView = await view<MandateView>(mandateId, "get_mandate");
  must(mandateView.status === "Active", "mandate is Active");
  const daoBeforeFire = { value: 0n };

  // the signer (in this process, loopback only) and the agent
  const token = randomBytes(24).toString("hex");
  const agentSecret = hire.agentKey.toString();
  const server = createSignerServer(buildOps(accountFactory({ mandateId, privateKey: agentSecret, rpcUrl: TESTNET_RPC })), { token, secrets: [agentSecret] });
  await listenLocal(server, 0);
  const signerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    MANDATE_ID: mandateId,
    DAO_ID: state.daoId,
    SIGNER_URL: signerUrl,
    SIGNER_TOKEN: token,
    AGENT_MODE: mode,
    SOURCE: "fixtures",
    NEAR_RPC_URL: TESTNET_RPC,
    LOOP_INTERVAL_MS: String(TICK_MS),
  });
  const cfg = loadConfig();
  const base = fixturesAdapter();
  const source: SourceAdapter = {
    async listMerged() {
      return (await base.listMerged()).map((p) => ({ ...p, nearAccount: p.nearAccount ? (state.contributors[p.nearAccount] ?? null) : null }));
    },
  };
  const deps: LoopDeps = realDeps(cfg, source);
  const runTicks = async (until: () => Promise<boolean>, label: string, timeoutMs: number): Promise<void> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        const r = await tick(deps);
        if (r.stopped) throw new Error(`agent loop stopped early during ${label}`);
      } catch (e) {
        if ((e as Error).message.startsWith("agent loop stopped")) throw e;
        console.log(`  tick error: ${(e as Error).message}`);
      }
      if (await until()) return;
      if (Date.now() > end) throw new Error(`timed out during ${label}`);
      await sleep(TICK_MS);
    }
  };

  try {
    // 5. agent works the fixtures
    await step("5. agent run on fixtures: payments, one big request, one skip", async () => {
      await runTicks(
        async () => {
          const log = await readLog(mandateId);
          const k = (kind: string) => log.filter((e) => e.kind === kind).length;
          return k("Paid") >= 3 && k("Requested") >= 1 && k("Work") >= 1;
        },
        "fixture run",
        Math.max(60_000, TERM_SECS * 500),
      );
    });
    const log5 = await readLog(mandateId);
    const paid = log5.filter((e) => e.kind === "Paid");
    must(paid.length >= 3, `at least 3 Paid entries on-chain (${paid.length})`);
    must(paid.every((e) => e.recipient && Object.values(state.contributors).includes(e.recipient) && e.receipt_hash), "paid entries name a demo contributor and carry a receipt hash");
    const requested = log5.filter((e) => e.kind === "Requested");
    must(requested.length === 1, "exactly 1 Requested entry (the big reward)");
    must(log5.some((e) => e.kind === "Work" && (e.note ?? "").includes("not a first-time")), "1 skip logged (not a first-time contributor)");
    for (const e of paid) {
      const r = await balanceOf(e.recipient!);
      must(r >= near("0.2"), `payment landed: ${e.recipient} holds ${fmtNear(r)} NEAR`);
    }

    // 6. the DAO votes the big spend down
    const requests = await view<SpendRequest[]>(mandateId, "get_requests");
    const req = requests[0]!;
    must(req.proposal_id !== null, "big-spend request has a DAO proposal id");
    out.proposals.bigSpend = req.proposal_id!;
    const rej = await step("6. DAO votes down the big spend", () => decide(state, req.proposal_id!, false));
    rej.hashes.forEach((h, i) => tx(`bigSpend.reject${i + 1}`, h));
    must(rej.status === "Rejected", "DAO rejected the big-spend proposal");
    const recipientBefore = await balanceOf(req.recipient);
    must(recipientBefore < near("0.5"), "rejected big spend moved no money");

    // 7. renewal case
    await step("7. agent files its renewal case", async () => {
      await runTicks(async () => (await view<Renewal | null>(mandateId, "get_renewal")) !== null, "renewal", TERM_SECS * 1000);
    });
    const renewal = (await view<Renewal | null>(mandateId, "get_renewal"))!;
    const log7 = await readLog(mandateId);
    must(renewal.report_text.length > 0 && renewal.proposal_id !== null, "renewal proposal filed with the report stored on-chain");
    out.proposals.renewal = renewal.proposal_id!;
    must(checkCitations(renewal.report_text, new Set(log7.map((e) => e.index))).ok, "every [#n] citation in the report points at a real log entry");
    const renewalTx = log7.find((e) => e.kind === "RenewalProposed");
    must(renewalTx !== undefined, "RenewalProposed entry in the work log");
    must((await chainTimeMs()) < termEndMs, "renewal arrived before the term ended");
    console.log(`  report (${renewal.report_text.length} chars):\n${renewal.report_text.split("\n").map((l) => `    | ${l}`).join("\n")}`);
    out.accounts.renewalReport = renewal.report_text;

    // receipts are honestly labelled
    const idx = JSON.parse(readFileSync(join(DEFAULT_RECEIPTS_DIR, "index.json"), "utf8")) as Record<string, string>;
    const sample = JSON.parse(readFileSync(join(DEFAULT_RECEIPTS_DIR, `${idx[paid[0]!.evidence_url!]}.json`), "utf8")) as InferenceReceipt;
    if (mode === "fixture") must(sample.model === "fixture-rules" && sample.verified === false && sample.verifiedScope === "none", "fixture receipts say model fixture-rules, verified false");
    must(existsSync(join(DEFAULT_RECEIPTS_DIR, `${paid[0]!.receipt_hash}.json`)), "on-chain receipt hash resolves to a stored receipt");
  } finally {
    // the agent loop is just the loops above; nothing keeps running between steps
  }

  // 8. term ends; a late spend lands on-chain and fails with "term ended"
  const late = await step("8. term ends; the agent tries one more payment", async () => {
    await waitFor("the chain clock to pass term end", async () => (await chainTimeMs()) > termEndMs + 3000, TERM_SECS * 1000 + 60_000, 3000);
    const recipient = Object.values(state.contributors)[0]!;
    const evidence = "https://github.com/termwork/demo/pull/99";
    return postSigner(signerUrl, token, "/spend", {
      recipient,
      amount: near("0.1").toString(),
      clause_id: 2,
      evidence_url: evidence,
      receipt_hash: createHash("sha256").update(`late-spend:${evidence}`).digest("hex"),
    });
  });
  must(late.status === 502 && /term ended/i.test(late.json.rpcError ?? ""), "late spend failed on-chain with \"term ended\"");
  must(!!late.json.txHash, "late spend has a transaction hash");
  out.termEnded = { explorer: explorerTx(late.json.txHash!), rpcError: (late.json.rpcError ?? "").slice(0, 300) };
  tx("termEnded.spend", late.json.txHash!);
  must((await view<string>(mandateId, "get_status")) === "Active", "status was still Active when the late spend failed (expire had not run)");

  // 9. fire and sweep
  daoBeforeFire.value = await balanceOf(state.daoId);
  const fire = await step("9. DAO votes fire", () => fireAgent(state, "demo: term ended, not renewing"));
  out.proposals.fire = fire.proposalId;
  tx("fire.propose", fire.proposeHash);
  fire.voteHashes.forEach((h, i) => tx(`fire.vote${i + 1}`, h));
  must((await view<string>(mandateId, "get_status")) === "Fired", "mandate status is Fired");

  await step("10. reject the stale renewal proposal, then sweep", async () => {
    const stale = await decide(state, out.proposals.renewal!, false);
    stale.hashes.forEach((h, i) => tx(`renewal.reject${i + 1}`, h));
    await sleep(6000); // the refunded bond reaches the mandate
    tx("sweep", await sweep(state));
    await sleep(6000);
  });
  const finalKeys = await accessKeysOf(mandateId);
  out.finalAccessKeys = finalKeys;
  must(finalKeys.length === 0, "access key list is empty");
  const acct = await provider().viewAccount({ accountId: mandateId, blockQuery: { finality: "final" } });
  const reserve = BigInt(acct.storage_usage) * 10n ** 19n + near("0.1");
  must(BigInt(acct.amount) <= reserve + near("0.02"), `mandate balance ${fmtNear(BigInt(acct.amount))} NEAR is within storage + buffer (${fmtNear(reserve)})`);
  const daoAfter = await balanceOf(state.daoId);
  const returned = daoAfter - daoBeforeFire.value;
  out.returnedToDaoNear = fmtNear(returned);
  must(returned > 0n, `DAO balance increased (${fmtNear(returned)} NEAR returned)`);
  const requestAfter = (await view<SpendRequest[]>(mandateId, "get_requests"))[0]!;
  must(requestAfter.state === "Cancelled", "the rejected request is Cancelled after the fire");

  // 11. the old key is dead
  const attempt = await step("11. the agent tries again with its old key", () =>
    postSigner(signerUrl, token, "/spend", {
      recipient: Object.values(state.contributors)[0]!,
      amount: near("0.1").toString(),
      clause_id: 2,
      evidence_url: "https://github.com/termwork/demo/pull/100",
      receipt_hash: createHash("sha256").update("after-fire").digest("hex"),
    }),
  );
  const errText = attempt.json.rpcError ?? "";
  const match = /InvalidAccessKey|AccessKeyNotFound|AccessKeyDoesNotExist|does not exist/i.exec(errText);
  must(attempt.status === 502 && match, "agent attempt rejected: deleted key");
  // The RPC reports a deleted key as InvalidAccessKey/AccessKeyNotFound; near-api-js words the same error "Access key ... does not exist".
  const resultName = /InvalidAccessKey/i.test(errText) ? "InvalidAccessKey" : "InvalidAccessKey (access key does not exist)";
  out.agentAttempt = { result: resultName, rpcError: errText.slice(0, 300) };
  server.close();

  // summary
  const left = await membersTotal();
  out.accounts.faucetNear = fmtNear(faucetTotal);
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log("\n== cost summary");
  for (const c of out.costs) console.log(`  ${c.step}: ${c.members_near} NEAR, ${c.seconds}s`);
  console.log(`  faucet gave ${fmtNear(faucetTotal)} NEAR; council accounts now hold ${fmtNear(left)} NEAR`);
  console.log("\n== result");
  console.log(`access keys: ${JSON.stringify(finalKeys)}`);
  console.log(`returned to DAO: ${fmtNear(returned)} NEAR`);
  console.log(`agent attempt: ${resultName}`);
  console.log(`term ended failure: ${out.termEnded.explorer}`);
  console.log(`fire: ${out.txs["fire.vote2"]?.explorer ?? out.txs["fire.vote1"]?.explorer}`);
  console.log(`details written to demo-output.json (${out.assertions.length} assertions passed)`);
}

main().then(
  () => process.exit(0),
  (e) => {
    try {
      writeFileSync(OUT_PATH, JSON.stringify({ ...out, failed: (e as Error).message }, null, 2));
    } catch {
      /* ignore */
    }
    console.error(e instanceof FaucetLimitError ? e.message : `\nDEMO FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);

