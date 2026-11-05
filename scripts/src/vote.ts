import { isMain, loadState } from "./chain.js";
import { decide } from "./dao.js";

if (isMain(import.meta.url)) {
  const [id, verdict] = process.argv.slice(2);
  if (!id || !/^\d+$/.test(id) || (verdict !== "approve" && verdict !== "reject")) {
    console.error("usage: vote <proposalId> approve|reject");
    process.exit(1);
  }
  decide(loadState(), Number(id), verdict === "approve")
    .then((r) => console.log(`proposal ${id}: ${r.status}`))
    .catch((e) => {
      console.error(`vote failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
