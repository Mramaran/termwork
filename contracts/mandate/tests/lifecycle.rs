//! Sandbox lifecycle tests: the mandate contract against the real Sputnik DAO
//! wasm (the code the testnet factory deploys by default, see tests/res/README.md).
//!
//! Build the mandate wasm first: `cargo near build non-reproducible-wasm`.

use near_sdk::json_types::Base64VecU8;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{network::Sandbox, Account, Contract, Worker};
use serde_json::{json, Value};

const MANDATE_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/near/termwork_mandate.wasm"
);
const SPUTNIK_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/res/sputnikdao2.wasm");

const BOND_YOCTO: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
// Function-call keys pay gas from a 0.25 NEAR allowance; keep prepaid gas modest.
const AGENT_GAS: Gas = Gas::from_tgas(100);
const TERM_SECS: u64 = 120;
const ONE: u128 = 1_000_000_000_000_000_000_000_000;
const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000; // 1e19 yocto per byte
const GAS_BUFFER: u128 = 100_000_000_000_000_000_000_000; // contract's GAS_BUFFER, 0.1 NEAR

struct Env {
    worker: Worker<Sandbox>,
    alice: Account,
    bob: Account,
    payee: Account,
    dao: Contract,
    mandate: Contract,
    agent: Account,
    agent_sk: SecretKey,
}

impl Env {
    async fn setup() -> anyhow::Result<Env> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;

        let mut people = Vec::new();
        for name in ["alice", "bob", "carol", "payee"] {
            people.push(
                root.create_subaccount(name)
                    .initial_balance(NearToken::from_near(10))
                    .transact()
                    .await?
                    .into_result()?,
            );
        }
        let payee = people.pop().unwrap();
        let carol = people.pop().unwrap();
        let bob = people.pop().unwrap();
        let alice = people.pop().unwrap();

        // Sputnik DAO: council [alice, bob, carol], 2 of 3, 0.1 NEAR bond,
        // role `all` may add proposals.
        let dao_acc = root
            .create_subaccount("dao")
            .initial_balance(NearToken::from_near(40))
            .transact()
            .await?
            .into_result()?;
        let dao = dao_acc
            .deploy(&std::fs::read(SPUTNIK_WASM)?)
            .await?
            .into_result()?;
        let policy = json!({
            "roles": [
                {
                    "name": "all",
                    "kind": "Everyone",
                    "permissions": ["*:AddProposal"],
                    "vote_policy": {}
                },
                {
                    "name": "council",
                    "kind": { "Group": [alice.id(), bob.id(), carol.id()] },
                    "permissions": ["*:*"],
                    "vote_policy": {}
                }
            ],
            "default_vote_policy": {
                "weight_kind": "RoleWeight",
                "quorum": "0",
                "threshold": "2"
            },
            "proposal_bond": BOND_YOCTO.to_string(),
            "proposal_period": "604800000000000",
            "bounty_bond": BOND_YOCTO.to_string(),
            "bounty_forgiveness_period": "86400000000000"
        });
        dao.call("new")
            .args_json(json!({
                "config": { "name": "termwork", "purpose": "test", "metadata": "" },
                "policy": policy
            }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;

        // Mandate contract on its own account; then drop its full-access key so
        // only contract-managed keys can ever exist.
        let mandate_acc = root
            .create_subaccount("mandate")
            .initial_balance(NearToken::from_near(4))
            .transact()
            .await?
            .into_result()?;
        let mandate = mandate_acc
            .deploy(&std::fs::read(MANDATE_WASM)?)
            .await?
            .into_result()?;
        mandate
            .call("new")
            .args_json(json!({
                "dao_id": dao.id(),
                "proposal_bond": BOND_YOCTO.to_string()
            }))
            .transact()
            .await?
            .into_result()?;
        let full_access_pk = mandate.as_account().secret_key().public_key();
        mandate
            .batch()
            .delete_key(full_access_pk)
            .transact()
            .await?
            .into_result()?;
        assert!(
            mandate.view_access_keys().await?.is_empty(),
            "mandate must start with no keys at all"
        );

        let agent_sk = SecretKey::from_random(KeyType::ED25519);
        let agent = Account::from_secret_key(mandate.id().clone(), agent_sk.clone(), &worker);

        Ok(Env {
            worker,
            alice,
            bob,
            payee,
            dao,
            mandate,
            agent,
            agent_sk,
        })
    }

    /// Files a Sputnik FunctionCall proposal against the mandate. Returns the proposal id.
    async fn propose(
        &self,
        description: &str,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> anyhow::Result<u64> {
        let id = self
            .alice
            .call(self.dao.id(), "add_proposal")
            .args_json(json!({
                "proposal": {
                    "description": description,
                    "kind": { "FunctionCall": {
                        "receiver_id": self.mandate.id(),
                        "actions": [{
                            "method_name": method,
                            "args": Base64VecU8::from(args.to_string().into_bytes()),
                            "deposit": deposit.as_yoctonear().to_string(),
                            "gas": "100000000000000"
                        }]
                    }}
                }
            }))
            .deposit(NearToken::from_yoctonear(BOND_YOCTO))
            .max_gas()
            .transact()
            .await?
            .into_result()?
            .json::<u64>()?;
        Ok(id)
    }

    async fn vote(&self, voter: &Account, id: u64, action: &str) -> anyhow::Result<()> {
        voter
            .call(self.dao.id(), "act_proposal")
            .args_json(json!({ "id": id, "action": action }))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Two council votes (alice, bob) on a proposal.
    async fn decide(&self, id: u64, action: &str) -> anyhow::Result<()> {
        self.vote(&self.alice, id, action).await?;
        self.vote(&self.bob, id, action).await?;
        Ok(())
    }

    async fn proposal_status(&self, id: u64) -> anyhow::Result<String> {
        let p: Value = self
            .dao
            .view("get_proposal")
            .args_json(json!({ "id": id }))
            .await?
            .json()?;
        Ok(p["status"].as_str().unwrap_or("?").to_string())
    }

    async fn hire(&self, term_secs: u64, deposit: NearToken) -> anyhow::Result<()> {
        let pid = self
            .propose(
                "hire the agent",
                "hire",
                json!({
                    "mission": { "title": "Ship the thing", "clauses": [
                        { "id": 0, "text": "pay for work", "max_amount": null, "pays": true }
                    ]},
                    "spend_threshold": ONE.to_string(),
                    "max_request": (3 * ONE).to_string(),
                    "term_secs": term_secs,
                    "agent_public_key": self.agent_sk.public_key().to_string()
                }),
                deposit,
            )
            .await?;
        self.decide(pid, "VoteApprove").await?;
        assert_eq!(self.proposal_status(pid).await?, "Approved");
        Ok(())
    }

    async fn mandate_view(&self) -> anyhow::Result<Value> {
        Ok(self.mandate.view("get_mandate").await?.json()?)
    }

    async fn status(&self) -> anyhow::Result<String> {
        Ok(self.mandate.view("get_status").await?.json()?)
    }

    async fn key_list(&self) -> anyhow::Result<Vec<String>> {
        Ok(self
            .mandate
            .view_access_keys()
            .await?
            .into_iter()
            .map(|k| k.public_key.to_string())
            .collect())
    }

    async fn log_kinds(&self) -> anyhow::Result<Vec<String>> {
        let log: Vec<Value> = self
            .mandate
            .view("get_work_log")
            .args_json(json!({ "from": 0, "limit": 100 }))
            .await?
            .json()?;
        Ok(log
            .iter()
            .map(|e| e["kind"].as_str().unwrap().to_string())
            .collect())
    }

    async fn balance(&self, a: &near_workspaces::AccountId) -> anyhow::Result<u128> {
        Ok(self.worker.view_account(a).await?.balance.as_yoctonear())
    }

    /// Advance chain time by at least `secs` seconds.
    async fn advance_secs(&self, secs: u64) -> anyhow::Result<()> {
        let start = self.worker.view_block().await?.timestamp();
        let target = start + secs * 1_000_000_000;
        let mut step = secs.max(1);
        loop {
            self.worker.fast_forward(step).await?;
            let now = self.worker.view_block().await?.timestamp();
            if now >= target {
                return Ok(());
            }
            step = ((target - now) / 1_000_000_000).max(1);
        }
    }

    /// Agent-signed call (function-call key; no deposit allowed).
    async fn agent_call(
        &self,
        method: &str,
        args: Value,
    ) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
        Ok(self
            .agent
            .call(self.mandate.id(), method)
            .args_json(args)
            .gas(AGENT_GAS)
            .transact()
            .await?)
    }

    fn spend_args(&self, milli: u128, evidence: &str) -> Value {
        json!({
            "recipient": self.payee.id(),
            "amount": (milli * ONE / 1000).to_string(),
            "clause_id": 0,
            "evidence_url": evidence,
            "receipt_hash": "abc123"
        })
    }

    fn big_request_args(&self) -> Value {
        json!({
            "recipient": self.payee.id(),
            "amount": (2 * ONE).to_string(),
            "clause_id": 0,
            "evidence_url": "https://e/big",
            "receipt_hash": "def456",
            "rationale": "needs a human"
        })
    }
}

fn failure_text(r: &near_workspaces::result::ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

#[tokio::test]
async fn full_lifecycle_fire() -> anyhow::Result<()> {
    let e = Env::setup().await?;

    // 1. hire through a proposal and two votes; the agent key is listed
    e.hire(TERM_SECS, NearToken::from_near(10)).await?;
    assert_eq!(e.status().await?, "Active");
    assert_eq!(
        e.key_list().await?,
        vec![e.agent_sk.public_key().to_string()]
    );

    // 2. a spend signed by the agent key
    let payee_before = e.balance(e.payee.id()).await?;
    let r = e.agent_call("spend", e.spend_args(500, "https://e/1")).await?;
    assert!(r.is_success(), "spend failed: {}", failure_text(&r));
    assert_eq!(e.balance(e.payee.id()).await?, payee_before + ONE / 2);
    assert!(e.log_kinds().await?.contains(&"Paid".to_string()));

    // 3. a big-spend request, which the DAO rejects
    let r = e.agent_call("request_spend", e.big_request_args()).await?;
    assert!(r.is_success(), "request_spend failed: {}", failure_text(&r));
    let reqs: Vec<Value> = e.mandate.view("get_requests").await?.json()?;
    assert_eq!(reqs.len(), 1);
    let big_pid = reqs[0]["proposal_id"].as_u64().expect("proposal id saved");
    assert_eq!(e.proposal_status(big_pid).await?, "InProgress");
    e.decide(big_pid, "VoteReject").await?;
    assert_eq!(e.proposal_status(big_pid).await?, "Rejected");
    assert_eq!(e.balance(e.payee.id()).await?, payee_before + ONE / 2);

    // 4. past the renewal window (last 30% of the term), propose renewal
    e.advance_secs(TERM_SECS * 75 / 100).await?;
    let r = e
        .agent_call(
            "propose_renewal",
            json!({
                "report_text": "delivered everything",
                "requested_term_secs": 300,
                "requested_topup": ONE.to_string()
            }),
        )
        .await?;
    assert!(r.is_success(), "propose_renewal failed: {}", failure_text(&r));
    let renewal: Value = e.mandate.view("get_renewal").await?.json()?;
    let renewal_pid = renewal["proposal_id"].as_u64().expect("renewal proposal id");
    assert_eq!(e.proposal_status(renewal_pid).await?, "InProgress");

    // 5. the DAO fires the agent instead
    let dao_before = e.balance(e.dao.id()).await?;
    let fire_pid = e
        .propose(
            "fire",
            "fire",
            json!({ "reason": "not delivering" }),
            NearToken::from_near(0),
        )
        .await?;
    e.decide(fire_pid, "VoteApprove").await?;
    assert_eq!(e.proposal_status(fire_pid).await?, "Approved");
    e.worker.fast_forward(5).await?;

    assert_eq!(e.status().await?, "Fired");
    assert!(e.key_list().await?.is_empty(), "no keys must remain");
    let dao_after = e.balance(e.dao.id()).await?;
    assert!(
        dao_after > dao_before,
        "DAO balance should increase: {dao_before} -> {dao_after}"
    );
    let reqs: Vec<Value> = e.mandate.view("get_requests").await?.json()?;
    assert_eq!(reqs[0]["state"], "Cancelled");

    // the agent key no longer works at all
    let err = e
        .agent
        .call(e.mandate.id(), "spend")
        .args_json(e.spend_args(10, "https://e/after-fire"))
        .gas(AGENT_GAS)
        .transact()
        .await
        .expect_err("a deleted key must be refused");
    let text = format!("{err:?}");
    println!("DELETED_KEY_ERROR: {text}");
    assert!(
        text.contains("InvalidAccessKeyError") && text.contains("AccessKeyNotFound"),
        "unexpected error: {text}"
    );

    // the DAO rejects the stale renewal proposal; its bond returns to the mandate;
    // sweep forwards it on, leaving only storage plus the buffer
    e.decide(renewal_pid, "VoteReject").await?;
    e.worker.fast_forward(5).await?;
    let before_sweep = e.balance(e.mandate.id()).await?;
    e.bob
        .call(e.mandate.id(), "sweep")
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    e.worker.fast_forward(5).await?;
    let acc = e.worker.view_account(e.mandate.id()).await?;
    let reserve = acc.storage_usage as u128 * STORAGE_BYTE_COST + GAS_BUFFER;
    assert!(
        acc.balance.as_yoctonear() <= reserve,
        "mandate balance {} should be <= storage+buffer {}",
        acc.balance.as_yoctonear(),
        reserve
    );
    assert!(
        acc.balance.as_yoctonear() < before_sweep,
        "sweep should have moved the refunded bond"
    );
    assert!(e.log_kinds().await?.contains(&"Swept".to_string()));
    Ok(())
}

#[tokio::test]
async fn renew_path() -> anyhow::Result<()> {
    let e = Env::setup().await?;
    e.hire(TERM_SECS, NearToken::from_near(10)).await?;
    assert_eq!(e.mandate_view().await?["term_number"], 1);

    e.advance_secs(TERM_SECS * 75 / 100).await?;
    let r = e
        .agent_call(
            "propose_renewal",
            json!({
                "report_text": "great term, renew me",
                "requested_term_secs": 300,
                "requested_topup": ONE.to_string()
            }),
        )
        .await?;
    assert!(r.is_success(), "propose_renewal failed: {}", failure_text(&r));
    let renewal: Value = e.mandate.view("get_renewal").await?.json()?;
    let pid = renewal["proposal_id"].as_u64().expect("renewal proposal id");

    e.decide(pid, "VoteApprove").await?;
    assert_eq!(e.proposal_status(pid).await?, "Approved");

    let v = e.mandate_view().await?;
    assert_eq!(v["term_number"], 2);
    assert_eq!(v["status"], "Active");
    assert_eq!(
        e.key_list().await?,
        vec![e.agent_sk.public_key().to_string()],
        "agent key must be present after renew"
    );

    // the re-added key restarts its nonce; the signer fetches a fresh one
    let r = e
        .agent_call("spend", e.spend_args(100, "https://e/term2"))
        .await?;
    assert!(r.is_success(), "spend after renew failed: {}", failure_text(&r));
    assert!(e.log_kinds().await?.contains(&"Renewed".to_string()));
    Ok(())
}

#[tokio::test]
async fn self_expire_path() -> anyhow::Result<()> {
    let e = Env::setup().await?;
    e.hire(TERM_SECS, NearToken::from_near(10)).await?;

    e.advance_secs(TERM_SECS + 5).await?;

    // the transaction lands (key still valid) but the contract refuses
    let r = e
        .agent_call("spend", e.spend_args(100, "https://e/late"))
        .await?;
    assert!(r.is_failure());
    assert!(
        failure_text(&r).contains("term ended"),
        "unexpected failure: {}",
        failure_text(&r)
    );

    // the agent closes out its own term
    let r = e.agent_call("expire", json!({})).await?;
    assert!(r.is_success(), "expire failed: {}", failure_text(&r));
    e.worker.fast_forward(3).await?;
    assert!(e.key_list().await?.is_empty());
    assert_eq!(e.status().await?, "Expired");
    Ok(())
}

#[tokio::test]
async fn approved_spend_after_fire_fails() -> anyhow::Result<()> {
    let e = Env::setup().await?;
    e.hire(TERM_SECS, NearToken::from_near(10)).await?;

    let r = e.agent_call("request_spend", e.big_request_args()).await?;
    assert!(r.is_success(), "request_spend failed: {}", failure_text(&r));
    let reqs: Vec<Value> = e.mandate.view("get_requests").await?.json()?;
    let spend_pid = reqs[0]["proposal_id"].as_u64().expect("proposal id saved");

    // fire first
    let fire_pid = e
        .propose(
            "fire",
            "fire",
            json!({ "reason": "changed our mind" }),
            NearToken::from_near(0),
        )
        .await?;
    e.decide(fire_pid, "VoteApprove").await?;
    assert_eq!(e.status().await?, "Fired");

    // then the DAO approves the old big-spend proposal: the call must fail, no money moves
    let payee_before = e.balance(e.payee.id()).await?;
    e.decide(spend_pid, "VoteApprove").await?;
    e.worker.fast_forward(3).await?;
    let status = e.proposal_status(spend_pid).await?;
    println!("SPEND_PROPOSAL_STATUS_AFTER_FIRE: {status}");
    assert_eq!(status, "Failed", "a fired agent's spend must not execute");
    assert_eq!(e.balance(e.payee.id()).await?, payee_before);
    let reqs: Vec<Value> = e.mandate.view("get_requests").await?.json()?;
    assert_eq!(reqs[0]["state"], "Cancelled");
    assert_eq!(e.mandate_view().await?["budget_spent"], "0");
    Ok(())
}
