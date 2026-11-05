import { useEffect, useState } from "react";
import { budgetBar, DAO_ID, explorerAccount, fmtNear, loadDemoOutput, loadSnapshot, MANDATE_ID, type DemoOutput, type Snapshot } from "./chain";
import { KeyCard } from "./KeyCard";
import { Proposals } from "./Proposals";
import { Renewal } from "./Renewal";
import { Timeline } from "./Timeline";

const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 120_000;

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function countdown(endMs: number, now: number): string {
  const left = Math.max(0, endMs - now);
  const s = Math.floor(left / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [demo, setDemo] = useState<DemoOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);

  useEffect(() => {
    void loadDemoOutput().then(setDemo);
    if (!MANDATE_ID) {
      setError("VITE_MANDATE_ID is not set. Add VITE_MANDATE_ID and VITE_DAO_ID to .env and restart.");
      return;
    }
    // Public testnet RPCs rate-limit bursts; one snapshot is ~20 calls, so poll
    // every 15 s (one request at a time) and back off up to 2 min on errors.
    let live = true;
    let delay = POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const s = await loadSnapshot();
        if (!live) return;
        setSnap(s);
        setError(null);
        delay = POLL_MS;
      } catch (e) {
        if (!live) return;
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        setError(`${(e as Error).message} (retrying in ${Math.round(delay / 1000)} s)`);
      }
      if (live) timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const m = snap?.mandate;
  const bar = m ? budgetBar(m.budget_spent, m.budget_available) : null;
  const ended = m ? m.status !== "Active" : false;

  return (
    <div className="page">
      <header className="masthead">
        <div className="brand">Termwork</div>
        <h1>The AI agent that has to earn its next term.</h1>
        <p className="sub">Hired by vote. Renewed on evidence. Fired on-chain.</p>
      </header>

      {error && <p className="err banner" role="alert">{error}</p>}
      {!snap && !error && <p className="empty">Reading the chain…</p>}

      {snap && m && bar && (
        <main>
          <section className="hero">
            <div className="hero-copy">
              <div className="row-meta">
                <span className={`status status-${m.status}`}>{m.status}</span>
                <span className="small">term {m.term_number}</span>
              </div>
              <h2>{m.mission?.title ?? "No mission set"}</h2>
              <dl className="facts">
                <div>
                  <dt>Hired by</dt>
                  <dd>
                    <a href={explorerAccount(m.dao_id || DAO_ID)} target="_blank" rel="noreferrer">{m.dao_id || DAO_ID}</a>
                  </dd>
                </div>
                <div>
                  <dt>Agent account</dt>
                  <dd>
                    <a href={explorerAccount(MANDATE_ID)} target="_blank" rel="noreferrer">{MANDATE_ID}</a>
                  </dd>
                </div>
                <div>
                  <dt>{ended ? "Term" : "Term ends in"}</dt>
                  <dd className="clock">{ended ? m.status.toLowerCase() : m.term_end_ms ? countdown(m.term_end_ms, now) : "—"}</dd>
                </div>
              </dl>
            </div>
            <KeyCard mandateId={MANDATE_ID} keys={snap.keys} status={m.status} demo={demo} />
          </section>

          <section>
            <h3>Budget</h3>
            <div className="bar" role="img" aria-label={`${fmtNear(bar.spent)} NEAR spent of ${fmtNear(bar.deposit)} NEAR`}>
              <span className="bar-spent" style={{ width: `${bar.spentPct}%` }} />
              <span className="bar-avail" style={{ width: `${bar.availablePct}%` }} />
            </div>
            <div className="bar-legend">
              <span><i className="dot spent" /> spent {fmtNear(bar.spent)} NEAR</span>
              <span><i className="dot avail" /> available {fmtNear(bar.available)} NEAR</span>
              <span className="small">paid directly up to {fmtNear(m.spend_threshold)} NEAR; anything bigger goes to a DAO vote</span>
            </div>
          </section>

          <section>
            <h3>Mission</h3>
            <ol className="clauses">
              {(m.mission?.clauses ?? []).map((c) => (
                <li key={c.id}>
                  <span className="cn">{c.id}</span>
                  <span>{c.text}</span>
                  {c.max_amount && <span className="cap">up to {fmtNear(c.max_amount)} NEAR</span>}
                </li>
              ))}
            </ol>
          </section>

          <div className="cols">
            <section>
              <h3>Work log</h3>
              <Timeline log={snap.log} clauses={m.mission?.clauses ?? []} />
            </section>
            <aside>
              <section>
                <h3>Open proposals</h3>
                <Proposals proposals={snap.proposals} />
              </section>
              <section>
                <h3>Renewal case</h3>
                <Renewal renewal={snap.renewal} archived={demo?.accounts?.renewalReport} />
              </section>
            </aside>
          </div>
        </main>
      )}
      <footer>Testnet only. Refreshes every 5 seconds from the chain.</footer>
    </div>
  );
}
