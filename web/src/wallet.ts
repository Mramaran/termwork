import { actionCreators } from "@near-js/transactions";
import { AUTH_ACTION, AUTH_RECIPIENT, type CouncilProof } from "./authConst";
import { DAO_ID, VOTE_GAS, voteArgs } from "./chain";

/** Wallet Selector is loaded lazily so the page renders (read-only) even if the wallet bundle fails. */
async function selector() {
  const [{ setupWalletSelector }, { setupMyNearWallet }, { setupIntearWallet }] = await Promise.all([
    import("@near-wallet-selector/core"),
    import("@near-wallet-selector/my-near-wallet"),
    import("@near-wallet-selector/intear-wallet"),
  ]);
  return setupWalletSelector({ network: "testnet", modules: [setupIntearWallet(), setupMyNearWallet()] });
}

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
}

export async function disconnect(): Promise<void> {
  const s = await selector();
  const wallet = await s.wallet();
  await wallet.signOut();
}

/** Calls the Sputnik DAO act_proposal. The wallet asks for approval; the page reloads afterwards. */
export async function vote(id: number, approve: boolean): Promise<void> {
  const s = await selector();
  const wallet = await s.wallet();
  await wallet.signAndSendTransaction({
    receiverId: DAO_ID,
    actions: [actionCreators.functionCall("act_proposal", voteArgs(id, approve), BigInt(VOTE_GAS), 0n)],
  });
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
    const signed = await wallet.signMessage({ message, recipient: AUTH_RECIPIENT, nonce: nonce as unknown as Buffer });
    if (!signed) throw failed;
    return { accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, message, nonce: toBase64(nonce) };
  } catch {
    throw failed;
  }
}
