// Prebuilt Vercel deploy: static page + the /api functions (decide, analyse, pay, label, paid).
// Usage: npm run -w scripts deploy-vercel [-- --prod]
// Needs the repo root linked to the Vercel project `termwork` (npx vercel link --project termwork).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, ".vercel", "output");
// Pinned so a new CLI release can not break the deploy.
const VERCEL_CLI = "vercel@65.12.1";
const prod = process.argv.includes("--prod");

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

// 0. gate: tests and typecheck must pass before anything is built or shipped
run("npm", ["test"]);
run("npm", ["run", "-w", "web", "typecheck"]);

// 1. build the page (BASE_PATH deliberately unset: the site lives at /)
run("npm", ["run", "-w", "web", "build"], {
  VITE_NETWORK: process.env.VITE_NETWORK ?? "testnet",
  VITE_MANDATE_ID: process.env.VITE_MANDATE_ID ?? "steward.termwork-m2-fba0b2.testnet",
  VITE_DAO_ID: process.env.VITE_DAO_ID ?? "twfba0b2.sputnikv2.testnet",
});

// 2-3. Build Output API v3 layout; keep .vercel/project.json (the link)
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "static"), { recursive: true });
writeFileSync(join(out, "config.json"), JSON.stringify({ version: 3 }));
cpSync(join(root, "web", "dist"), join(out, "static"), { recursive: true });

// 4. the functions, each bundled as ESM with every dependency inlined
const FUNCTIONS = ["decide", "analyse", "pay", "label", "paid"] as const;
// analyse and pay call GitHub and the model or chain, so they get a longer limit
const MAX_DURATION: Record<(typeof FUNCTIONS)[number], number> = { decide: 60, analyse: 120, pay: 120, label: 60, paid: 60 };
for (const name of FUNCTIONS) {
  const fn = join(out, "functions", "api", `${name}.func`);
  mkdirSync(fn, { recursive: true });
  await build({
    entryPoints: [join(root, "web", "api", `${name}.ts`)],
    outfile: join(fn, "index.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    // CJS deps inside an ESM bundle need require
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  // gate: the bundle must load and export a handler
  const r = spawnSync(
    process.execPath,
    ["-e", "import(process.argv[1]).then((m) => process.exit(typeof m.default === 'function' ? 0 : 1), (e) => { console.error(e); process.exit(2); })", pathToFileURL(join(fn, "index.mjs")).href],
    { cwd: root, stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`Bundled function check failed: api/${name} index.mjs did not load or its default export is not a function. Not deploying.`);
  writeFileSync(join(fn, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(fn, ".vc-config.json"), JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: MAX_DURATION[name] }));
}

// 5. deploy
run("npx", ["--yes", VERCEL_CLI, "deploy", "--prebuilt", "--yes", ...(prod ? ["--prod"] : [])]);
