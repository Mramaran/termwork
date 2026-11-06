import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry, MandateView, SpendRequest } from "@termwork/shared";
import type { InferenceReceipt } from "../../agent/src/receipts.js";
import type { PullRequestFact } from "../../agent/src/sources/types.js";
import { ROOT, isMain, view } from "./chain.js";
import { buildRun, matchTxs, serializeRun, type ChainTx, type DemoOutput } from "./run-build.js";

const OUT_PATH = join(ROOT, "web", "public", "run.json");
const readJson = <T>(...p: string[]): T => JSON.parse(readFileSync(join(ROOT, ...p), "utf8")) as T;

async function readLog(mandate: string): Promise<LogEntry[]> {
  const all: LogEntry[] = [];
  for (;;) {
    const page = await view<LogEntry[]>(mandate, "get_work_log", { from: all.length, limit: 100 });
    all.push(...page);
    if (page.length < 100) return all;
  }
}

/** The mandate's transactions from the public nearblocks testnet API (v3), fetched once. [] if it cannot be reached. */
async function fetchChainTxs(mandate: string): Promise<ChainTx[]> {
  const out: ChainTx[] = [];
  let next: string | undefined;
  try {
    for (let page = 0; page < 10; page++) {
      const url = `https://api-testnet.nearblocks.io/v3/accounts/${mandate}/txns?limit=100${next ? `&next=${encodeURIComponent(next)}` : ""}`;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`nearblocks answered ${res.status}`);
      const j = (await res.json()) as {
        data?: { transaction_hash: string; block_timestamp: string; outcomes?: { status?: boolean }; actions?: { method?: string }[] }[];
        meta?: { next_page?: string };
      };
      for (const t of j.data ?? []) {
        const method = t.actions?.find((a) => a.method)?.method;
        if (method) out.push({ method, hash: t.transaction_hash, ok: t.outcomes?.status === true, blockMs: Number(BigInt(t.block_timestamp) / 1_000_000n) });
      }
      next = j.meta?.next_page || undefined;
      if (!next) break;
    }
  } catch (e) {
    console.log(`  nearblocks lookup failed (${(e as Error).message}); payment, request and renewal hashes stay null`);
  }
  return out;
}

async function main(): Promise<void> {
  const demo = readJson<DemoOutput>("demo-output.json");
  const mandateId = demo.accounts.mandate;
  const index = readJson<Record<string, string>>("receipts", "index.json");
  const receipts: Record<string, InferenceReceipt> = {};
  for (const h of new Set(Object.values(index))) receipts[h] = readJson<InferenceReceipt>("receipts", `${h}.json`);

  // fixture placeholders (*.invalid) -> the demo accounts, matched by the name before the first dot, as demo.ts does
  const byPrefix = new Map(Object.entries(demo.accounts.contributors).map(([fa, id]) => [fa.split(".")[0]!, id]));
  const prFacts = readJson<PullRequestFact[]>("fixtures", "prs.json").map((p) => ({
    ...p,
    nearAccount: p.nearAccount ? (byPrefix.get(p.nearAccount.split(".")[0]!) ?? null) : null,
  }));

  console.log(`reading ${mandateId} on testnet`);
  const [log, requests, mandate] = await Promise.all([
    readLog(mandateId),
    view<SpendRequest[]>(mandateId, "get_requests"),
    view<MandateView>(mandateId, "get_mandate"),
  ]);
  const proposals: unknown[] = [];
  for (const id of Object.values(demo.proposals)) proposals.push(await view(demo.accounts.dao, "get_proposal", { id }));

  const txLookup = matchTxs(await fetchChainTxs(mandateId), log, requests);
  const run = buildRun({ demo, mandate, log, requests, proposals, receipts, index, prFacts, txLookup });

  const json = serializeRun(run); // throws before anything is written if a value looks like a key
  mkdirSync(join(ROOT, "web", "public"), { recursive: true });
  writeFileSync(OUT_PATH, json);

  console.log(`wrote ${OUT_PATH} (${json.length} bytes)`);
  for (const p of run.prs) console.log(`  PR #${p.number} ${p.outcome.padEnd(9)} tx ${p.outcome === "skipped" ? "n/a (no transaction expected)" : (p.tx ?? "NULL")}`);
  console.log(`  big-spend request tx: ${run.bigSpend.requestTx ?? "NULL"}`);
  console.log(`  renewal proposal tx:  ${run.renewal.proposalTx ?? "NULL"}`);
  console.log(`  renewal receipt:      ${run.renewal.receiptHash}`);
}

if (isMain(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(`export-run failed: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
