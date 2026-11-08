import { useEffect, useRef, useState } from "react";

const README = "https://github.com/Mramaran/termwork";

interface Block {
  title: string;
  /** Text with `code` spans. */
  text: string;
  cmd?: string;
}
interface Section {
  id: string;
  title: string;
  intro?: string;
  link?: { href: string; label: string };
  blocks: Block[];
}

const SECTIONS: Section[] = [
  {
    id: "before",
    title: "Before you start",
    blocks: [
      {
        title: "What you need",
        text: "Node 22 or newer, git and an internet connection. Everything runs on NEAR testnet; the code refuses any other network. The scripts take testnet NEAR from the public faucet (about 30 NEAR for a full run), which is free but rate-limited. Rust is optional: a prebuilt contract is in the repo. The commands below are for a bash shell; on Windows use Git Bash or WSL.",
      },
    ],
  },
  {
    id: "code",
    title: "1. Get the code",
    link: { href: `${README}#try-it`, label: "README: Try it" },
    blocks: [
      {
        title: "Clone, install and test",
        text: "`npm test` runs every TypeScript test and needs no network or key. Then copy the example settings to `.env`, which is git-ignored. The scripts fill in `DAO_ID`, `MANDATE_ID` and `AGENT_PRIVATE_KEY` for you.",
        cmd: "git clone https://github.com/Mramaran/termwork.git\ncd termwork\nnpm ci\nnpm test\ncp .env.example .env",
      },
    ],
  },
  {
    id: "demo",
    title: "2. The whole term in one command (about 12 minutes)",
    intro:
      "The demo creates its own 3-member DAO, deploys the mandate contract, hires the agent, lets it work, votes on the big payments, files the renewal case, ends the term and fires the agent. It prints a PASS line for each of the 8 checks and writes every transaction hash to `demo-output.json`. It puts your `.env` back when it ends.",
    link: { href: `${README}#the-end-to-end-demo`, label: "README: The end-to-end demo" },
    blocks: [
      {
        title: "a. No keys needed",
        text: "`.env.example` sets `AGENT_MODE=fixture`, so fixed rules make the decisions instead of a model. The pull requests are the made-up ones in `fixtures/prs.json`.",
        cmd: "npm run -w scripts demo",
      },
      {
        title: "b. With the real AI model",
        text: "Get a key from NEAR AI Cloud and set these three lines in `.env`. `AGENT_MODE` must change to `live`: while it says `fixture`, the demo ignores the key.",
        cmd: "AGENT_MODE=live\nNEARAI_API_KEY=<your key>\nNEARAI_MODEL=Qwen/Qwen3.8-27B",
      },
      {
        title: "c. On real GitHub pull requests",
        text: "Also add these lines to `.env` to work the real merged pull requests of the demo repository (or set `DEMO_REPO` to your own). The token only raises GitHub's rate limit. Then run `npm run -w scripts demo` again.",
        cmd: "DEMO_SOURCE=github\nDEMO_REPO=Mramaran/mission-dao-demo\nGITHUB_TOKEN=<a GitHub token>",
      },
      {
        title: "d. Replay your run on this page",
        text: "Turns the run you just made into `web/public/run.json`, the file the Watch a full term tab plays back.",
        cmd: "npm run -w scripts export-run",
      },
    ],
  },
  {
    id: "steps",
    title: "3. Step by step, with an agent that keeps running",
    intro: "The same lifecycle, one command at a time, for an agent you keep for longer than the demo.",
    link: { href: `${README}#try-it`, label: "README: Try it" },
    blocks: [
      {
        title: "Create the DAO",
        text: "Takes 3 faucet accounts and creates a 2-of-3 Sputnik DAO. It prints `setup-dao done: <name>.sputnikv2.testnet` and writes `DAO_ID` to `.env`.",
        cmd: "npm run -w scripts setup-dao",
      },
      {
        title: "Build the contract (optional)",
        text: "Needs Rust, the `wasm32-unknown-unknown` target and `cargo-near`. Skip it to deploy the committed `contracts/mandate/res/termwork_mandate.wasm`.",
        cmd: "cd contracts/mandate && cargo near build non-reproducible-wasm && cd ../..",
      },
      {
        title: "Deploy the mandate contract",
        text: "Creates `steward.<member>`, deploys the contract, deletes the account's only key and prints `access keys: []`. Writes `MANDATE_ID` to `.env`.",
        cmd: "npm run -w scripts deploy",
      },
      {
        title: "Hire the agent",
        text: "Generates the agent's key, writes `AGENT_PRIVATE_KEY` to `.env` without printing it, and passes the hire vote. `--term` is in seconds (default 30 days) and `--budget` in NEAR (default 5).",
        cmd: "npm run -w scripts hire -- --term 3600 --budget 5",
      },
      {
        title: "Set the signer token",
        text: "Prints a random token. Put it in `.env` as `SIGNER_TOKEN=`; the signer and the agent share it.",
        cmd: "node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"",
      },
      {
        title: "Start the signer (terminal 1)",
        text: "The only process that holds the agent's key. It listens on `127.0.0.1:8787` and allows exactly five operations.",
        cmd: "npm run -w signer start",
      },
      {
        title: "Start the agent (terminal 2)",
        text: "Works the pull requests from `SOURCE` (`fixtures`, or `github` with `GITHUB_REPO`) using `AGENT_MODE`. It never sees the key. Restart it after a renewal.",
        cmd: "npm run -w agent start",
      },
      {
        title: "Vote on proposals",
        text: "When the agent asks for a payment over 0.2 NEAR or files its renewal case, it opens a DAO proposal. Vote it through (or `reject`) with the proposal number it logs.",
        cmd: "npm run -w scripts vote <proposalId> approve",
      },
      {
        title: "Fire the agent",
        text: "Passes a fire vote. The contract deletes the agent's key and returns the remaining budget to the DAO.",
        cmd: "npm run -w scripts fire",
      },
    ],
  },
  {
    id: "web",
    title: "4. Run this web page locally",
    link: { href: `${README}#local-development-and-deploying`, label: "README: Local development" },
    blocks: [
      {
        title: "Point the page at your agent",
        text: "Add these lines to `.env`, using your own `MANDATE_ID` and `DAO_ID`, then start the page and open the URL Vite prints. The `/api` functions (analysis and payments) only run on Vercel; set `API_PROXY=https://termwork-nu.vercel.app` to borrow the live ones.",
        cmd: "VITE_NETWORK=testnet\nVITE_MANDATE_ID=<your MANDATE_ID>\nVITE_DAO_ID=<your DAO_ID>",
      },
      {
        title: "Start it",
        text: "",
        cmd: "npm run -w web dev",
      },
    ],
  },
  {
    id: "tests",
    title: "5. Run the contract tests",
    link: { href: `${README}#tests`, label: "README: Tests" },
    blocks: [
      {
        title: "Rust tests against the real Sputnik DAO",
        text: "Needs Linux, macOS or WSL (the NEAR sandbox has no native Windows build).",
        cmd: "rustup target add wasm32-unknown-unknown\ncargo install --locked cargo-near\ncd contracts/mandate && cargo test",
      },
    ],
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

const withCode = (text: string) => text.split("`").map((part, j) => (j % 2 ? <code key={j}>{part}</code> : part));

export function RunYourself() {
  const [copied, setCopied] = useState<{ key: string; ok: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  function copy(key: string, cmd: string) {
    void copyText(cmd).then((ok) => {
      setCopied({ key, ok });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 2000);
    });
  }
  return (
    <section className="runy" aria-labelledby="yourself-h">
      <h2 id="yourself-h">Run it yourself</h2>
      <p className="note">Everything you need to run Termwork on NEAR testnet, from a fresh clone to firing the agent.</p>
      {SECTIONS.map((s) => (
        <section key={s.id} className="runsec" aria-labelledby={`run-${s.id}`}>
          <h3 id={`run-${s.id}`}>{s.title}</h3>
          {s.intro && <p>{withCode(s.intro)}</p>}
          {s.blocks.map((b, i) => {
            const key = `${s.id}-${i}`;
            return (
              <div key={key} className="cmdblock">
                <h4>{b.title}</h4>
                {b.text && <p>{withCode(b.text)}</p>}
                {b.cmd && (
                  <>
                    <pre>
                      <code>{b.cmd}</code>
                    </pre>
                    <button type="button" className="btn" aria-label={`Copy: ${b.title}`} onClick={() => copy(key, b.cmd!)}>
                      Copy
                    </button>
                    <span className="small" role="status">
                      {copied?.key === key ? (copied.ok ? " Copied" : " Copy failed, select the text instead") : ""}
                    </span>
                  </>
                )}
              </div>
            );
          })}
          {s.link && (
            <p className="small">
              <a href={s.link.href} target="_blank" rel="noreferrer">
                {s.link.label}
              </a>
            </p>
          )}
        </section>
      ))}
    </section>
  );
}
