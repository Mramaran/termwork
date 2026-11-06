import { useEffect, useRef, useState } from "react";

const BLOCKS = [
  {
    title: "Free run, no keys (about 12 minutes on testnet)",
    text: "No API keys needed. It uses about 30 testnet NEAR from the public faucet (rate-limited) and a `.env` copied from `.env.example`.",
    cmd: "npm ci\nAGENT_MODE=fixture npm run -w scripts demo",
    href: "https://github.com/Mramaran/termwork#the-end-to-end-demo",
  },
  {
    title: "With your own NEAR AI key",
    text: "Add NEARAI_API_KEY and NEARAI_MODEL to `.env`, then run the demo against the real model.",
    cmd: "npm run -w scripts demo",
    href: "https://github.com/Mramaran/termwork#the-end-to-end-demo",
  },
  {
    title: "Tests only",
    text: "Runs the unit tests. The cargo tests run in contracts/mandate (Linux, macOS or WSL).",
    cmd: "npm test\ncd contracts/mandate && cargo test",
    href: "https://github.com/Mramaran/termwork#tests",
  },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
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
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

export function RunYourself() {
  const [copied, setCopied] = useState<{ i: number; ok: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  function copy(i: number, cmd: string) {
    void copyText(cmd).then((ok) => {
      setCopied({ i, ok });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2000);
    });
  }
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
          <button type="button" className="btn" onClick={() => copy(i, b.cmd)}>
            Copy command {i + 1}
          </button>
          <span className="small" role="status">
            {copied?.i === i ? (copied.ok ? " Copied" : " Copy failed, select the text instead") : ""}
          </span>
        </div>
      ))}
    </section>
  );
}
