import type { Status } from "@termwork/shared";
import { classifyKeyError, explorerAccount, keyEndLink, keyStatus, type AccessKeyInfo, type DemoOutput } from "./chain";

interface Props {
  mandateId: string;
  /** null until the first live read settles or after a failure. */
  keys: AccessKeyInfo[] | null;
  /** true once a live read has actually failed (null keys without this means still loading). */
  failed?: boolean;
  status: Status;
  demo: DemoOutput | null;
}

export function KeyCard({ mandateId, keys, status, demo, failed = false }: Props) {
  const unknown = keys === null;
  const state = keyStatus(keys ?? []);
  const awaiting = status === "Unhired";
  const tone = awaiting || unknown ? "idle" : state;
  const tx = state === "deleted" && !awaiting && !unknown ? keyEndLink(status, mandateId, demo) : null;
  const attempt = demo?.agentAttempt;
  const attemptKind = attempt ? classifyKeyError(`${attempt.result} ${attempt.rpcError}`) : null;

  return (
    <section className={`keycard keycard-${tone}`} aria-label="Agent key" aria-live="polite">
      <div className="keycard-top">
        <span className="kc-eyebrow">Agent key</span>
        <span className="kc-lamp" aria-hidden="true" />
      </div>
      <div className="kc-state">{awaiting ? "Not issued yet" : unknown ? (failed ? "Fired, per the recording" : "Checking the chain") : state === "live" ? "Key live" : "Key deleted"}</div>
      <p className="kc-line">
        {unknown
          ? failed
            ? "Couldn't check the chain right now. The recorded run ended with the agent's key deleted."
            : "Reading the agent's access keys from the chain."
          : awaiting
          ? "The mandate holds no keys until the DAO votes the hire through."
          : state === "live"
            ? `One function-call key, scoped to this mandate. The DAO can end it with a vote, or the clock will.`
            : status === "Fired"
              ? "The DAO voted. The contract deleted the agent's key on-chain. It can no longer sign anything."
              : "The term ran out. The contract deleted the agent's key on-chain. It can no longer sign anything."}
      </p>
      {tx && (
        <a className="kc-tx" href={tx.href} target="_blank" rel="noreferrer">
          View {tx.label} on the explorer
        </a>
      )}
      <ul className="kc-keys">
        {unknown ? <li className="kc-none">access keys on {mandateId}: {failed ? "couldn't check right now" : "checking"}</li> : keys.length === 0 ? <li className="kc-none">access keys on {mandateId}: none</li> : keys.map((k) => <li key={k.public_key}>{k.public_key.slice(0, 18)}…</li>)}
      </ul>
      {attempt && state === "deleted" && !unknown && (
        <div className="kc-attempt">
          <span className="kc-eyebrow">Last attempt by the agent</span>
          <p>
            {attemptKind === "deleted" ? "Rejected by the network: " : "Result: "}
            <code>{attempt.result}</code>
          </p>
        </div>
      )}
      <a className="kc-acct" href={explorerAccount(mandateId)} target="_blank" rel="noreferrer">
        {mandateId}
      </a>
    </section>
  );
}
