export type Source = "fixtures" | "github";
export type AgentMode = "live" | "replay";

export interface Config {
  NEAR_NETWORK: "testnet";
  MANDATE_ID: string;
  DAO_ID: string;
  /** Signer process only. Never read this anywhere else. */
  AGENT_PRIVATE_KEY: string;
  SIGNER_URL: string;
  SIGNER_TOKEN: string;
  NEARAI_API_KEY: string;
  NEARAI_MODEL: string;
  SOURCE: Source;
  GITHUB_REPO: string;
  GITHUB_TOKEN?: string;
  AGENT_MODE: AgentMode;
  LOOP_INTERVAL_MS: number;
}

function oneOf<T extends string>(name: string, v: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")} (this project is testnet only)`);
  }
  return v as T;
}

/** Reads configuration from the environment. Missing values become empty strings; consumers check what they need. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const interval = Number(env.LOOP_INTERVAL_MS ?? 30000);
  if (!Number.isInteger(interval) || interval <= 0) {
    throw new Error("LOOP_INTERVAL_MS must be a positive integer");
  }
  const cfg: Config = {
    NEAR_NETWORK: oneOf("NEAR_NETWORK", env.NEAR_NETWORK ?? "testnet", ["testnet"] as const),
    MANDATE_ID: env.MANDATE_ID ?? "",
    DAO_ID: env.DAO_ID ?? "",
    AGENT_PRIVATE_KEY: env.AGENT_PRIVATE_KEY ?? "",
    SIGNER_URL: env.SIGNER_URL ?? "http://127.0.0.1:8787",
    SIGNER_TOKEN: env.SIGNER_TOKEN ?? "",
    NEARAI_API_KEY: env.NEARAI_API_KEY ?? "",
    NEARAI_MODEL: env.NEARAI_MODEL ?? "",
    SOURCE: oneOf("SOURCE", env.SOURCE ?? "fixtures", ["fixtures", "github"] as const),
    GITHUB_REPO: env.GITHUB_REPO ?? "",
    AGENT_MODE: oneOf("AGENT_MODE", env.AGENT_MODE ?? "live", ["live", "replay"] as const),
    LOOP_INTERVAL_MS: interval,
  };
  if (env.GITHUB_TOKEN) cfg.GITHUB_TOKEN = env.GITHUB_TOKEN;
  return cfg;
}

/** Throws naming every listed key that is empty. */
export function requireConfig(cfg: Config, keys: (keyof Config)[]): void {
  const missing = keys.filter((k) => cfg[k] === "" || cfg[k] === undefined);
  if (missing.length) throw new Error(`missing required config: ${missing.join(", ")}`);
}
