// Prebuilt Vercel deploy: static page + the /api/decide function.
// Usage: npm run -w scripts deploy-vercel [-- --prod]
// Needs the repo root linked to the Vercel project `termwork` (npx vercel link --project termwork).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, ".vercel", "output");
const prod = process.argv.includes("--prod");

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
}

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

// 4. the function, bundled as ESM with every dependency inlined
const fn = join(out, "functions", "api", "decide.func");
mkdirSync(fn, { recursive: true });
await build({
  entryPoints: [join(root, "web", "api", "decide.ts")],
  outfile: join(fn, "index.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // CJS deps inside an ESM bundle need require
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
writeFileSync(join(fn, "package.json"), JSON.stringify({ type: "module" }));
writeFileSync(join(fn, ".vc-config.json"), JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: 60 }));

// 5. deploy
run("npx", ["--yes", "vercel@latest", "deploy", "--prebuilt", "--yes", ...(prod ? ["--prod"] : [])]);
