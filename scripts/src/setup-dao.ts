import { FaucetLimitError } from "./accounts.js";
import { isMain, saveState } from "./chain.js";
import { setupDao } from "./dao.js";

if (isMain(import.meta.url)) {
  setupDao()
    .then((s) => {
      saveState(s);
      console.log(`setup-dao done: ${s.daoId}`);
    })
    .catch((e) => {
      console.error(e instanceof FaucetLimitError ? e.message : `setup-dao failed: ${(e as Error).message}`);
      process.exit(1);
    });
}
