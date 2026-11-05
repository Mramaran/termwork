use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupSet, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PublicKey,
};

pub mod agent;
pub mod dao;
pub mod employer;
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

    pub(crate) fn budget_available(&self) -> u128 {
        let reserved = env::storage_byte_cost()
            .saturating_mul(env::storage_usage() as u128)
            .saturating_add(GAS_BUFFER);
        env::account_balance()
            .saturating_sub(reserved)
            .as_yoctonear()
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
}
