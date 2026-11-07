import { useCallback, useEffect, useState, type FormEvent } from "react";
import { councilMembers, explorerTx } from "../chain";
import { connect, connectedAccount, signCouncilMessage, vote, type WalletId } from "../wallet";

type Status = "paid" | "pending" | "ready" | "unclaimed" | "would_pay" | "skipped";
interface Row {
  url: string;
  number: number;
  title: string;
  author: string;
  firstTime: boolean;
  nearAccount: string | null;
  status: Status;
  amountNear: string | null;
  reason: string;
  proposalId: number | null;
}
interface Analysis {
  repo: string;
  payable: boolean;
  total: number;
  capped: boolean;
  suggestions: string[];
  fit: string;
  rows: Row[];
}
interface PaidItem {
  prUrl: string;
  title: string | null;
  repo: string;
  number: number;
  recipient: string;
  amountNear: string;
  via: "direct" | "dao";
  timestampMs: number;
  txHash: string | null;
  fallbackHref: string;
}
type Preset = "week" | "month" | "custom";
type Range = { preset: "week" | "month" } | { preset: "custom"; from: string; to: string };

const FIT_REASON: Record<string, string> = {
  no_merged_in_range: "No pull requests were merged in this range.",
  no_first_timers: "None of the merged pull requests are from first-time contributors, so there is nothing to reward.",
  not_found: "That repository could not be found.",
};

const FAILED = "The request failed. Try again in a minute.";
const DUPLICATE = "already paid or pending";
const OFFLINE = "Could not reach the server. Check your connection and try again.";

async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, status: res.status, data };
}

function errorText(data: Record<string, unknown> | null, status: number): string {
  const base = typeof data?.error === "string" ? data.error : `${FAILED} (${status})`;
  const wait = typeof data?.retryAfterSec === "number" ? ` Try again in ${data.retryAfterSec} seconds.` : "";
  return base + wait;
}

export function AnalyseRepo() {
  const [repo, setRepo] = useState("");
  const [preset, setPreset] = useState<Preset>("month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Analysis | null>(null);
  const [ran, setRan] = useState<{ repo: string; range: Range } | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [council, setCouncil] = useState<string[] | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [paid, setPaid] = useState<PaidItem[]>([]);
  const [paidError, setPaidError] = useState<string | null>(null);

  useEffect(() => {
    void connectedAccount().then(setAccount);
    void councilMembers().then(setCouncil, () => setCouncil(null));
  }, []);

  const loadPaid = useCallback(async () => {
    try {
      const res = await fetch("/api/paid");
      const body = (await res.json().catch(() => null)) as { items?: PaidItem[]; error?: string } | null;
      if (!res.ok || !body?.items) {
        setPaidError(body?.error ?? "Could not load the paid pull requests.");
        return;
      }
      setPaidError(null);
      setPaid(body.items);
    } catch {
      setPaidError("Could not load the paid pull requests.");
    }
  }, []);
  useEffect(() => {
    void loadPaid();
  }, [loadPaid]);

  const currentRange = (): Range => (preset === "custom" ? { preset, from, to } : { preset });

  /** Runs the analysis; returns the error message, or null on success. The message is also shown unless `quiet`. */
  async function runAnalysis(repoText: string, range: Range, quiet = false): Promise<string | null> {
    setBusy(true);
    setError(null);
    if (!quiet) setResult(null);
    const fail = (msg: string) => {
      if (!quiet) setError(msg);
      return msg;
    };
    try {
      const { ok, status, data } = await post("/api/analyse", { repo: repoText, range });
      if (status === 404 && data?.fit === "not_found") {
        setResult({ repo: repoText, payable: false, total: 0, capped: false, suggestions: (data.suggestions as string[]) ?? [], fit: "not_found", rows: [] });
        setRan({ repo: repoText, range });
        return null;
      }
      if (!ok || !data || !Array.isArray(data.rows)) return fail(errorText(data, status));
      setResult(data as unknown as Analysis);
      setRan({ repo: repoText, range });
      return null;
    } catch {
      return fail(OFFLINE);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void runAnalysis(repo, currentRange());
  }

  function useSuggestion(s: string) {
    setRepo(s);
    void runAnalysis(s, currentRange());
  }

  async function signIn(id: WalletId) {
    setError(null);
    try {
      await connect(id);
      setAccount(await connectedAccount());
    } catch (e) {
      setError((e as Error).message || "Could not connect the wallet.");
    }
  }

  const isCouncil = !!account && !!council && council.includes(account);
  const readyRows = result?.rows.filter((r) => r.status === "ready") ?? [];
  const canRun = !!result?.payable && isCouncil && readyRows.length > 0;

  async function runPayments() {
    if (!result || !ran) return;
    setError(null);
    setPaying("all");
    try {
      let proof: Awaited<ReturnType<typeof signCouncilMessage>>;
      try {
        proof = await signCouncilMessage();
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      const failures: string[] = [];
      for (const r of readyRows) {
        try {
          const { ok, status, data } = await post("/api/pay", { repo: ran.repo, number: r.number, range: ran.range, proof });
          if (!ok) {
            failures.push(`PR #${r.number}: ${errorText(data, status)}`);
            const msg = typeof data?.error === "string" ? data.error : "";
            const perRow = status === 404 || (status === 409 && msg === DUPLICATE);
            if (!perRow) break;
          }
        } catch {
          failures.push(OFFLINE);
          break;
        }
      }
      const refreshError = await runAnalysis(ran.repo, ran.range, true);
      const lines = refreshError ? [...failures, refreshError] : failures;
      if (lines.length > 0) setError(lines.join("\n"));
      void loadPaid();
    } finally {
      setPaying(null);
    }
  }

  async function approve(r: Row) {
    if (!ran || r.proposalId === null || !account) return;
    setError(null);
    setPaying(`vote-${r.number}`);
    try {
      const txHash = await vote(r.proposalId, true);
      const lines: string[] = [];
      if (txHash === null) {
        lines.push("Vote sent. The paid label will appear once it is confirmed.");
      } else {
        const { ok, status, data } = await post("/api/label", { repo: ran.repo, number: r.number, txHash, sender: account });
        if (!ok) lines.push(errorText(data, status));
      }
      const refreshError = await runAnalysis(ran.repo, ran.range, true);
      if (refreshError) lines.push(refreshError);
      if (lines.length > 0) setError(lines.join("\n"));
      void loadPaid();
    } catch (e) {
      setError((e as Error).message || FAILED);
    } finally {
      setPaying(null);
    }
  }

  function statusCell(r: Row) {
    switch (r.status) {
      case "paid":
        return (
          <>
            Paid
            {r.amountNear ? ` ${r.amountNear} NEAR` : ""}
            {paid.find((p) => p.prUrl === r.url)?.txHash && (
              <>
                {" "}
                <a href={explorerTx(paid.find((p) => p.prUrl === r.url)!.txHash!)} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              </>
            )}
          </>
        );
      case "pending":
        return (
          <>
            Waiting for council approval
            {isCouncil && r.proposalId !== null && (
              <>
                {" "}
                <button type="button" className="btn" disabled={paying !== null} onClick={() => void approve(r)}>
                  Approve &amp; pay
                </button>
              </>
            )}
          </>
        );
      case "ready":
        return "Ready to pay";
      case "unclaimed":
        return `Earns ${r.amountNear ?? "?"} NEAR · unclaimed`;
      case "would_pay":
        return `Would pay ${r.amountNear ?? "?"} NEAR to ${r.nearAccount ?? "the contributor"}`;
      case "skipped":
        return `Skipped · ${r.reason}`;
    }
  }

  const poorFit = result && result.fit !== "ok" && (result.fit === "not_found" || result.rows.length === 0 || result.fit === "no_first_timers");

  return (
    <section className="tryl analyse" aria-labelledby="repo-h">
      <h2 id="repo-h">Analyse a repo</h2>
      <p className="note">
        Pick a public GitHub repository and a date range. The agent looks at each merged pull request and says what it would pay. Payments only happen for the demo repository, and only council members can run them.
      </p>

      <div className="wallet-row">
        <button type="button" className="btn go" onClick={() => void signIn("intear-wallet")}>
          Connect Intear
        </button>
        <button type="button" className="btn" onClick={() => void signIn("my-near-wallet")}>
          Connect MyNearWallet
        </button>
        {account && (
          <span>
            Connected as <b>{account}</b>
          </span>
        )}
      </div>

      <form className="askform" onSubmit={submit}>
        <label>
          Repository
          <input value={repo} placeholder="owner/name or a GitHub link" maxLength={200} required onChange={(e) => setRepo(e.target.value)} />
        </label>
        <fieldset className="rangeset">
          <legend>Merged in</legend>
          {(
            [
              ["week", "Last 1 week"],
              ["month", "Last 1 month"],
              ["custom", "Custom"],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className="chk">
              <input type="radio" name="range" checked={preset === id} onChange={() => setPreset(id)} />
              {label}
            </label>
          ))}
        </fieldset>
        {preset === "custom" && (
          <>
            <label>
              From
              <input type="date" value={from} required onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={to} required onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        )}
        <button type="submit" className="btn go" disabled={busy || paying !== null}>
          Analyse
        </button>
      </form>

      <div className="result" aria-live="polite" aria-busy={busy}>
        {busy && <p className="empty">Reading the pull requests…</p>}
        {error && (
          <p className="err" role="alert" style={{ whiteSpace: "pre-line" }}>
            {error}
          </p>
        )}
        {result && (
          <>
            {poorFit && (
              <div className="rblock">
                <p>{FIT_REASON[result.fit] ?? FIT_REASON.no_first_timers}</p>
                {result.suggestions.length > 0 && (
                  <>
                    <p className="small">Try one of these instead:</p>
                    <div className="presets" role="group" aria-label="Suggested repositories">
                      {result.suggestions.map((s) => (
                        <button key={s} type="button" className="btn" disabled={busy} onClick={() => useSuggestion(s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {result.rows.length > 0 && (
              <div className="tablewrap">
                <table className="prs">
                  <thead>
                    <tr>
                      <th scope="col">PR</th>
                      <th scope="col">Author</th>
                      <th scope="col">First-time</th>
                      <th scope="col">Decision</th>
                      <th scope="col">Amount</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r) => (
                      <tr key={r.url}>
                        <td>
                          <a href={r.url} target="_blank" rel="noreferrer">
                            #{r.number} {r.title}
                          </a>
                        </td>
                        <td>{r.author}</td>
                        <td>{r.firstTime ? "Yes" : "No"}</td>
                        <td>{r.reason}</td>
                        <td>{r.amountNear ? `${r.amountNear} NEAR` : "-"}</td>
                        <td>{statusCell(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {result.capped && (
              <p className="note">
                Showing the first {result.rows.length} of {result.total}. Narrow the range.
              </p>
            )}
            {canRun && (
              <p>
                <button type="button" className="btn go" disabled={paying !== null} onClick={() => void runPayments()}>
                  Run payments
                </button>
              </p>
            )}
          </>
        )}
      </div>

      <section className="paidpanel" aria-labelledby="paid-h">
        <h3 id="paid-h">Paid PRs</h3>
        {paidError && <p className="err">{paidError}</p>}
        {!paidError && paid.length === 0 && <p className="empty">Nothing has been paid yet.</p>}
        {paid.length > 0 && (
          <ul className="paidlist">
            {paid.map((p) => (
              <li key={p.prUrl}>
                <a href={p.prUrl} target="_blank" rel="noreferrer">
                  {p.title ?? `${p.repo}#${p.number}`}
                </a>{" "}
                <span>{p.recipient}</span> <span>{p.amountNear} NEAR</span> <span>{p.via === "dao" ? "DAO-approved" : "direct"}</span>{" "}
                <span>{new Date(p.timestampMs).toISOString().slice(0, 10)}</span>{" "}
                {p.txHash ? (
                  <a href={explorerTx(p.txHash)} target="_blank" rel="noreferrer">
                    View transaction
                  </a>
                ) : (
                  <a href={p.fallbackHref} target="_blank" rel="noreferrer">
                    View on explorer
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
