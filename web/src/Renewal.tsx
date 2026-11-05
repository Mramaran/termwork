import type { Renewal as RenewalT } from "@termwork/shared";
import { fmtNear, linkifyCitations } from "./chain";

function renewalParts(text: string) {
  return linkifyCitations(text).map((p, i) =>
    p.kind === "cite" ? (
      <a
        key={i}
        className="cite"
        href={p.href}
        onClick={(e) => {
          const el = document.getElementById(p.href.slice(1));
          if (el) {
            e.preventDefault();
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("flash");
            setTimeout(() => el.classList.remove("flash"), 1600);
          }
        }}
      >
        {p.text}
      </a>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}

export function Renewal({ renewal, archived }: { renewal: RenewalT | null; archived?: string }) {
  if (!renewal && archived)
    return (
      <article className="renewal">
        <p className="renewal-ask small">The contract clears the case once the term closes. This copy is from the demo run.</p>
        <pre className="renewal-text">{renewalParts(archived)}</pre>
      </article>
    );
  if (!renewal) return <p className="empty">No renewal case filed yet. The agent writes one before its term ends.</p>;
  return (
    <article className="renewal">
      <p className="renewal-ask">
        Asking for <strong>{Math.round(renewal.requested_term_secs / 60)} more minutes</strong> and a top-up of <strong>{fmtNear(renewal.requested_topup)} NEAR</strong>.
      </p>
      <pre className="renewal-text">{renewalParts(renewal.report_text)}</pre>
      <p className="hash">report hash {renewal.report_hash}</p>
    </article>
  );
}
