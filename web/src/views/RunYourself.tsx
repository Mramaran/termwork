import { useState } from "react";

const BLOCKS = [
  {
    title: "Free run, no keys",
    text: "No API keys needed. It uses about 30 testnet NEAR from the public faucet (rate-limited) and a `.env` copied from `.env.example`. Takes about 12 minutes on testnet.",
    cmd: "npm ci\nAGENT_MODE=fixture npm run -w scripts demo",
    href: "https://github.com/Mramaran/termwork#run-it",
  },
  {
    title: "With your own NEAR AI key",
    text: "Add NEARAI_API_KEY and NEARAI_MODEL to `.env`, then run the demo against the real model.",
    cmd: "npm run -w scripts demo",
    href: "https://github.com/Mramaran/termwork#run-it",
  },
  {
    title: "Tests only",
    text: "Runs the unit tests. The cargo tests run in contracts/mandate (Linux, macOS or WSL).",
    cmd: "npm test\ncd contracts/mandate && cargo test",
    href: "https://github.com/Mramaran/termwork#tests",
  },
];

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    ta.remove();
  }
}

export function RunYourself() {
  const [copied, setCopied] = useState<number | null>(null);
  return (
    <section className="runy" aria-labelledby="yourself-h">
      <h2 id="yourself-h">Run it yourself</h2>
      {BLOCKS.map((b, i) => (
        <div key={b.title} className="cmdblock">
          <h3>{b.title}</h3>
          <p>
            {b.text.split("`").map((part, j) => (j % 2 ? <code key={j}>{part}</code> : part))}{" "}
            <a href={b.href} target="_blank" rel="noreferrer">
              README section
            </a>
          </p>
          <pre>
            <code>{b.cmd}</code>
          </pre>
          <button type="button" className="btn" onClick={() => void copyText(b.cmd).then(() => setCopied(i))}>
            Copy command {i + 1}
          </button>
          <span className="small" role="status">
            {copied === i ? " Copied" : ""}
          </span>
        </div>
      ))}
    </section>
  );
}
