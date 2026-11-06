# Termwork

**The AI agent that has to earn its next term.**

*Hired by vote. Renewed on evidence. Fired on-chain.*

Termwork lets a [Sputnik DAO](https://github.com/near-daos/sputnik-dao-contract) on NEAR testnet hire an AI agent, the Contributor Rewards Steward, for a fixed term. The agent pays merged pull requests from a budget, sends anything large to a DAO vote, and files a renewal case when the term nears its end. The DAO can fire it at any time, and the contract deletes the agent's key itself.

## The problem

Communities are starting to hand real money to AI agents, but they can only switch them on and off. Today either one member runs the agent with a key the community cannot take back, or a wallet gets a permanent allowance and the agent runs until someone notices a problem. Nobody asks whether the agent is still worth paying, nothing ends it by default, and a prompt-injected agent that holds a raw key can reach whatever the key reaches.

## Try it

Everything runs on NEAR **testnet**; the code refuses any other network. You need Node 22 or newer. A prebuilt mandate wasm is committed at `contracts/mandate/res/termwork_mandate.wasm`, so Rust is optional: step 3 (building from source) needs Rust with the `wasm32-unknown-unknown` target and `cargo-near`, and step 4 uses that build when it exists and the committed wasm otherwise.

1. **Install.** `npm ci` → the install finishes without errors. `npm test` then runs the TypeScript tests and they pass.
2. **Create a DAO.** `npm run -w scripts setup-dao` → it takes 3 faucet accounts (`termwork-m1-<id>.testnet` to `m3`) from `https://helper.nearprotocol.com`, creates a 2-of-3 Sputnik DAO and prints `setup-dao done: <name>.sputnikv2.testnet`. `DAO_ID` is written to `.env`, and the account names to `.termwork-state.json`.
3. **Build the contract (optional).** `cd contracts/mandate && cargo near build non-reproducible-wasm && cd ../..` → `contracts/mandate/target/near/termwork_mandate.wasm` exists. Skip this step to deploy the committed wasm; its sha256 is in [`contracts/mandate/res/README.md`](contracts/mandate/res/README.md).
4. **Deploy it.** `npm run -w scripts deploy` → it logs which wasm it uses (`target/near` build if present, else `res/`), creates `steward.<member 2>`, deploys the contract, calls `new`, deletes the account's only key and prints `mandate: steward.…, access keys: []`. `MANDATE_ID` is written to `.env`.
5. **Hire the agent.** `npm run -w scripts hire -- --term 3600` (term in seconds; default 300) → it generates the agent keypair, writes `AGENT_PRIVATE_KEY` to `.env` (the key is never printed), files the `hire` proposal and casts two council votes. You see `hired: proposal N approved, term 3600s`, and the mandate's only access key is now the agent's function-call key.
6. **Configure the processes.** Add `SIGNER_TOKEN` to `.env`; generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Every variable is listed in [`.env.example`](.env.example).
7. **Start the signer** in one terminal: `npm run -w signer start` → `[signer] listening on http://127.0.0.1:8787 for steward.…`.
8. **Start the agent** in a second terminal: `npm run -w agent start` → `agent started (mode=…, source=fixtures, interval=30000ms)`, then log lines for the pull requests it handles. The mode comes from `AGENT_MODE` in `.env`:
   - `AGENT_MODE=fixture`: no model, no key; deterministic rules decide. Receipts are labelled model `fixture-rules`, `verified: false`.
   - `AGENT_MODE=replay`: no model call and no NEAR AI key; the agent reuses the receipts in `receipts/`, matched by pull request URL. The committed receipts are fixture receipts (see [Receipts](#receipts)), so replay shows rule-based decisions. A pull request with no stored receipt is logged as `no stored receipt for <url>`.
   - `AGENT_MODE=live`: NEAR AI Cloud decides. Needs `NEARAI_API_KEY` and `NEARAI_MODEL`.

   With `SOURCE=fixtures`, the contributor accounts in `fixtures/prs.json` are placeholders (`*.invalid`) that cannot exist on testnet, so outside the demo the agent logs `recipient account does not exist` and pays no one. Only `npm run -w scripts demo` creates real recipient accounts (sub-accounts of a council member) and maps the fixture names onto them.

   The agent process exits with `mandate is no longer active, agent stopped` when the mandate's status is not Active, so restart it after a DAO renewal.
9. **Vote.** When the agent asks for a payment above the spend threshold, or files a renewal case, it creates a DAO proposal. `npm run -w scripts vote <proposalId> approve` (or `reject`) casts council votes until the proposal passes or fails → it prints `proposal <id>: <status>`. A renewal proposal is not tied to a term: one left open from an earlier term (or from before a fire and re-hire) still renews the current agent if the council approves it, so reject stale renewal proposals instead of voting them through.
10. **Run the whole story at once.** `npm run -w scripts demo` → see below.

### The end-to-end demo

`npm run -w scripts demo` does steps 2 to 9 in one process, with its own signer and agent loop, and ends with the fire. It takes about 12 minutes and about 30 NEAR of testnet faucet funds (up to 3 faucet accounts via `https://helper.nearprotocol.com`; the faucet rate-limits, and the script says so if it refuses). It deploys the committed wasm unless you built your own (step 3). The agent mode is `AGENT_MODE` from `.env`, else `live` when `NEARAI_API_KEY` is set, else `fixture`. The demo term is 5 minutes (`DEMO_TERM_SECS`).

You see a `PASS` line for each assertion, in this order:

1. The mandate has no access keys after setup.
2. After `hire`, the agent's function-call key is the only key.
3. The agent pays merged pull requests, sends the big one to a DAO vote and skips one. In fixture mode the counts are exact (3 paid, 1 request, 1 skip); with a live model they depend on the model.
4. The DAO votes the big spend down and no money moves.
5. The agent files its renewal case, and every `[#n]` citation in the report points at a real work-log entry.
6. The term ends. A late `spend` is sent anyway and fails on-chain with `term ended`.
7. The DAO votes `fire`, the key list becomes empty, `fire` returns the budget to the DAO, and `sweep` forwards proposal bonds that Sputnik returns after the fire.
8. The agent retries with its old key and the chain rejects it as a deleted access key.

The run writes `demo-output.json` (git-ignored) with every transaction hash and account. Two transactions from a recorded run on testnet:

- A payment after the term ended, failed on-chain: <https://testnet.nearblocks.io/txns/3rws8jkHauNr6if9thQ4AheXPs3fBw9rHEh9UUKWiqmT>
- The DAO fires the agent: <https://testnet.nearblocks.io/txns/7Mr7ghBFYrEtp3wATP79em7aNxoPK4Gjo1crrycDbKaZ>

### The web page

1. Put `VITE_MANDATE_ID`, `VITE_DAO_ID` and `VITE_NETWORK=testnet` in the repo-root `.env` (`web/vite.config.ts` sets `envDir` to the repo root).
2. `npm run -w web dev` → Vite prints a local URL. The page shows the agent key card, budget, mission, work log, open proposals and the renewal case, read from testnet.
3. Voting from the page goes through a NEAR wallet (MyNearWallet) and is best-effort. The CLI vote in step 9 always works.

`.github/workflows/pages.yml` builds `web` and deploys it to GitHub Pages on every push to `main`. For it to show your deployment, set the repository variables `VITE_MANDATE_ID` and `VITE_DAO_ID` (Settings → Secrets and variables → Actions → Variables) and set Settings → Pages → Source to "GitHub Actions". The workflow sets `BASE_PATH=/<repo-name>/` (taken from the repository name) so Vite's `base` matches `https://<owner>.github.io/<repo-name>/`.

## How it works

```
 council (2 of 3)              Sputnik DAO  (sputnikv2.testnet)
   votes via CLI/wallet  ───▶  proposals: hire · renew · fire · spend request
                                     │ function call
                                     ▼
 ┌───────────────────── mandate contract (contracts/mandate) ─────────────────────┐
 │ lives on the agent's own account, no full-access key after deploy              │
 │ holds: mission, budget, term, work log, spend requests, renewal case           │
 │ hire/renew: adds the agent's function-call key      fire: deletes it           │
 │ agent key: spend · request_spend · log_work · propose_renewal · expire         │
 │ anyone: expire (after term end) · sweep (after fire, funds to the DAO)         │
 │ DAO only: hire · renew · fire · release (after expiry, funds to the DAO)       │
 └────────────────────────────────────▲────────────────────────────────────────────┘
                                      │ signed transactions (fresh nonce each)
 ┌─────────── signer (signer/) ───────┴───┐      ┌──────────── agent (agent/) ───────────┐
 │ 127.0.0.1 only, bearer token           │◀─────│ source: fixtures | github              │
 │ exactly 5 operations, serial queue     │ HTTP │ model: NEAR AI Cloud, or fixture rules │
 │ 504 "outcome unknown" on timeout       │      │ fixed-rule validator turns the answer  │
 │ testnet-only RPC allowlist             │      │ into one allowed action                │
 │ the only process that holds the key    │      │ stores a receipt per model answer      │
 └────────────────────────────────────────┘      └────────────────────────────────────────┘

 web/ (React, GitHub Pages): reads the chain and receipts/, shows the key card
```

- **Mandate contract** (`contracts/mandate`, Rust, near-sdk 5). The DAO calls `hire`, `renew` and `fire` through Sputnik proposals; the contract adds or deletes its own function-call key in response. `spend` pays directly, only within the clause maximum, the spend threshold and the remaining budget (the DAO-voted total, which is the hire deposit plus renewal top-ups, never the account balance), and only once per evidence URL. A larger payment goes through `request_spend`, which opens a DAO proposal. `propose_renewal` stores the agent's report on-chain and opens a renewal proposal; only one can be open per term. After the term, `expire` (agent key or anyone) ends the mandate and deletes the key, and the DAO calls `release` to take the remaining budget back. After a `fire`, anyone can call `sweep` to forward leftover funds to the DAO.
- **Signer** (`signer`). A local HTTP server on `127.0.0.1` that requires a bearer token and exposes exactly five operations: `spend`, `request_spend`, `log_work`, `propose_renewal`, `expire`. It uses a fresh nonce for every transaction and runs them one at a time. If the RPC times out it answers `504` with "outcome unknown" instead of guessing. It talks only to the testnet RPC hosts on an allowlist.
- **Agent** (`agent`). Reads merged pull requests from `fixtures/prs.json` (`SOURCE=fixtures`) or the GitHub API (`SOURCE=github`, with `GITHUB_REPO`). For each one it builds a prompt from the mandate, gets a decision from the model, and passes it through a fixed-rule validator (`agent/src/validate.ts`) that turns it into exactly one action: pay, request a vote, or log a skip. For example it skips a pull request that was already paid, has no NEAR account, or is not from a first-time contributor. The agent never signs anything itself.
- **Receipts** (`receipts/`). Each model answer is stored as a JSON file named by its SHA-256, and the work-log entry carries that hash.
- **Web** (`web`). Vite and React reading testnet JSON-RPC directly.

### What "verified" means

A receipt is `verified: true` only if all of these hold:

1. The response signature was made by a signing address listed in the model's attestation report.
2. `signature_kind` is `provider_tee`.
3. The signed text names the requested model and carries the SHA-256 of the request and of the response.
4. The attestation report echoes the fresh nonce sent with that request.

Termwork does **not** verify the Intel TDX quote or the NVIDIA NRAS GPU evidence, so it does not prove that the signing address belongs to genuine TEE hardware. The `verifiedScope` field of each receipt says what was checked: `response-signature+model+nonce` or `none`.

### Model, speed and cost

The agent uses `Qwen/Qwen3.8-27B` on NEAR AI Cloud, a model NEAR AI runs inside a TEE (`owned_by: nearai`). Set it with `NEARAI_MODEL`. NEAR AI prices it at **$0.04 per million input tokens** and **$1.35 per million output tokens**.

Measured on 2026-11-06 with the real decision prompt (`agent/src/prompts.ts`) for one pull request:

| | Value |
|---|---|
| Time, end to end (completion, attestation report, signature) | 8.4 s |
| Tokens | 491 input, 84 output |
| Cost | $0.00013 |
| Receipt | `verified: true` |

A full demo run makes 5 decisions and one renewal report, about **$0.001**. The $10 of NEAR AI credit that NEAR Builders offers covers thousands of runs.

**Why reasoning is off.** Every chat request sends `reasoning_effort: "none"` (`agent/src/nearai.ts`). The model is a reasoning model; left on, it spent about 1,750 thinking tokens and 45 seconds on a decision that needs 84 tokens of output, and slower decisions ran past the demo's 5-minute term. Turning reasoning off does not weaken the receipts: the answer is still signed by the model's TEE key (`signature_kind: provider_tee`). The decision itself is only advice; the fixed rules in `agent/src/validate.ts` and the contract's own checks decide what is paid.

### Receipts

The `receipts/` folder in this repository currently holds **fixture receipts**. They were produced in `AGENT_MODE=fixture` (model `fixture-rules`, `verified: false`) because no NEAR AI key had been used yet. To record live ones, set `AGENT_MODE=live`, `NEARAI_API_KEY` and `NEARAI_MODEL` in `.env`, run the agent or the demo, and commit the new files in `receipts/`; `index.json` then points each pull request at its live receipt. `NEARAI_ALLOW_UNVERIFIED=1` allows a model that NEAR AI does not own; its receipts are marked unverified.

## Where the key lives and why the model never sees it

- `hire` writes the agent's function-call private key to `.env` as `AGENT_PRIVATE_KEY`, and `.env` is git-ignored.
- The standalone signer (`npm run -w signer start`) is the only process that loads `AGENT_PRIVATE_KEY`. The standalone agent (`npm run -w agent start`) reads the same `.env` but drops that variable (`agent/src/env.ts`). Do not `export AGENT_PRIVATE_KEY` in the shell you start the agent from; an exported value would be inherited by the agent process.
- `npm run -w scripts demo` runs the signer and the agent loop in one process for convenience, so in the demo the key is in that process's environment. It is still never sent to the model.
- The model receives only prompt text built from the mandate and one pull request. It has no tools and no key; its answer is parsed as data and checked by the validator.
- The agent reaches the chain only through the signer's five operations. The signer is bound to `127.0.0.1`, needs the bearer token, and scrubs the key and the token from error text before it leaves the process.
- The key can only call the mandate's agent methods. The mandate account has no full-access key after deploy, and `fire` deletes the agent key. The demo's last step shows the old key being rejected.

## Built during NEAR HACKATHON

Written from scratch during the hackathon; the first commit is dated 2026-11-05. These repositories were **read for patterns only, and no code was copied** from them:

- [near-daos/sputnik-dao-contract](https://github.com/near-daos/sputnik-dao-contract)
- [mikedotexe/near-payment-agent](https://github.com/mikedotexe/near-payment-agent)
- [near-examples/near-api-examples](https://github.com/near-examples/near-api-examples)
- [near-examples/nearai-cloud-verification-example](https://github.com/near-examples/nearai-cloud-verification-example)
- [NEAR-DevHub/trezu](https://github.com/NEAR-DevHub/trezu)

`contracts/mandate/tests/res/sputnikdao2.wasm` is the unmodified Sputnik DAO v2 binary from near-daos/sputnik-dao-contract (MIT licence), fetched from the `sputnikv2.testnet` factory. Only the contract's tests use it; `contracts/mandate/tests/res/README.md` records its source and hash.

## Tests

- `npm test` at the repo root runs the vitest suites of the signer, agent and web workspaces. It needs no network and no key.
- `cargo test` in `contracts/mandate` runs the unit tests and the sandbox lifecycle tests, which run the mandate next to the real Sputnik DAO wasm. It needs Linux, macOS or WSL (the near-sandbox binary is not available for native Windows), `cargo-near` and the `wasm32-unknown-unknown` target.
- `cargo test --test lifecycle` runs only the lifecycle tests. They build the wasm themselves with `cargo near build non-reproducible-wasm`, so they always test the current source. See [`contracts/mandate/README.md`](contracts/mandate/README.md) for WSL tips.

## License

[MIT](LICENSE), copyright Termwork contributors.
