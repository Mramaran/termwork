import { useEffect, useState, type FormEvent } from "react";

interface Rule {
  rule: string;
  pass: boolean;
  note?: string;
}
interface Decision {
  qualifies: boolean;
  clause_id: number | null;
  amount_near: string | null;
  rationale: string;
}
interface DecideOk {
  answer: Decision | { error: string };
  rules: Rule[];
  result: string;
  amountNear?: string;
  receipt: { verified?: boolean; model?: string; signature?: unknown; attestation?: unknown } & Record<string, unknown>;
  receiptHash?: string;
}
interface Form {
  title: string;
  changedLines: string;
  feature: boolean;
  firstTime: boolean;
  nearAccount: string;
}

const PRESETS: { name: string; form: Form }[] = [
  { name: "Small first-time fix", form: { title: "docs: fix typo", changedLines: "12", feature: false, firstTime: true, nearAccount: "alice.testnet" } },
  { name: "Big feature", form: { title: "feat: dark mode", changedLines: "340", feature: true, firstTime: true, nearAccount: "dave.testnet" } },
  { name: "Repeat contributor", form: { title: "fix: flaky test", changedLines: "30", feature: false, firstTime: false, nearAccount: "erin.testnet" } },
];

/** The attested signing address: the response signature's, else the first model attestation's. */
export function signingAddress(receipt: DecideOk["receipt"]): string | null {
  const sig = receipt.signature as { signing_address?: string } | undefined;
  if (sig?.signing_address) return sig.signing_address;
  const att = receipt.attestation as
    | { model_attestations?: { signing_address?: string }[]; gateway_attestation?: { signing_address?: string } }
    | undefined;
  return att?.model_attestations?.[0]?.signing_address ?? att?.gateway_attestation?.signing_address ?? null;
}

function resultLine(r: DecideOk): string {
  return r.result === "would pay" && r.amountNear ? `${r.result} ${r.amountNear} NEAR` : r.result;
}

export function TryLive() {
  const [form, setForm] = useState<Form>(PRESETS[0]!.form);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<DecideOk | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!out) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(out.receipt, null, 2)], { type: "application/json" }));
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [out]);

  async function ask(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          changedLines: Number(form.changedLines),
          feature: form.feature,
          firstTime: form.firstTime,
          ...(form.nearAccount ? { nearAccount: form.nearAccount } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as (DecideOk & { error?: string; retryAfterSec?: number }) | null;
      if (!res.ok || !body || !body.answer) {
        const wait = body?.retryAfterSec ? ` Try again in ${body.retryAfterSec} seconds.` : "";
        setError((body?.error ?? `The request failed (${res.status}).`) + wait);
      } else {
        setOut(body);
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const addr = out ? signingAddress(out.receipt) : null;

  return (
    <section className="tryl" aria-labelledby="live-h">
      <h2 id="live-h">Try the AI live</h2>
      <p className="note">
        Nothing is paid. This calls the same model and the same rules the agent used, against the same mission. The NEAR account is not checked on-chain here.
      </p>
      <div className="presets" role="group" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" className="btn" onClick={() => setForm(p.form)}>
            {p.name}
          </button>
        ))}
      </div>
      <form className="askform" onSubmit={(e) => void ask(e)}>
        <label>
          Title
          <input value={form.title} maxLength={200} required onChange={(e) => set("title", e.target.value)} />
        </label>
        <label>
          Changed lines
          <input type="number" min={0} max={100000} required value={form.changedLines} onChange={(e) => set("changedLines", e.target.value)} />
        </label>
        <label>
          NEAR account
          <input value={form.nearAccount} onChange={(e) => set("nearAccount", e.target.value)} />
        </label>
        <label className="chk">
          <input type="checkbox" checked={form.feature} onChange={(e) => set("feature", e.target.checked)} />
          Feature
        </label>
        <label className="chk">
          <input type="checkbox" checked={form.firstTime} onChange={(e) => set("firstTime", e.target.checked)} />
          First-time contributor
        </label>
        <button type="submit" className="btn go" disabled={busy}>
          Ask the agent
        </button>
      </form>

      <div className="result" aria-live="polite" aria-busy={busy}>
        {busy && <p className="empty">Asking the TEE model…</p>}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        {out && (
          <>
            <div className="rblock">
              <h3>AI said</h3>
              {"error" in out.answer ? (
                <p>The model's answer couldn't be read as a decision.</p>
              ) : (
                <>
                  <p>
                    {out.answer.qualifies ? "It qualifies" : "It does not qualify"}
                    {out.answer.clause_id ? ` (clause ${out.answer.clause_id})` : ""}
                    {out.answer.amount_near ? `, ${out.answer.amount_near} NEAR` : ""}.
                  </p>
                  <p className="quote">{out.answer.rationale}</p>
                </>
              )}
            </div>
            <div className="rblock">
              <h3>Rules</h3>
              <ul className="rules">
                {out.rules.map((r) => (
                  <li key={r.rule}>
                    <span className={r.pass ? "pass" : "fail"} aria-hidden="true">
                      {r.pass ? "✓" : "✗"}
                    </span>{" "}
                    <span>
                      {r.pass ? "Pass" : "Fail"}: {r.rule}
                    </span>
                    {r.note && <span className="small"> ({r.note})</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rblock">
              <h3>Result</h3>
              <p className="verdict">{resultLine(out)}</p>
              <p>
                <span className={out.receipt.verified === true ? "badge ok" : "badge"}>
                  {out.receipt.verified === true ? "verified inference" : "unverified"}
                </span>
              </p>
              <p className="links">
                {blobUrl && (
                  <a href={blobUrl} target="_blank" rel="noreferrer">
                    full receipt (JSON, opens in new tab)
                  </a>
                )}
                {addr && (
                  <span>
                    {" "}
                    signing address: <code>{addr}</code>
                  </span>
                )}
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
