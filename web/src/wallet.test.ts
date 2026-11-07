// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendTx = vi.hoisted(() => vi.fn());
vi.mock("@near-wallet-selector/core", () => ({
  setupWalletSelector: async () => ({
    store: { getState: () => ({ accounts: [{ accountId: "me.testnet" }] }) },
    wallet: async () => ({ signAndSendTransaction: sendTx }),
  }),
}));
vi.mock("@near-wallet-selector/my-near-wallet", () => ({ setupMyNearWallet: () => ({}) }));
vi.mock("@near-wallet-selector/intear-wallet", () => ({ setupIntearWallet: () => ({}) }));

import { vote } from "./wallet";

describe("vote", () => {
  beforeEach(() => sendTx.mockReset());

  it("returns the transaction hash", async () => {
    sendTx.mockResolvedValue({ transaction: { hash: "HASH1" } });
    expect(await vote(3, true)).toBe("HASH1");
  });

  it("returns null, without throwing, when the wallet gives no outcome", async () => {
    sendTx.mockResolvedValue(undefined);
    expect(await vote(3, true)).toBeNull();
  });
});
