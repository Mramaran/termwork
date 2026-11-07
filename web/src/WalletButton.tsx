import { useEffect, useState } from "react";
import { connect, connectedAccount, disconnect, WALLET_EVENT, type WalletId } from "./wallet";

/** Header control: connect Intear (or MyNearWallet), or show the connected account with a disconnect button. */
export function WalletButton() {
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const read = () => void connectedAccount().then(setAccount);
    read();
    window.addEventListener(WALLET_EVENT, read);
    return () => window.removeEventListener(WALLET_EVENT, read);
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setAccount(await connectedAccount());
    } catch (e) {
      setError((e as Error).message || "The wallet did not respond.");
    } finally {
      setBusy(false);
    }
  }

  const signIn = (id: WalletId) => run(() => connect(id));

  if (account)
    return (
      <span className="walletbtn">
        <span className="acct" title="Connected wallet">
          <span className="dot" aria-hidden="true" />
          {account}
        </span>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(disconnect)}>
          Disconnect
        </button>
      </span>
    );
  return (
    <span className="walletbtn">
      <button type="button" className="btn go" disabled={busy} onClick={() => void signIn("intear-wallet")}>
        Connect Intear
      </button>
      <button type="button" className="btn" disabled={busy} onClick={() => void signIn("my-near-wallet")}>
        MyNearWallet
      </button>
      {error && (
        <span className="err small" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
