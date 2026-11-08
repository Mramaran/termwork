import { useCallback, useEffect, useState } from "react";
import { Logo } from "./Logo";
import { loadRun, type RunData } from "./run";
import { AnalyseRepo } from "./views/AnalyseRepo";
import { LiveDao } from "./views/LiveDao";
import { RunYourself } from "./views/RunYourself";
import { WalletButton } from "./WalletButton";
import { WatchRun } from "./views/WatchRun";
import { Privacy, Terms } from "./views/Legal";

type Tab = "repo" | "watch" | "yourself";
type Page = Tab | "terms" | "privacy";
const TABS: { id: Tab; label: string; icon: string; stroke: boolean }[] = [
  { id: "repo", label: "1. Analyse a repo", icon: "M2 3h12M2 8h12M2 13h8", stroke: true },
  { id: "watch", label: "2. Watch a full term", icon: "M4 2l10 6-10 6z", stroke: false },
  { id: "yourself", label: "3. Run it yourself", icon: "M2 4l4 4-4 4M8 12h6", stroke: true },
];

/** Old links: #live was the AI playground, now folded into the repo analysis. */
const tabFromHash = (): Page => {
  const h = window.location.hash.replace(/^#/, "");
  return h === "watch" || h === "yourself" || h === "terms" || h === "privacy" ? h : "repo";
};

type Theme = "dark" | "light";
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("termwork-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* storage blocked */
  }
  try {
    if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
  } catch {
    /* no matchMedia */
  }
  return "dark";
}

const Icon = ({ d, stroke }: { d: string; stroke: boolean }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill={stroke ? "none" : "currentColor"} stroke={stroke ? "currentColor" : "none"} strokeWidth="1.6">
    <path d={d} />
  </svg>
);

export function App() {
  const [tab, setTab] = useState<Page>(tabFromHash);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [run, setRun] = useState<RunData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [strip, setStrip] = useState(true);

  useEffect(() => {
    const on = () => {
      const next = tabFromHash();
      setTab(next);
      if (next === "terms" || next === "privacy") window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    loadRun().then(setRun, (e: unknown) => setError((e as Error).message));
  }, []);

  const flip = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem("termwork-theme", next);
    } catch {
      /* storage blocked */
    }
  }, [theme]);

  return (
    <div className="wrap">
      <header>
        <div>
          <h1 className="brand">
            <Logo />
            Termwork
          </h1>
          <p className="tag">The AI agent that has to earn its next term.</p>
          <p className="sub">Hired by vote. Renewed on evidence. Fired on-chain.</p>
        </div>
        <div className="right">
          <WalletButton />
          <span className="net">
            <span className="dot" aria-hidden="true" />
            NEAR testnet
          </span>
          <a className="btn" href="https://github.com/Mramaran/termwork" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <button className="btn" type="button" onClick={flip}>
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Views">
        {TABS.map((t) => (
          <a key={t.id} href={`#${t.id}`} aria-current={t.id === tab ? "page" : undefined}>
            <Icon d={t.icon} stroke={t.stroke} />
            {t.label}
          </a>
        ))}
      </nav>

      <main>
        {tab === "watch" && strip && (
          <p className="strip">
            <span>
              <strong>Verify in 60 seconds.</strong> Click each step. Every claim links to its proof on the NEAR explorer or to a signed AI receipt; a tick means the page has confirmed it.
            </span>
            <button type="button" className="btn" aria-label="Dismiss this tip" onClick={() => setStrip(false)}>
              Dismiss
            </button>
          </p>
        )}
        {tab === "watch" &&
          (run ? (
            <WatchRun run={run} />
          ) : error ? (
            <p className="err" role="alert">Could not load the recorded run: {error}</p>
          ) : (
            <p className="empty">Loading the recorded run</p>
          ))}
        {tab === "watch" && <LiveDao />}
        {tab === "watch" && (
          <p className="nextstep">
            Next: <a href="#yourself">run it yourself</a> with your own DAO and agent on testnet.
          </p>
        )}
        {tab === "repo" && <AnalyseRepo />}
        {tab === "yourself" && <RunYourself />}
        {tab === "terms" && <Terms />}
        {tab === "privacy" && <Privacy />}
      </main>
      <footer>
        <p>Built for the NEAR hackathon as a demonstration. Testnet only. The run was recorded once; the agent-key check reads the chain live.</p>
        <p className="legal-links">
          <a href="#terms">Terms and conditions</a>
          <a href="#privacy">Privacy policy</a>
        </p>
      </footer>
    </div>
  );
}
