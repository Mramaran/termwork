import { actionCreators } from "@near-js/transactions";
import { DAO_ID, VOTE_GAS, voteArgs } from "./chain";

/** Wallet Selector is loaded lazily so the page renders (read-only) even if the wallet bundle fails. */
async function selector() {
  const [{ setupWalletSelector }, { setupMyNearWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/my-near-wallet"),
  ]);
  return setupWalletSelector({ network: "testnet", modules: [setupMyNearWallet()] });
}

export async function connectedAccount(): Promise<string | null> {
  try {
    const s = await selector();
    return s.store.getState().accounts[0]?.accountId ?? null;
  } catch {
    return null;
  }
}

export async function connect(): Promise<void> {
  const s = await selector();
  const wallet = await s.wallet("my-near-wallet");
  await wallet.signIn({ contractId: DAO_ID, accounts: [] });
}

export async function disconnect(): Promise<void> {
  const s = await selector();
  const wallet = await s.wallet();
  await wallet.signOut();
}

/** Calls the Sputnik DAO act_proposal. MyNearWallet redirects for approval; the page reloads afterwards. */
export async function vote(id: number, approve: boolean): Promise<void> {
  const s = await selector();
  const wallet = await s.wallet();
  await wallet.signAndSendTransaction({
    receiverId: DAO_ID,
    actions: [actionCreators.functionCall("act_proposal", voteArgs(id, approve), BigInt(VOTE_GAS), 0n)],
  });
}
