use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupSet, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PublicKey,
};

pub mod agent;
pub mod dao;
pub mod employer;
pub mod public;
pub mod types;

pub use types::*;

pub const AGENT_METHODS: &str = "spend,request_spend,log_work,propose_renewal,expire";
pub const KEY_ALLOWANCE: NearToken = NearToken::from_millinear(250);
pub const RENEWAL_WINDOW_PCT: u64 = 30;
pub const MAX_REPORT_BYTES: usize = 4096;
pub const GAS_BUFFER: NearToken = NearToken::from_millinear(100);

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    WorkLog,
    PaidRefs,
    Requests,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Mandate {
    pub dao_id: AccountId,
    pub proposal_bond: u128,
    pub mission: Option<Mission>,
    pub status: Status,
    pub spend_threshold: u128,
    pub max_request: u128,
    pub term_start_ms: u64,
    pub term_end_ms: u64,
    pub term_number: u32,
    pub agent_key: Option<PublicKey>,
    /// Key removed by expire/fire; lets a later `renew` re-add it when none is passed.
    pub retired_key: Option<PublicKey>,
    /// Total the DAO has put up for the agent: hire deposit plus renew top-ups.
    pub budget_total: u128,
    pub budget_spent: u128,
    pub work_log: Vector<LogEntry>,
    pub paid_refs: LookupSet<String>,
    pub requests: IterableMap<u32, SpendRequest>,
    pub next_request_id: u32,
    pub renewal: Option<Renewal>,
}

pub(crate) fn now_ms() -> u64 {
    env::block_timestamp() / 1_000_000
}

#[near]
impl Mandate {
    #[init]
    pub fn new(dao_id: AccountId, proposal_bond: U128) -> Self {
        Self {
            dao_id,
            proposal_bond: proposal_bond.0,
            mission: None,
            status: Status::Unhired,
            spend_threshold: 0,
            max_request: 0,
            term_start_ms: 0,
            term_end_ms: 0,
            term_number: 0,
            agent_key: None,
            retired_key: None,
            budget_total: 0,
            budget_spent: 0,
            work_log: Vector::new(StorageKey::WorkLog),
            paid_refs: LookupSet::new(StorageKey::PaidRefs),
            requests: IterableMap::new(StorageKey::Requests),
            next_request_id: 0,
            renewal: None,
        }
    }

    pub fn get_mandate(&self) -> MandateView {
        MandateView {
            dao_id: self.dao_id.clone(),
            mission: self.mission.clone(),
            status: self.status,
            spend_threshold: U128(self.spend_threshold),
            max_request: U128(self.max_request),
            term_start_ms: self.term_start_ms,
            term_end_ms: self.term_end_ms,
            term_number: self.term_number,
            agent_key: self.agent_key.clone(),
            budget_total: U128(self.budget_total),
            budget_spent: U128(self.budget_spent),
            budget_available: self.get_budget(),
        }
    }

    pub fn get_status(&self) -> Status {
        self.status
    }

    pub fn get_work_log(&self, from: u64, limit: u64) -> Vec<LogEntry> {
        let len = self.work_log.len() as u64;
        let end = from.saturating_add(limit).min(len);
        (from.min(len)..end)
            .filter_map(|i| self.work_log.get(i as u32).cloned())
            .collect()
    }

    pub fn get_requests(&self) -> Vec<SpendRequest> {
        self.requests.values().cloned().collect()
    }

    pub fn get_renewal(&self) -> Option<Renewal> {
        self.renewal.clone()
    }

    pub fn get_budget(&self) -> U128 {
        U128(self.budget_available())
    }
}

impl Mandate {
    pub(crate) fn assert_dao(&self) {
        require!(env::predecessor_account_id() == self.dao_id, "only the DAO");
    }

    /// Everything above the storage reserve and the gas buffer. Fire, release
    /// and sweep return all of it to the DAO.
    pub(crate) fn withdrawable(&self) -> u128 {
        let reserved = env::storage_byte_cost()
            .saturating_mul(env::storage_usage() as u128)
            .saturating_add(GAS_BUFFER);
        env::account_balance()
            .saturating_sub(reserved)
            .as_yoctonear()
    }

    /// What the agent may still spend: the lower of the funds actually held
    /// and what the DAO voted (`budget_total - budget_spent`).
    pub(crate) fn budget_available(&self) -> u128 {
        self.withdrawable()
            .min(self.budget_total.saturating_sub(self.budget_spent))
    }

    /// Appends a log entry, assigning its index.
    pub(crate) fn push_log(&mut self, mut entry: LogEntry) {
        entry.index = self.work_log.len() as u64;
        self.work_log.push(entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
    use near_sdk::testing_env;

    fn dao() -> AccountId {
        "dao.testnet".parse().unwrap()
    }
    fn key() -> PublicKey {
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .unwrap()
    }
    fn mission(n: usize) -> Mission {
        Mission {
            title: "Ship the thing".into(),
            clauses: (0..n)
                .map(|i| Clause {
                    id: i as u8,
                    text: "do work".into(),
                    max_amount: None,
                    pays: true,
                })
                .collect(),
        }
    }
    const T_NS: u64 = 1_700_000_000_000_000_000;

    fn ctx(pred: &str, deposit: NearToken) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("agent.testnet".parse().unwrap())
            .predecessor_account_id(pred.parse().unwrap())
            .attached_deposit(deposit)
            .account_balance(NearToken::from_near(5))
            .block_timestamp(T_NS);
        testing_env!(b.build());
    }
    fn fresh() -> Mandate {
        ctx("dao.testnet", NearToken::from_near(0));
        Mandate::new(dao(), U128(1))
    }
    fn do_hire(c: &mut Mandate) {
        ctx("dao.testnet", NearToken::from_near(2));
        c.hire(mission(1), U128(10), U128(100), 300, key());
    }

    #[test]
    #[should_panic(expected = "only the DAO")]
    fn hire_rejects_non_dao() {
        let mut c = fresh();
        ctx("bob.testnet", NearToken::from_near(2));
        c.hire(mission(1), U128(10), U128(100), 300, key());
    }

    #[test]
    fn hire_sets_active_term_and_log() {
        let mut c = fresh();
        do_hire(&mut c);
        assert_eq!(c.get_status(), Status::Active);
        let v = c.get_mandate();
        assert_eq!(v.term_end_ms, T_NS / 1_000_000 + 300_000);
        assert_eq!(v.term_number, 1);
        let log = c.get_work_log(0, 10);
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].kind, EntryKind::Hired);
        assert_eq!(log[0].index, 0);
    }

    #[test]
    fn hire_adds_function_call_key() {
        let mut c = fresh();
        do_hire(&mut c);
        let receipts = get_created_receipts();
        let adds: Vec<_> = receipts
            .iter()
            .flat_map(|r| r.actions.iter().map(move |a| (r, a)))
            .filter(|(_, a)| matches!(a, MockAction::AddKeyWithFunctionCall { .. }))
            .collect();
        assert_eq!(adds.len(), 1);
        let (r, a) = adds[0];
        assert_eq!(r.receiver_id.as_str(), "agent.testnet");
        if let MockAction::AddKeyWithFunctionCall {
            allowance,
            method_names,
            receiver_id,
            ..
        } = a
        {
            assert_eq!(*allowance, Some(KEY_ALLOWANCE));
            assert_eq!(receiver_id.as_str(), "agent.testnet");
            assert_eq!(
                method_names,
                &vec!["spend", "request_spend", "log_work", "propose_renewal", "expire"]
            );
        }
    }

    #[test]
    #[should_panic(expected = "already hired")]
    fn hire_rejects_when_active() {
        let mut c = fresh();
        do_hire(&mut c);
        do_hire(&mut c);
    }

    #[test]
    #[should_panic(expected = "mission needs at least one clause")]
    fn hire_rejects_empty_clauses() {
        let mut c = fresh();
        ctx("dao.testnet", NearToken::from_near(2));
        c.hire(mission(0), U128(10), U128(100), 300, key());
    }

    fn agent_ctx(pred: &str, pk: PublicKey, ts_ns: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("agent.testnet".parse().unwrap())
            .predecessor_account_id(pred.parse().unwrap())
            .signer_account_pk(pk)
            .attached_deposit(NearToken::from_near(0))
            .account_balance(NearToken::from_near(5))
            .block_timestamp(ts_ns);
        testing_env!(b.build());
    }
    fn other_key() -> PublicKey {
        "ed25519:3tysLvy7KGoE8pznUgXvSHa4vYyGvzKFnTkz2q8oRcZV"
            .parse()
            .unwrap()
    }
    fn hired() -> Mandate {
        let mut c = fresh();
        ctx("dao.testnet", NearToken::from_near(2));
        let mut m = mission(1);
        m.clauses.push(Clause {
            id: 1,
            text: "capped".into(),
            max_amount: Some(near_amt(50)),
            pays: true,
        });
        m.clauses.push(Clause {
            id: 2,
            text: "free work".into(),
            max_amount: None,
            pays: false,
        });
        c.hire(
            m,
            near_amt(200),
            U128(NearToken::from_near(1).as_yoctonear()),
            300,
            key(),
        );
        c
    }
    fn near_amt(milli: u128) -> U128 {
        U128(NearToken::from_millinear(milli).as_yoctonear())
    }
    fn bob() -> AccountId {
        "bob.testnet".parse().unwrap()
    }

    #[test]
    fn spend_pays_and_logs() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(100), 0, "https://e/1".into(), "h1".into());
        assert_eq!(c.budget_spent, near_amt(100).0);
        let log = c.get_work_log(0, 10);
        assert_eq!(log.len(), 2);
        assert_eq!(log[1].kind, EntryKind::Paid);
        assert_eq!(log[1].recipient, Some(bob()));
        assert_eq!(log[1].amount, Some(near_amt(100)));
        assert_eq!(log[1].clause_id, Some(0));
        let receipts = get_created_receipts();
        assert!(receipts.iter().any(|r| r.receiver_id.as_str() == "bob.testnet"
            && r.actions
                .iter()
                .any(|a| matches!(a, MockAction::Transfer { .. }))));
    }

    #[test]
    #[should_panic(expected = "over threshold")]
    fn spend_rejects_over_threshold() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(300), 0, "u".into(), "h".into());
    }

    #[test]
    #[should_panic(expected = "over clause max")]
    fn spend_rejects_over_clause_max() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(60), 1, "u".into(), "h".into());
    }

    #[test]
    #[should_panic(expected = "clause does not pay")]
    fn spend_rejects_non_paying_clause() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(10), 2, "u".into(), "h".into());
    }

    #[test]
    #[should_panic(expected = "unknown clause")]
    fn spend_rejects_unknown_clause() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(10), 9, "u".into(), "h".into());
    }

    #[test]
    #[should_panic(expected = "already paid")]
    fn spend_rejects_duplicate_evidence() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(10), 0, "same".into(), "h".into());
        c.spend(bob(), near_amt(10), 0, "same".into(), "h".into());
    }

    #[test]
    #[should_panic(expected = "term ended")]
    fn spend_rejects_after_term_end() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS + 301 * 1_000_000_000);
        c.spend(bob(), near_amt(10), 0, "u".into(), "h".into());
    }

    #[test]
    #[should_panic(expected = "agent only")]
    fn spend_rejects_wrong_signer_pk() {
        let mut c = hired();
        agent_ctx("agent.testnet", other_key(), T_NS);
        c.spend(bob(), near_amt(10), 0, "u".into(), "h".into());
    }

    #[test]
    #[should_panic(expected = "agent only")]
    fn spend_rejects_other_predecessor() {
        let mut c = hired();
        agent_ctx("bob.testnet", key(), T_NS);
        c.spend(bob(), near_amt(10), 0, "u".into(), "h".into());
    }

    const BOND: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR

    fn hired_big(max_request_milli: u128) -> Mandate {
        ctx("dao.testnet", NearToken::from_near(0));
        let mut c = Mandate::new(dao(), U128(BOND));
        ctx("dao.testnet", NearToken::from_near(2));
        c.hire(
            mission(1),
            near_amt(200),
            near_amt(max_request_milli),
            300,
            key(),
        );
        c
    }

    fn dao_ctx(balance: NearToken) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("agent.testnet".parse().unwrap())
            .predecessor_account_id(dao())
            .attached_deposit(NearToken::from_near(0))
            .account_balance(balance)
            .block_timestamp(T_NS);
        testing_env!(b.build());
    }

    fn request(c: &mut Mandate, milli: u128, evidence: &str) {
        agent_ctx("agent.testnet", key(), T_NS);
        let _ = c.request_spend(
            bob(),
            near_amt(milli),
            0,
            evidence.into(),
            "h".into(),
            "because".into(),
        );
    }

    #[test]
    #[should_panic(expected = "use spend")]
    fn request_spend_requires_over_threshold() {
        let mut c = hired_big(500);
        request(&mut c, 150, "u");
    }

    #[test]
    #[should_panic(expected = "over max request")]
    fn request_spend_caps_max_request() {
        let mut c = hired_big(500);
        request(&mut c, 600, "u");
    }

    #[test]
    fn request_spend_creates_pending_request_and_dao_receipt() {
        let mut c = hired_big(500);
        request(&mut c, 400, "https://e/big");
        let reqs = c.get_requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].state, RequestState::Pending);
        assert_eq!(reqs[0].amount, near_amt(400));
        assert_eq!(c.get_work_log(0, 10)[1].kind, EntryKind::Requested);
        let receipts = get_created_receipts();
        let r = receipts
            .iter()
            .find(|r| r.receiver_id.as_str() == "dao.testnet")
            .expect("receipt to dao");
        assert!(r.actions.iter().any(|a| matches!(
            a,
            MockAction::FunctionCallWeight { method_name, attached_deposit, args, .. }
                if method_name == b"add_proposal"
                    && attached_deposit.as_yoctonear() == BOND
                    && String::from_utf8_lossy(args).contains("execute_approved_spend")
        )));
    }

    #[test]
    #[should_panic(expected = "already paid")]
    fn request_spend_rejects_paid_evidence() {
        let mut c = hired_big(500);
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(10), 0, "same".into(), "h".into());
        request(&mut c, 400, "same");
    }

    #[test]
    fn on_proposal_added_saves_id_or_cancels() {
        let mut c = hired_big(500);
        request(&mut c, 400, "a");
        ctx("agent.testnet", NearToken::from_near(0));
        c.on_proposal_added(0, Ok(7));
        assert_eq!(c.get_requests()[0].proposal_id, Some(7));
        request(&mut c, 400, "b");
        ctx("agent.testnet", NearToken::from_near(0));
        c.on_proposal_added(1, Err(near_sdk::PromiseError::Failed));
        let reqs = c.get_requests();
        assert_eq!(reqs[1].state, RequestState::Cancelled);
        assert_eq!(c.get_work_log(0, 10).last().unwrap().kind, EntryKind::Work);
    }

    #[test]
    fn execute_approved_spend_pays_once() {
        let mut c = hired_big(500);
        request(&mut c, 400, "https://e/big");
        dao_ctx(NearToken::from_near(5));
        c.execute_approved_spend(0);
        assert_eq!(c.get_requests()[0].state, RequestState::Executed);
        assert_eq!(c.budget_spent, near_amt(400).0);
        assert!(c.paid_refs.contains(&"https://e/big".to_string()));
        assert_eq!(c.get_work_log(0, 10).last().unwrap().kind, EntryKind::PaidApproved);
        assert!(get_created_receipts().iter().any(|r| r.receiver_id.as_str()
            == "bob.testnet"
            && r.actions
                .iter()
                .any(|a| matches!(a, MockAction::Transfer { .. }))));
    }

    #[test]
    #[should_panic(expected = "not pending")]
    fn execute_approved_spend_twice_panics() {
        let mut c = hired_big(500);
        request(&mut c, 400, "u");
        dao_ctx(NearToken::from_near(5));
        c.execute_approved_spend(0);
        c.execute_approved_spend(0);
    }

    #[test]
    #[should_panic(expected = "insufficient budget")]
    fn execute_approved_spend_panics_when_budget_insufficient() {
        let mut c = hired_big(500);
        request(&mut c, 400, "u");
        dao_ctx(NearToken::from_millinear(300));
        c.execute_approved_spend(0);
    }

    #[test]
    #[should_panic(expected = "only the DAO")]
    fn execute_approved_spend_rejects_non_dao() {
        let mut c = hired_big(500);
        request(&mut c, 400, "u");
        ctx("bob.testnet", NearToken::from_near(0));
        c.execute_approved_spend(0);
    }

    #[test]
    fn request_spend_description_uses_termwork_prefix() {
        let mut c = hired_big(500);
        request(&mut c, 400, "https://e/big");
        let receipts = get_created_receipts();
        let r = receipts
            .iter()
            .find(|r| r.receiver_id.as_str() == "dao.testnet")
            .unwrap();
        let ok = r.actions.iter().any(|a| matches!(
            a,
            MockAction::FunctionCallWeight { args, .. }
                if {
                    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
                    let d = v["proposal"]["description"].as_str().unwrap();
                    d.starts_with("Termwork: ") && d.contains("#0") && d.contains("0.4 NEAR")
                }
        ));
        assert!(ok);
    }

    #[test]
    #[should_panic(expected = "over clause max")]
    fn request_spend_rejects_over_clause_max() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS);
        let _ = c.request_spend(bob(), near_amt(300), 1, "u".into(), "h".into(), "r".into());
    }

    #[test]
    #[should_panic(expected = "insufficient budget")]
    fn request_spend_rejects_insufficient_budget() {
        let mut c = hired_big(500);
        let mut b = VMContextBuilder::new();
        b.current_account_id("agent.testnet".parse().unwrap())
            .predecessor_account_id("agent.testnet".parse().unwrap())
            .signer_account_pk(key())
            .account_balance(NearToken::from_millinear(300))
            .block_timestamp(T_NS);
        testing_env!(b.build());
        let _ = c.request_spend(bob(), near_amt(400), 0, "u".into(), "h".into(), "r".into());
    }

    #[test]
    #[should_panic(expected = "already paid")]
    fn execute_approved_spend_rejects_already_paid_evidence() {
        let mut c = hired_big(500);
        request(&mut c, 400, "x");
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(10), 0, "x".into(), "h".into());
        dao_ctx(NearToken::from_near(5));
        c.execute_approved_spend(0);
    }

    #[test]
    fn log_work_appends_entry() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS);
        c.log_work(2, "did a thing".into(), Some("https://e/w".into()), None);
        let log = c.get_work_log(0, 10);
        assert_eq!(log.len(), 2);
        assert_eq!(log[1].kind, EntryKind::Work);
        assert_eq!(log[1].clause_id, Some(2));
        assert_eq!(log[1].note.as_deref(), Some("did a thing"));
        assert_eq!(log[1].evidence_url.as_deref(), Some("https://e/w"));
        assert_eq!(c.budget_spent, 0);
    }

    // ---- Task 5: renewal, renew, fire, expire, sweep, release ----

    fn dao_at(ts_ns: u64, deposit: NearToken) {
        let mut b = VMContextBuilder::new();
        b.current_account_id("agent.testnet".parse().unwrap())
            .predecessor_account_id(dao())
            .attached_deposit(deposit)
            .account_balance(NearToken::from_near(5))
            .block_timestamp(ts_ns);
        testing_env!(b.build());
    }
    fn secs(n: u64) -> u64 {
        n * 1_000_000_000
    }

    #[test]
    #[should_panic(expected = "renewal window not open")]
    fn propose_renewal_rejects_before_window() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS + secs(100));
        let _ = c.propose_renewal("report".into(), 600, near_amt(500));
    }

    #[test]
    #[should_panic(expected = "report too long")]
    fn propose_renewal_rejects_oversized_report() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS + secs(250));
        let _ = c.propose_renewal("a".repeat(4097), 600, near_amt(500));
    }

    #[test]
    fn propose_renewal_stores_text_and_hash() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS + secs(250));
        let _ = c.propose_renewal("hello".into(), 600, near_amt(500));
        let r = c.get_renewal().unwrap();
        assert_eq!(r.report_text, "hello");
        assert_eq!(
            r.report_hash,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(r.requested_term_secs, 600);
        assert_eq!(r.requested_topup, near_amt(500));
        assert_eq!(
            c.get_work_log(0, 10).last().unwrap().kind,
            EntryKind::RenewalProposed
        );
        let receipts = get_created_receipts();
        let rc = receipts
            .iter()
            .find(|r| r.receiver_id.as_str() == "dao.testnet")
            .expect("receipt to dao");
        assert!(rc.actions.iter().any(|a| matches!(
            a,
            MockAction::FunctionCallWeight { args, .. }
                if {
                    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
                    let d = v["proposal"]["description"].as_str().unwrap();
                    d.starts_with("Termwork: renewal for term #1")
                        && d.contains("report hash 2cf24dba")
                        && v["proposal"]["kind"]["FunctionCall"]["actions"][0]["method_name"] == "renew"
                }
        )));
        ctx("agent.testnet", NearToken::from_near(0));
        c.on_renewal_proposal_added(HELLO_HASH.into(), RENEWAL_TS_MS, Ok(9));
        assert_eq!(c.get_renewal().unwrap().proposal_id, Some(9));
    }

    #[test]
    fn renew_extends_term_and_rekeys() {
        let mut c = hired();
        dao_at(T_NS + secs(250), NearToken::from_near(1));
        c.renew(600, Some(other_key()));
        let v = c.get_mandate();
        assert_eq!(v.term_number, 2);
        assert_eq!(v.term_end_ms, (T_NS + secs(250)) / 1_000_000 + 600_000);
        assert_eq!(v.agent_key, Some(other_key()));
        assert_eq!(c.get_work_log(0, 10).last().unwrap().kind, EntryKind::Renewed);
        let receipts = get_created_receipts();
        let acts: Vec<_> = receipts
            .iter()
            .filter(|r| r.receiver_id.as_str() == "agent.testnet")
            .flat_map(|r| r.actions.iter())
            .collect();
        assert!(matches!(acts[0], MockAction::DeleteKey { .. }));
        assert!(matches!(acts[1], MockAction::AddKeyWithFunctionCall { .. }));
    }

    #[test]
    fn fire_deletes_key_cancels_requests_and_returns_budget() {
        let mut c = hired_big(500);
        request(&mut c, 400, "https://e/big");
        dao_ctx(NearToken::from_near(5));
        c.fire("not delivering".into());
        assert_eq!(c.get_status(), Status::Fired);
        assert_eq!(c.get_mandate().agent_key, None);
        assert_eq!(c.get_requests()[0].state, RequestState::Cancelled);
        assert_eq!(c.get_work_log(0, 10).last().unwrap().kind, EntryKind::Fired);
        let receipts = get_created_receipts();
        assert!(receipts
            .iter()
            .any(|r| r.actions.iter().any(|a| matches!(a, MockAction::DeleteKey { .. }))));
        assert!(receipts.iter().any(|r| r.receiver_id.as_str() == "dao.testnet"
            && r.actions
                .iter()
                .any(|a| matches!(a, MockAction::Transfer { .. }))));
    }

    #[test]
    #[should_panic(expected = "agent only")]
    fn fire_then_agent_spend_panics() {
        let mut c = hired();
        dao_ctx(NearToken::from_near(5));
        c.fire("bye".into());
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(10), 0, "u".into(), "h".into());
    }

    #[test]
    #[should_panic(expected = "agent was fired")]
    fn fire_then_execute_approved_spend_panics() {
        let mut c = hired_big(500);
        dao_ctx(NearToken::from_near(5));
        c.fire("bye".into());
        c.execute_approved_spend(0);
    }

    #[test]
    #[should_panic(expected = "term not ended")]
    fn expire_requires_term_end() {
        let mut c = hired();
        ctx("anyone.testnet", NearToken::from_near(0));
        c.expire();
    }

    #[test]
    fn expire_deletes_key_and_sets_expired() {
        let mut c = hired();
        agent_ctx("bob.testnet", other_key(), T_NS + secs(301));
        c.expire();
        assert_eq!(c.get_status(), Status::Expired);
        assert_eq!(c.get_mandate().agent_key, None);
        assert_eq!(c.get_work_log(0, 10).last().unwrap().kind, EntryKind::Expired);
        assert!(get_created_receipts()
            .iter()
            .any(|r| r.actions.iter().any(|a| matches!(a, MockAction::DeleteKey { .. }))));
    }

    #[test]
    fn renew_after_expire_only_adds_key() {
        let mut c = hired();
        agent_ctx("bob.testnet", other_key(), T_NS + secs(301));
        c.expire();
        dao_at(T_NS + secs(400), NearToken::from_near(0));
        c.renew(600, None);
        assert_eq!(c.get_status(), Status::Active);
        assert_eq!(c.get_mandate().agent_key, Some(key()));
        let receipts = get_created_receipts();
        let acts: Vec<_> = receipts.iter().flat_map(|r| r.actions.iter()).collect();
        assert_eq!(acts.len(), 1);
        assert!(matches!(acts[0], MockAction::AddKeyWithFunctionCall { .. }));
    }

    #[test]
    #[should_panic(expected = "not fired")]
    fn sweep_only_when_fired() {
        let mut c = hired();
        ctx("anyone.testnet", NearToken::from_near(0));
        c.sweep();
    }

    #[test]
    fn sweep_after_fire_transfers_to_dao() {
        let mut c = hired();
        dao_ctx(NearToken::from_near(5));
        c.fire("bye".into());
        ctx("anyone.testnet", NearToken::from_near(0));
        c.sweep();
        assert_eq!(c.get_work_log(0, 10).last().unwrap().kind, EntryKind::Swept);
        assert!(get_created_receipts()
            .iter()
            .any(|r| r.receiver_id.as_str() == "dao.testnet"
                && r.actions
                    .iter()
                    .any(|a| matches!(a, MockAction::Transfer { .. }))));
    }

    #[test]
    #[should_panic(expected = "not expired")]
    fn release_only_when_expired() {
        let mut c = hired();
        dao_ctx(NearToken::from_near(5));
        c.release();
    }

    #[test]
    fn release_after_expire_transfers_to_dao() {
        let mut c = hired();
        agent_ctx("bob.testnet", other_key(), T_NS + secs(301));
        c.expire();
        dao_at(T_NS + secs(310), NearToken::from_near(0));
        c.release();
        assert_eq!(c.get_work_log(0, 10).last().unwrap().kind, EntryKind::Released);
        assert!(get_created_receipts()
            .iter()
            .any(|r| r.receiver_id.as_str() == "dao.testnet"
                && r.actions
                    .iter()
                    .any(|a| matches!(a, MockAction::Transfer { .. }))));
    }

    // ---- Final review fixes: single renewal, stale callbacks, budget cap ----

    const HELLO_HASH: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const RENEWAL_TS_MS: u64 = (T_NS + 250 * 1_000_000_000) / 1_000_000;

    #[test]
    #[should_panic(expected = "renewal already proposed")]
    fn propose_renewal_rejects_second_call() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS + secs(250));
        let _ = c.propose_renewal("hello".into(), 600, near_amt(500));
        agent_ctx("agent.testnet", key(), T_NS + secs(260));
        let _ = c.propose_renewal("other".into(), 600, near_amt(500));
    }

    #[test]
    fn propose_renewal_allowed_again_after_failed_callback() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS + secs(250));
        let _ = c.propose_renewal("hello".into(), 600, near_amt(500));
        ctx("agent.testnet", NearToken::from_near(0));
        c.on_renewal_proposal_added(
            HELLO_HASH.into(),
            RENEWAL_TS_MS,
            Err(near_sdk::PromiseError::Failed),
        );
        assert!(c.get_renewal().is_none());
        agent_ctx("agent.testnet", key(), T_NS + secs(260));
        let _ = c.propose_renewal("again".into(), 600, near_amt(500));
        assert_eq!(c.get_renewal().unwrap().report_text, "again");
    }

    #[test]
    fn stale_renewal_callback_does_not_touch_newer_renewal() {
        let mut c = hired();
        agent_ctx("agent.testnet", key(), T_NS + secs(250));
        let _ = c.propose_renewal("hello".into(), 600, near_amt(500));
        // Newer renewal replaces it (the first one failed and was cleared).
        c.renewal = None;
        agent_ctx("agent.testnet", key(), T_NS + secs(260));
        let _ = c.propose_renewal("newer".into(), 600, near_amt(500));
        ctx("agent.testnet", NearToken::from_near(0));
        // Late callbacks for the first call: neither id nor error may land on the newer one.
        c.on_renewal_proposal_added(HELLO_HASH.into(), RENEWAL_TS_MS, Ok(3));
        assert_eq!(c.get_renewal().unwrap().proposal_id, None);
        c.on_renewal_proposal_added(
            HELLO_HASH.into(),
            RENEWAL_TS_MS,
            Err(near_sdk::PromiseError::Failed),
        );
        assert_eq!(c.get_renewal().unwrap().report_text, "newer");
    }

    #[test]
    #[should_panic(expected = "cannot renew")]
    fn renew_after_fire_panics() {
        let mut c = hired();
        dao_ctx(NearToken::from_near(5));
        c.fire("bye".into());
        dao_at(T_NS + secs(10), NearToken::from_near(1));
        c.renew(600, None);
    }

    #[test]
    fn hire_sets_budget_total_to_deposit() {
        let c = hired();
        let v = c.get_mandate();
        assert_eq!(v.budget_total.0, NearToken::from_near(2).as_yoctonear());
        assert_eq!(v.budget_spent.0, 0);
        // Balance (5 NEAR) is higher than the voted 2 NEAR; the cap wins.
        assert_eq!(v.budget_available.0, NearToken::from_near(2).as_yoctonear());
    }

    #[test]
    fn renew_adds_topup_to_budget_total() {
        let mut c = hired();
        dao_at(T_NS + secs(250), NearToken::from_near(1));
        c.renew(600, Some(other_key()));
        assert_eq!(
            c.get_mandate().budget_total.0,
            NearToken::from_near(3).as_yoctonear()
        );
    }

    fn hired_small(deposit_milli: u128) -> Mandate {
        let mut c = fresh();
        let mut b = VMContextBuilder::new();
        b.current_account_id("agent.testnet".parse().unwrap())
            .predecessor_account_id(dao())
            .attached_deposit(NearToken::from_millinear(deposit_milli))
            .account_balance(NearToken::from_near(5))
            .block_timestamp(T_NS);
        testing_env!(b.build());
        c.hire(mission(1), near_amt(200), near_amt(500), 300, key());
        c
    }

    #[test]
    #[should_panic(expected = "insufficient budget")]
    fn spend_beyond_budget_total_rejected_even_with_higher_balance() {
        let mut c = hired_small(100);
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(150), 0, "u".into(), "h".into());
    }

    #[test]
    fn spend_up_to_budget_total_then_rejected() {
        let mut c = hired_small(300);
        agent_ctx("agent.testnet", key(), T_NS);
        c.spend(bob(), near_amt(200), 0, "a".into(), "h".into());
        assert_eq!(c.get_mandate().budget_available.0, near_amt(100).0);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.spend(bob(), near_amt(150), 0, "b".into(), "h".into());
        }));
        assert!(r.is_err());
    }

    #[test]
    #[should_panic(expected = "insufficient budget")]
    fn request_spend_counts_bond_against_budget_total() {
        // Budget 0.45 NEAR: a 0.4 NEAR request plus the 0.1 NEAR bond does not fit.
        ctx("dao.testnet", NearToken::from_near(0));
        let mut c = Mandate::new(dao(), U128(BOND));
        let mut b = VMContextBuilder::new();
        b.current_account_id("agent.testnet".parse().unwrap())
            .predecessor_account_id(dao())
            .attached_deposit(NearToken::from_millinear(450))
            .account_balance(NearToken::from_near(5))
            .block_timestamp(T_NS);
        testing_env!(b.build());
        c.hire(mission(1), near_amt(200), near_amt(500), 300, key());
        request(&mut c, 400, "u");
    }

    #[test]
    #[should_panic(expected = "insufficient budget")]
    fn execute_approved_spend_respects_budget_total() {
        let mut c = hired_big(500);
        request(&mut c, 400, "u");
        c.budget_spent = NearToken::from_millinear(1800).as_yoctonear();
        dao_ctx(NearToken::from_near(5));
        c.execute_approved_spend(0);
    }

    #[test]
    fn fire_returns_everything_above_reserve_not_only_budget() {
        let mut c = hired_small(300);
        dao_ctx(NearToken::from_near(5));
        let expected = c.withdrawable();
        assert!(expected > c.get_mandate().budget_total.0);
        c.fire("done".into());
        let log = c.get_work_log(0, 10);
        assert_eq!(log.last().unwrap().amount.unwrap().0, expected);
    }
}
