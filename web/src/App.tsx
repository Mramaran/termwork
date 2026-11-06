import { useCallback, useEffect, useState } from "react";
import { loadRun, type RunData } from "./run";
import { LiveDao } from "./views/LiveDao";
import { RunYourself } from "./views/RunYourself";
import { TryLive } from "./views/TryLive";
import { WatchRun } from "./views/WatchRun";

type Tab = "watch" | "live" | "yourself";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "watch", label: "Watch our run", icon: "M4 2l10 6-10 6z" },
  {
    id: "live",
    label: "Try the AI live",
    icon: "M9 1L3 9h5l-1 6 6-8H8z"
  },
  {
    id: "yourself",
    label: "Run it yourself",
    icon: "M2 4l4 4-4 4M8 12h6"
  },
];

const tabFromHash = (): Tab => {
  const h = window.location.hash.replace(/^#/, "");
  return h === "live" || h === "yourself" ? h : "watch";
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
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [run, setRun] = useState<RunData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [strip, setStrip] = useState(true);

  useEffect(() => {
    const on = () => setTab(tabFromHash());
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
          <h1>Termwork</h1>
          <p className="tag">The AI agent that has to earn its next term.</p>
          <p className="sub">Hired by vote. Renewed on evidence. Fired on-chain.</p>
        </div>
        <div className="right">
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
            <Icon d={t.icon} stroke={t.id !== "watch"} />
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
        {tab === "live" && <TryLive />}
        {tab === "yourself" && <RunYourself />}
      </main>
      <footer>Testnet only. The run was recorded once; the agent-key check reads the chain live.</footer>
    </div>
  );
}
