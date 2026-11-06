import { useEffect, useMemo, useRef, useState } from "react";
import { accessKeys, explorerAccount, fetchReceipt, type AccessKeyInfo, type Receipt } from "../chain";
import { KeyCard } from "../KeyCard";
import { confirmCheck, reportHashMatches, steps, type RunData, type StepId } from "../run";
import { Checklist } from "./Checklist";
import { Feed, Legend } from "./Feed";
import { Stepper } from "./Stepper";

const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 120_000;

/** Live access keys of the mandate account: null until read or after a failure. 15 s polling, backing off to 2 min. */
function useLiveKeys(account: string): { keys: AccessKeyInfo[] | null; failed: boolean } {
  const [state, setState] = useState<{ keys: AccessKeyInfo[] | null; failed: boolean }>({ keys: null, failed: false });
  useEffect(() => {
    let live = true;
    let delay = POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const keys = await accessKeys(account);
        if (!live) return;
        setState({ keys, failed: false });
        delay = POLL_MS;
      } catch {
        if (!live) return;
        setState({ keys: null, failed: true });
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      }
      if (live) timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [account]);
  return state;
}

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

export function WatchRun({ run }: { run: RunData }) {
  const [selected, setSelected] = useState<StepId>("fired");
  const [focusPr, setFocusPr] = useState<number | null>(null);
  const { keys, failed } = useLiveKeys(run.mandate);
  const all = useMemo(() => steps(run), [run]);
  const [receipts, setReceipts] = useState<Record<string, Receipt | null>>({});
  const [reportOk, setReportOk] = useState<boolean | null>(null);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const asked = useRef(new Set<string>());

  // Receipts: fetch each once; a rejected or missing fetch just stays unticked.
  useEffect(() => {
    let live = true;
    for (const step of Object.values(all)) {
      for (const c of step.checks) {
        const h = c.receiptHash;
        if (c.kind !== "receipt" || !h || asked.current.has(h)) continue;
        asked.current.add(h);
        void fetchReceipt(h)
          .catch(() => null)
          .then((r) => live && setReceipts((prev) => ({ ...prev, [h]: r })));
      }
    }
    return () => {
      live = false;
      asked.current.clear();
    };
  }, [all]);

  // The renewal report is hashed in the browser and compared with the hash recorded on-chain.
  useEffect(() => {
    let live = true;
    reportHashMatches(run.renewal.reportText, run.renewal.reportHash)
      .then((ok) => live && setReportOk(ok))
      .catch(() => live && setReportOk(null));
    return () => {
      live = false;
    };
  }, [run]);

  useEffect(() => {
    let live = true;
    const ctx = { keys, receipt: async (h: string) => receipts[h] ?? null, reportOk };
    void (async () => {
      const next: Record<string, boolean> = {};
      for (const [id, step] of Object.entries(all)) {
        for (let i = 0; i < step.checks.length; i++) next[`${id}:${i}`] = await confirmCheck(step.checks[i]!, ctx);
      }
      if (live) setConfirmed(next);
    })();
    return () => {
      live = false;
    };
  }, [all, keys, receipts, reportOk]);

  const step = all[selected];
  const keysCount = keys ? keys.length : null;
  const status = keys && keys.length > 0 ? "Active" : "Fired";
  const note = failed
    ? "Couldn't check the chain right now. Showing the recorded outcome."
    : keys === null
      ? "Checking the chain"
      : keys.length === 0
        ? "Keys on this account right now: none"
        : `Keys on this account right now: ${keys.length}`;

  const cite = (n: number) => {
    const pr = run.prs.find((p) => p.logIndex === n);
    setFocusPr(pr ? pr.number : null);
    setSelected("work");
  };

  return (
    <div className="watch">
      <section className="record" aria-label="The agent's record">
        <dl>
          <dt>Agent</dt>
          <dd>{run.mission.title}</dd>
          <dt>Account</dt>
          <dd>
            <a href={explorerAccount(run.mandate)} target="_blank" rel="noreferrer">{run.mandate}</a>
          </dd>
          <dt>Employer</dt>
          <dd>
            <a href={explorerAccount(run.dao)} target="_blank" rel="noreferrer">{run.dao}</a>, {run.hire.voteTxs.length} votes to hire
          </dd>
          <dt>Model</dt>
          <dd>{run.model} in a TEE on NEAR AI Cloud</dd>
          <dt>Recorded</dt>
          <dd>{fmtDate(run.recordedAt)}</dd>
        </dl>
        <div className={`revoked${status === "Active" ? " active" : ""}`} role="status">
          <strong>{status}</strong>
          <span className="now">{note}</span>
        </div>
      </section>

      <Stepper
        selected={selected}
        onSelect={(id) => {
          setFocusPr(null);
          setSelected(id);
        }}
      />

      <div className="grid">
        <div>
          <h2>What happened</h2>
          <Feed lines={step.feed} onCite={selected === "renew" ? cite : undefined} focusPr={selected === "work" ? focusPr : null} />
          <Legend />
        </div>
        <aside className="evidence" aria-label="Check it yourself">
          <h2>Check it yourself</h2>
          {selected === "fired" && <KeyCard mandateId={run.mandate} keys={keys} failed={failed} status="Fired" demo={null} />}
          <Checklist items={step.checks} confirmed={confirmed} keysFailed={failed} keysCount={keysCount} idPrefix={selected} />
        </aside>
      </div>
    </div>
  );
}
