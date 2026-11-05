use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupSet, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PublicKey,
};

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
    #[should_panic]
    fn hire_rejects_empty_clauses() {
        let mut c = fresh();
        ctx("dao.testnet", NearToken::from_near(2));
        c.hire(mission(0), U128(10), U128(100), 300, key());
    }
}
