import { useState, type SyntheticEvent } from "react";
import { loadSnapshot, type ProposalView } from "../chain";
import { Proposals } from "../Proposals";

export function LiveDao() {
  const [proposals, setProposals] = useState<ProposalView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onToggle(e: SyntheticEvent<HTMLDetailsElement>) {
    if (!e.currentTarget.open || proposals) return;
    loadSnapshot().then(
      (s) => setProposals(s.proposals),
      (err: unknown) => setError((err as Error).message),
    );
  }

  return (
    <details className="livedao" onToggle={onToggle}>
      <summary>Live DAO voting</summary>
      <p className="small">
        Council members can vote on open proposals here with Intear Wallet or MyNearWallet, on testnet. The recorded run above is finished, so there may be nothing open.
      </p>
      {error && (
        <p className="err" role="alert">
          Could not load proposals: {error}
        </p>
      )}
      {proposals ? <Proposals proposals={proposals} /> : !error && <p className="empty">Loading proposals</p>}
    </details>
  );
}
