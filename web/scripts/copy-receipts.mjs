import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const pub = join(here, "..", "public");
// Start clean so receipts deleted from the repo are no longer served.
rmSync(join(pub, "receipts"), { recursive: true, force: true });
mkdirSync(join(pub, "receipts"), { recursive: true });
if (existsSync(join(root, "receipts"))) cpSync(join(root, "receipts"), join(pub, "receipts"), { recursive: true });
// Optional: the demo run output powers the key card last-attempt line. The page works without it.
if (existsSync(join(root, "demo-output.json"))) cpSync(join(root, "demo-output.json"), join(pub, "demo-output.json"));
