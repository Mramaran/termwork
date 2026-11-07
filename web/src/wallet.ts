import { actionCreators } from "@near-js/transactions";
import { AUTH_ACTION, AUTH_RECIPIENT, type CouncilProof } from "./authConst";
import { DAO_ID, VOTE_GAS, voteArgs } from "./chain";

/** Wallet Selector is loaded lazily so the page renders (read-only) even if the wallet bundle fails. */
let selectorPromise: ReturnType<typeof makeSelector> | null = null;
/** One Wallet Selector per page: rebuilding it on every call is slow enough that browsers block the wallet's popup. */
function selector() {
  if (!selectorPromise)
    selectorPromise = makeSelector().catch((e) => {
      selectorPromise = null;
      throw e;
    });
  return selectorPromise;
}
async function makeSelector() {
  const [{ setupWalletSelector }, { setupMyNearWallet }, { setupIntearWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/my-near-wallet"),
    import("@near-wallet-selector/intear-wallet"),
  ]);
  return setupWalletSelector({ network: "testnet", modules: [setupIntearWallet(), setupMyNearWallet()] });
}

/** Fired on window after the wallet connects or disconnects, so every part of the page can re-read the account. */
export const WALLET_EVENT = "termwork-wallet";
const announce = () => window.dispatchEvent(new Event(WALLET_EVENT));

export async function connectedAccount(): Promise<string | null> {
  try {
    const s = await selector();
    return s.store.getState().accounts[0]?.accountId ?? null;
  } catch {
    return null;
  }
}

export type WalletId = "intear-wallet" | "my-near-wallet";

export async function connect(walletId: WalletId): Promise<void> {
  const s = await selector();
  const wallet = await s.wallet(walletId);
  await wallet.signIn({ contractId: DAO_ID, accounts: [] });
  // Some wallets report the account a moment after sign-in resolves.
  for (let i = 0; i < 10 && !(await connectedAccount()); i++) await new Promise((r) => setTimeout(r, 500));
  announce();
}

export async function disconnect(): Promise<void> {
  const s = await selector();
  const wallet = await s.wallet();
  await wallet.signOut();
  announce();
}

/** Calls the Sputnik DAO act_proposal and returns the transaction hash, or null when the wallet gives none. The wallet asks for approval. */
export async function vote(id: number, approve: boolean): Promise<string | null> {
  const s = await selector();
  const wallet = await s.wallet();
  const outcome = await wallet.signAndSendTransaction({
    receiverId: DAO_ID,
    actions: [actionCreators.functionCall("act_proposal", voteArgs(id, approve), BigInt(VOTE_GAS), 0n)],
  });
  const hash = outcome?.transaction?.hash;
  return typeof hash === "string" ? hash : null;
}

const toBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));

/** Asks the connected wallet to sign a short-lived NEP-413 message proving the user is a council member. */
export async function signCouncilMessage(): Promise<CouncilProof> {
  const failed = new Error("Your wallet did not sign the message.");
  try {
    const s = await selector();
    const wallet = await s.wallet();
    if (!wallet.signMessage) throw failed;
    const message = JSON.stringify({ action: AUTH_ACTION, ts: Date.now() });
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const callbackUrl = window.location.href;
    const signed = await wallet.signMessage({ message, recipient: AUTH_RECIPIENT, nonce: nonce as unknown as Buffer, callbackUrl });
    if (!signed) throw failed;
    return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, message, nonce: toBase64(nonce), callbackUrl };
  } catch (e) {
    const why = e instanceof Error && e !== failed && e.message ? e.message : "";
    throw why ? new Error(`Your wallet did not sign the message: ${why}. If a popup was blocked, allow popups for this site and try again.`) : failed;
  }
}
