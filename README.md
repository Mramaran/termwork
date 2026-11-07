# Termwork

**The AI agent that has to earn its next term.**

*Hired by vote. Renewed on evidence. Fired on-chain.*

Termwork lets a [Sputnik DAO](https://github.com/near-daos/sputnik-dao-contract) on NEAR testnet hire an AI agent, the Contributor Rewards Steward, for a fixed term. The agent pays merged pull requests from a budget, sends anything large to a DAO vote, and files a renewal case when the term nears its end. The DAO can fire it at any time, and the contract then deletes the agent's key itself.

## The problem

Communities are starting to hand real money to AI agents, but all they can do is switch them on or off. Either one member runs the agent with a key the community cannot take back, or a wallet gets a permanent allowance and the agent runs until someone notices a problem. Nobody checks whether the agent is still worth paying, nothing ends it by default, and a prompt-injected agent holding a raw key can reach whatever that key reaches.

## Try it

Everything runs on NEAR **testnet**; the code refuses any other network. You need Node 22 or newer. A prebuilt mandate wasm is committed at `contracts/mandate/res/termwork_mandate.wasm`, so Rust is optional. Step 3 builds from source and needs Rust with the `wasm32-unknown-unknown` target and `cargo-near`; step 4 deploys that build if it exists, and the committed wasm otherwise.

1. **Install.** Run `npm ci`; it should finish without errors. `npm test` then runs the TypeScript tests, which should pass.
2. **Create a DAO.** `npm run -w scripts setup-dao` takes 3 faucet accounts (`termwork-m1-<id>.testnet` to `m3`) from `https://helper.nearprotocol.com`, creates a 2-of-3 Sputnik DAO and prints `setup-dao done: <name>.sputnikv2.testnet`. It writes `DAO_ID` to `.env` and the account names to `.termwork-state.json`.
3. **Build the contract (optional).** `cd contracts/mandate && cargo near build non-reproducible-wasm && cd ../..` produces `contracts/mandate/target/near/termwork_mandate.wasm`. Skip this step to deploy the committed wasm; its sha256 is in [`contracts/mandate/res/README.md`](contracts/mandate/res/README.md).
4. **Deploy it.** `npm run -w scripts deploy` logs which wasm it uses (the `target/near` build if present, else `res/`), creates `steward.<member 2>`, deploys the contract, calls `new`, deletes the account's only key and prints `mandate: steward.…, access keys: []`. It writes `MANDATE_ID` to `.env`.
5. **Hire the agent.** `npm run -w scripts hire -- --term 3600` (term in seconds; default 300) generates the agent keypair, writes `AGENT_PRIVATE_KEY` to `.env` without printing it, files the `hire` proposal and casts two council votes. It prints `hired: proposal N approved, term 3600s`, and the mandate's only access key is now the agent's function-call key.
6. **Configure the processes.** Add `SIGNER_TOKEN` to `.env`; you can generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`. Every variable is listed in [`.env.example`](.env.example).
7. **Start the signer** in one terminal: `npm run -w signer start` prints `[signer] listening on http://127.0.0.1:8787 for steward.…`.
8. **Start the agent** in a second terminal: `npm run -w agent start` prints `agent started (mode=…, source=fixtures, interval=30000ms)`, then a log line for each pull request it handles. The mode comes from `AGENT_MODE` in `.env`:
   - `AGENT_MODE=fixture`: no model and no key; deterministic rules decide. Receipts are labelled model `fixture-rules`, `verified: false`.
   - `AGENT_MODE=replay`: no model call and no NEAR AI key; the agent reuses the receipts in `receipts/`, matched by pull request URL. The committed receipts come from live runs (see [Receipts](#receipts)), so replay shows the real model's decisions. A pull request with no stored receipt is logged as `no stored receipt for <url>`.
   - `AGENT_MODE=live`: NEAR AI Cloud decides. This needs `NEARAI_API_KEY` and `NEARAI_MODEL`.

   With `SOURCE=fixtures`, the contributor accounts in `fixtures/prs.json` are placeholders (`*.invalid`) that cannot exist on testnet, so outside the demo the agent logs `recipient account does not exist` and pays no one. Only `npm run -w scripts demo` creates real recipient accounts (sub-accounts of a council member) and maps the fixture names onto them.

   The agent process exits with `mandate is no longer active, agent stopped` when the mandate's status is not Active, so restart it after a DAO renewal.
9. **Vote.** When the agent asks for a payment above the spend threshold, or files a renewal case, it creates a DAO proposal. `npm run -w scripts vote <proposalId> approve` (or `reject`) casts council votes until the proposal passes or fails, then prints `proposal <id>: <status>`. A renewal proposal is not tied to a term. One left open from an earlier term, or from before a fire and re-hire, still renews the current agent if the council approves it, so reject stale renewal proposals rather than voting them through.
10. **Run the whole story at once** with `npm run -w scripts demo`, described below.

### The end-to-end demo

`npm run -w scripts demo` does steps 2 to 9 in one process, with its own signer and agent loop, and ends by firing the agent. It takes about 12 minutes and about 30 NEAR of testnet faucet funds, from up to 3 faucet accounts via `https://helper.nearprotocol.com`. The faucet rate-limits, and the script says so if it refuses. The demo deploys the committed wasm unless you built your own in step 3. The agent mode is `AGENT_MODE` from `.env`, else `live` when `NEARAI_API_KEY` is set, else `fixture`. The demo term is 5 minutes (`DEMO_TERM_SECS`).

By default the agent works the made-up PRs in `fixtures/prs.json`. With `DEMO_SOURCE=github` it works the real merged PRs of `DEMO_REPO` (default `Mramaran/mission-dao-demo`) from the last `DEMO_DAYS` days (default 30), and pays the accounts in their `near:` lines; set `GITHUB_TOKEN` to stay within GitHub's search limit. The demo makes its own DAO, mandate and agent key, and puts `.termwork-state.json` and `.env` back when it ends, so a live deployment keeps its own agent. Afterwards, `npm run -w scripts export-run` turns the run into `web/public/run.json` for the replay.

The script prints a `PASS` line for each check, in this order:

1. The mandate has no access keys after setup.
2. After `hire`, the agent's function-call key is the only key.
3. The agent pays merged pull requests, sends the big ones to a DAO vote and skips the rest. In fixture mode the counts are exact (3 paid, 1 request, 1 skip); with a live model they depend on the model.
4. The DAO approves each big spend and the money moves. With `DEMO_BIG_SPEND=reject` it votes them down instead, and no money moves.
5. The agent files its renewal case, and every `[#n]` citation in the report points at a real work-log entry.
6. The term ends. A late `spend` is sent anyway and fails on-chain with `term ended`.
7. The DAO votes `fire` and the key list becomes empty. `fire` returns the budget to the DAO, and `sweep` forwards the proposal bonds that Sputnik returns after the fire.
8. The agent retries with its old key, and the chain rejects it as a deleted access key.

The run writes `demo-output.json` (git-ignored) with every transaction hash and account. Some transactions from the recorded run that the web page replays:

- The DAO hires the agent: <https://testnet.nearblocks.io/txns/12THF4McgH6so9Vo7pkszK1nt64hMHYof6aARytgandq>
- The agent pays PR #4 (0.2 NEAR) directly: <https://testnet.nearblocks.io/txns/3H6RpxoZPNgdKTvacm6tSrEhbyjfpgYCS6uYcKmZZU8i>
- The council's vote that approves and pays PR #5 (0.5 NEAR): <https://testnet.nearblocks.io/txns/9HPRJY8FMexFrGJJA6W2UNqfdAD5PMvZZen3vhgrupPU>
- A payment after the term ended, which failed on-chain: <https://testnet.nearblocks.io/txns/48H3tuRiXxuyA4dfNTQzJZgFLsVckbQkTZ9BdDzxbNHv>
- The DAO fires the agent: <https://testnet.nearblocks.io/txns/CSkLbhDioLaXRigYeAm8q4vZdQwAPiou48DuJtBkqKEU>

That run (2026-11-07, `AGENT_MODE=live`, `DEMO_SOURCE=github`) used the agent account `steward.termwork-m2-4b411f.testnet` and the DAO `tw4b411f.sputnikv2.testnet`, and worked the 7 real merged pull requests of [`Mramaran/mission-dao-demo`](https://github.com/Mramaran/mission-dao-demo). The model (`Qwen/Qwen3.8-27B`) paid #1, #4 and #7 (0.2 NEAR each), sent #2 and #5 to DAO votes that approved and paid them (0.5 NEAR each), and skipped #3 and #6 as formatting-only changes. All 7 decision receipts are `verified: true`.

### The web page

The site is live at <https://termwork-nu.vercel.app>, with a **Connect Intear** (or MyNearWallet) button in the header. It has three tabs, meant to be visited in order:

1. **Analyse a repo** runs the agent on real GitHub pull requests (see [Real pull requests](#real-pull-requests) below). Its **Paid PRs** panel lists every payment the agent has made, read from its on-chain work log.
2. **Watch a full term** replays the recorded run above in five steps: Hire, Work, Vote, Renew and Fired. Each step has a feed of what happened and a "Check it yourself" list of links to the NEAR explorer and to the signed AI receipts. A link gets a tick only after the page has confirmed it: the transaction hash is present, the receipt loads with `verified: true`, the report hash matches the one on-chain, or the agent account has no keys left. Where the AI's renewal report disagrees with the contract's figures, the page points this out and goes by the contract.
3. **Run it yourself** has the commands to reproduce the run on testnet.

### Real pull requests

Any public repository can be analysed, but nothing is paid for it. Type `owner/name` (or a GitHub link), pick the merge window (last week, last month or custom dates) and click **Analyse**. The page reads up to 30 pull requests merged in that window, asks the model about each one, and passes each answer through the same fixed-rule validator the agent uses. Each row says what the agent would do: pay directly, send the payment to a DAO vote, skip it with a reason, or mark the reward unclaimed when the pull request has no `near:` line. Nothing is written to the repository.

The demo repository, [`Mramaran/mission-dao-demo`](https://github.com/Mramaran/mission-dao-demo), gets real payments, because it is on the server's allowlist (`PAYABLE_REPOS`). Click **Analyse our demo repo**, and each pull request that can be paid shows **Ready to pay** with the AI's estimated amount. Paying works like this:

1. A council member connects their wallet in the header and clicks **Run payments**. The wallet signs a short-lived message (NEP-413), which the server checks against the account's on-chain keys and the DAO's council list. Other visitors can watch, but cannot trigger a payment.
2. For each pull request that is ready, the server reads it again from GitHub, asks the model again and runs the validator. It also checks that the recipient account exists on testnet and that the pull request has not already been paid or sent to a vote. Only then does the agent key sign. The amount and recipient always come from the server's own checks, never from the browser.
3. The agent pays up to 0.2 NEAR at once (`spend`). A larger reward (0.5 NEAR, for a pull request with a `feature` label or more than 200 changed lines) becomes a DAO proposal (`request_spend`), and the row shows **Approve & pay**. One council vote from the wallet passes it, and the DAO pays the contributor.
4. When a payment lands, the pull request on GitHub gets a `💰 paid X NEAR` label and a comment with the transaction link. For a direct payment, the comment also carries the agent's decision receipt. For a DAO-approved payment, the server first checks the vote transaction on chain.

The mission rewards every valid merged pull request. A trivial change (a typo fix, a whitespace or formatting-only change, or an automated bot update) earns nothing; a code change that fixes a bug or adds behaviour always counts, however small. Each pull request is paid at most once, because the contract records its URL. The contributor's account has to be on its own line at the end of the pull request description:

```
near: yourname.testnet
```

Analysing a repository other than the demo repo makes one model call per pull request, so each visitor can run it twice a minute. The demo repo's analysis, payments and labels have separate limits. The agent can never spend more than the budget the DAO voted, and the agent key's gas allowance is 0.25 NEAR.

### Local development and deploying

1. Put `VITE_MANDATE_ID`, `VITE_DAO_ID` and `VITE_NETWORK=testnet` in the repo-root `.env` (`web/vite.config.ts` sets `envDir` to the repo root).
2. Run `npm run -w web dev` and open the local URL Vite prints. The `/api/*` functions only run on Vercel. To use them from the dev server, set `API_PROXY=https://termwork-nu.vercel.app` (for example in a git-ignored `.env.development.local`), and Vite forwards `/api` there.
3. Voting from the page goes through a NEAR wallet (Intear or MyNearWallet). The CLI vote in step 9 always works.

To deploy to Vercel (the static page plus the functions `decide`, `analyse`, `pay`, `label` and `paid`):

1. Once, run `npx vercel link --project termwork` at the repo root, and set these environment variables in the Vercel project (`.env.example` describes each one):
   - `NEARAI_API_KEY` and `NEARAI_MODEL`;
   - `MANDATE_ID`, `DAO_ID`, and `AGENT_PRIVATE_KEY` (the agent's function-call key, written to `.env` by `hire`);
   - `PAYABLE_REPOS`;
   - `GITHUB_TOKEN` (read access) and `GITHUB_LABEL_TOKEN` (labels and comments, demo repo only).

   The functions read them at request time and answer 503 if one they need is missing.
2. `npm run -w scripts deploy-vercel` makes a preview deployment, and `npm run -w scripts deploy-vercel -- --prod` updates <https://termwork-nu.vercel.app>. Pass `VITE_MANDATE_ID` and `VITE_DAO_ID` in the environment so the page reads the same mandate. The script first runs `npm test` and the web typecheck. It then builds `web`, bundles each function with esbuild, checks that every bundle loads and exports a handler, and runs a pinned Vercel CLI with `deploy --prebuilt`.

GitHub Pages is not used. Leave `.github/workflows/pages.yml` disabled in the repository settings: a Pages build has no `/api` functions, so analysis and payments would not work there.

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

 web/ (React, on Vercel): reads the chain and receipts/; web/api/ analyses repos and pays the demo repo
```

- **Mandate contract** (`contracts/mandate`, Rust, near-sdk 5). The DAO calls `hire`, `renew` and `fire` through Sputnik proposals, and the contract adds or deletes its own function-call key in response. `spend` pays directly, only once per evidence URL, and only within the clause maximum, the spend threshold and the remaining budget. That budget is the DAO-voted total (the hire deposit plus renewal top-ups), never the account balance. A larger payment goes through `request_spend`, which opens a DAO proposal. `propose_renewal` stores the agent's report on-chain and opens a renewal proposal; only one can be open per term. After the term, `expire` (called by the agent key or anyone) ends the mandate and deletes the key, and the DAO calls `release` to take the remaining budget back. After a `fire`, anyone can call `sweep` to forward leftover funds to the DAO.
- **Signer** (`signer`). A local HTTP server on `127.0.0.1` that requires a bearer token and exposes exactly five operations: `spend`, `request_spend`, `log_work`, `propose_renewal` and `expire`. It uses a fresh nonce for every transaction and runs them one at a time. If the RPC times out, it answers `504` with "outcome unknown", since it cannot tell whether the transaction landed. It talks only to the testnet RPC hosts on an allowlist.
- **Agent** (`agent`). Reads merged pull requests from `fixtures/prs.json` (`SOURCE=fixtures`) or the GitHub API (`SOURCE=github`, with `GITHUB_REPO`). For each one it builds a prompt from the mandate, gets a decision from the model, and passes it through a fixed-rule validator (`agent/src/validate.ts`) that turns it into exactly one action: pay, request a vote, or log a skip. The validator skips, for example, a pull request that was already paid or has no NEAR account. The agent never signs anything itself.
- **Receipts** (`receipts/`). Each model answer is stored as a JSON file named by its SHA-256, and the work-log entry carries that hash.
- **Web** (`web`). Vite and React, reading testnet JSON-RPC directly.

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

A fixture demo run makes 5 decisions and one renewal report, about **$0.001**; the real-PR run above made 7 decisions. The $10 of NEAR AI credit that NEAR Builders offers covers thousands of runs.

Every chat request sends `reasoning_effort: "none"` and `temperature: 0` (`agent/src/nearai.ts`). The model is a reasoning model. With reasoning on, it spent about 1,750 thinking tokens and 45 seconds on a decision that needs 84 tokens of output, and slower decisions ran past the demo's 5-minute term. Turning reasoning off does not weaken the receipts, because the answer is still signed by the model's TEE key (`signature_kind: provider_tee`). Temperature 0 makes the same pull request get the same decision on the analysis page and when it is paid. The decision is only advice: the fixed rules in `agent/src/validate.ts` and the contract's own checks decide what is paid.

### Receipts

The `receipts/` folder holds the live receipts from the recorded runs (model `Qwen/Qwen3.8-27B`, all `verified: true`), including the 8 from the run above: one per pull request decision, plus the renewal report. `index.json` maps each pull request URL, and `renewal:1`, to its receipt. Each receipt keeps the full request, response, signature and attestation report, so the checks above can be repeated offline. To record your own, set `AGENT_MODE=live`, `NEARAI_API_KEY` and `NEARAI_MODEL` in `.env` and run the agent or the demo. `NEARAI_ALLOW_UNVERIFIED=1` allows a model that NEAR AI does not own; its receipts are marked unverified.

## Where the key lives and why the model never sees it

- `hire` writes the agent's function-call private key to `.env` as `AGENT_PRIVATE_KEY`, and `.env` is git-ignored.
- The standalone signer (`npm run -w signer start`) is the only process that loads `AGENT_PRIVATE_KEY`. The standalone agent (`npm run -w agent start`) reads the same `.env` but drops that variable (`agent/src/env.ts`). Do not `export AGENT_PRIVATE_KEY` in the shell you start the agent from, or the agent process will inherit it.
- For convenience, `npm run -w scripts demo` runs the signer and the agent loop in one process, so in the demo the key is in that process's environment. It is still never sent to the model.
- The hosted `/api/pay` function holds the same kind of key as a Vercel secret. It signs only after its own checks, and only for allowlisted repositories.
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

- `npm test` at the repo root runs the vitest suites of every workspace: signer, agent, web (the page and the `/api` functions), scripts and shared. It needs no network and no key.
- `cargo test` in `contracts/mandate` runs the unit tests and the sandbox lifecycle tests, which run the mandate next to the real Sputnik DAO wasm. It needs Linux, macOS or WSL (the near-sandbox binary is not available for native Windows), `cargo-near` and the `wasm32-unknown-unknown` target.
- `cargo test --test lifecycle` runs only the lifecycle tests. They build the wasm themselves with `cargo near build non-reproducible-wasm`, so they always test the current source. See [`contracts/mandate/README.md`](contracts/mandate/README.md) for WSL tips.

## License

[MIT](LICENSE), copyright Termwork contributors.
