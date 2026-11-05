import { describe, expect, it } from "vitest";
import { loadAgentEnv, parseAgentEnv } from "../src/env.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = ["# a comment line", "MANDATE_ID=steward.test.testnet", "AGENT_PRIVATE_KEY=ed25519:SECRET", "SIGNER_TOKEN=tok # inline comment", ""].join("\n");

describe("agent .env loading", () => {
  it("loads .env without AGENT_PRIVATE_KEY", () => {
    const p = parseAgentEnv(ENV);
    expect(p.MANDATE_ID).toBe("steward.test.testnet");
    expect(p.SIGNER_TOKEN).toBe("tok");
    expect("AGENT_PRIVATE_KEY" in p).toBe(false);
    expect(JSON.stringify(p)).not.toContain("SECRET");
  });
  it("does not override existing variables and ignores a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-env-"));
    const f = join(dir, ".env");
    writeFileSync(f, ENV);
    const target: NodeJS.ProcessEnv = { MANDATE_ID: "already" };
    loadAgentEnv(f, target);
    expect(target.MANDATE_ID).toBe("already");
    expect(target.SIGNER_TOKEN).toBe("tok");
    expect(target.AGENT_PRIVATE_KEY).toBeUndefined();
    loadAgentEnv(join(dir, "nope"), target);
  });
});
