import { useEffect, useState } from "react";
import { councilMembers, DAO_ID, explorerAccount, type ProposalView } from "./chain";
import { connect, connectedAccount, disconnect, vote } from "./wallet";

function kindLabel(kind: unknown): string {
  if (typeof kind === "string") return kind;
  if (kind && typeof kind === "object") {
    const k = Object.keys(kind)[0];
    return k ?? "Proposal";
  }
  return "Proposal";
}

function tally(p: ProposalView): { yes: number; no: number } {
  return Object.values(p.vote_counts ?? {}).reduce((a, [y, n]) => ({ yes: a.yes + y, no: a.no + n }), { yes: 0, no: 0 });
}

export function Proposals({ proposals }: { proposals: ProposalView[] }) {
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [council, setCouncil] = useState<string[] | null>(null);

  useEffect(() => {
    void connectedAccount().then(setAccount);
  }, []);

  useEffect(() => {
    void councilMembers().then(setCouncil, () => setCouncil(null));
  }, []);
  const canVote = !!account && (council === null || council.includes(account));

  const open = proposals.filter((p) => p.status === "InProgress");
  const closed = proposals.filter((p) => p.status !== "InProgress").reverse();

  async function act(id: number, approve: boolean) {
    setErr(null);
    setBusy(`${id}`);
    try {
      await vote(id, approve);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="proposals">
      <div className="wallet-row">
        {account ? (
          <>
            <span>
              Signed in as <b>{account}</b>
            </span>
            <button className="btn ghost" onClick={() => void disconnect().then(() => setAccount(null))}>
              Disconnect
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => void connect().catch((e: Error) => setErr(e.message))}>
            Connect MyNearWallet to vote
          </button>
        )}
        <a className="small" href={explorerAccount(DAO_ID)} target="_blank" rel="noreferrer">
          {DAO_ID}
        </a>
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      {open.length === 0 && <p className="empty">No proposals are open for a vote.</p>}
      {open.map((p) => {
        const t = tally(p);
        return (
          <article key={p.id} className="proposal">
            <header>
              <span className="pid">Proposal {p.id}</span>
              <span className="pkind">{kindLabel(p.kind)}</span>
            </header>
            <p className="pdesc">{p.description}</p>
            <div className="ptally">
              <span>{t.yes} approve</span>
              <span>{t.no} reject</span>
              <span className="small">by {p.proposer}</span>
            </div>
            <div className="pactions">
              <button className="btn" disabled={!canVote || busy === `${p.id}`} onClick={() => void act(p.id, true)}>
                Approve
              </button>
              <button className="btn danger" disabled={!canVote || busy === `${p.id}`} onClick={() => void act(p.id, false)}>
                Reject
              </button>
              {!canVote && <span className="small">{account ? "This account is not on the DAO council." : "Sign in with a DAO council account to vote."}</span>}
            </div>
            <p className="small fallback">Or from a terminal: npm run -w scripts vote {p.id} approve|reject</p>
          </article>
        );
      })}
      {closed.length > 0 && (
        <details className="closed">
          <summary>{closed.length} decided</summary>
          <ul>
            {closed.map((p) => (
              <li key={p.id}>
                <b>#{p.id}</b> <span className={`pill pill-${p.status}`}>{p.status}</span> {p.description.slice(0, 110)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
