import { describe, expect, it } from "vitest";
import { budgetBar, classifyKeyError, keyStatus, linkifyCitations, receiptBadge, rpcUrl } from "./chain";

describe("chain helpers", () => {
  it("keyStatus returns deleted when key list empty", () => {
    expect(keyStatus([])).toBe("deleted");
    expect(keyStatus([{ public_key: "ed25519:abc", access_key: { nonce: 1, permission: "FullAccess" } }])).toBe("live");
  });

  it("linkifyCitations maps [#3] to anchor #log-3", () => {
    const parts = linkifyCitations("paid [#3] and [#12], not [#x]");
    const cites = parts.filter((p) => p.kind === "cite");
    expect(cites).toEqual([
      { kind: "cite", text: "[#3]", index: 3, href: "#log-3" },
      { kind: "cite", text: "[#12]", index: 12, href: "#log-12" },
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("paid [#3] and [#12], not [#x]");
  });

  it("budget bar values sum to deposit", () => {
    const bar = budgetBar("600000000000000000000000", "2580000000000000000000000");
    expect(bar.deposit).toBe("3180000000000000000000000");
    expect(BigInt(bar.spent) + BigInt(bar.available)).toBe(BigInt(bar.deposit));
    expect(bar.spentPct + bar.availablePct).toBeCloseTo(100, 5);
    expect(budgetBar("0", "0").spentPct).toBe(0);
  });

  it("classifyKeyError recognises every measured deleted-key form", () => {
    for (const t of ["AccessKeyDoesNotExist", "InvalidAccessKey", "AccessKeyNotFound", "access key ed25519:x does not exist while viewing"]) {
      expect(classifyKeyError(t)).toBe("deleted");
    }
    expect(classifyKeyError("Smart contract panicked: term ended")).toBe("other");
  });

  it("receiptBadge is verified only when receipt.verified === true", () => {
    expect(receiptBadge({ verified: true, model: "m" }).label).toBe("verified inference");
    expect(receiptBadge({ verified: false, model: "fixture-rules", verifiedScope: "none" }).label).toBe("unverified (fixture rules)");
    expect(receiptBadge({ verified: "true" as unknown as boolean, model: "m" }).label).toBe("unverified");
    expect(receiptBadge(null).label).toBe("no receipt");
  });

  it("rpcUrl only accepts allowlisted https hosts", () => {
    expect(rpcUrl(undefined)).toBe("https://rpc.testnet.near.org");
    expect(rpcUrl("https://rpc.testnet.fastnear.com")).toBe("https://rpc.testnet.fastnear.com");
    expect(() => rpcUrl("https://rpc.testnet.near.org.evil.com")).toThrow();
    expect(() => rpcUrl("http://rpc.testnet.near.org")).toThrow();
  });
});

describe("keyEndLink", () => {
  it("key deleted with no demo output links to the mandate account explorer", async () => {
    const { keyEndLink } = await import("./chain");
    const l = keyEndLink("Fired", "steward.x.testnet", null);
    expect(l.href).toBe("https://testnet.nearblocks.io/address/steward.x.testnet");
    expect(keyEndLink("Expired", "steward.x.testnet", { txs: {} }).href).toContain("/address/");
  });
  it("uses the demo fire hash when present", async () => {
    const { keyEndLink } = await import("./chain");
    const h = "DWfgznuamSJJ6ki8KYTek6m3j4i2kVofr74HQPVXJCny";
    expect(keyEndLink("Fired", "m.testnet", { txs: { "fire.vote2": { hash: h, explorer: "" } } }).href).toBe(`https://testnet.nearblocks.io/txns/${h}`);
  });
});
