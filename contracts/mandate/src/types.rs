use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, PublicKey};

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Clause {
    pub id: u8,
    pub text: String,
    pub max_amount: Option<U128>,
    pub pays: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mission {
    pub title: String,
    pub clauses: Vec<Clause>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Unhired,
    Active,
    Expired,
    Fired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Hired,
    Paid,
    PaidApproved,
    Requested,
    Work,
    RenewalProposed,
    Renewed,
    Expired,
    Fired,
    Swept,
    Released,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct LogEntry {
    pub index: u64,
    pub kind: EntryKind,
    pub clause_id: Option<u8>,
    pub amount: Option<U128>,
    pub recipient: Option<AccountId>,
    pub evidence_url: Option<String>,
    pub receipt_hash: Option<String>,
    pub note: Option<String>,
    pub timestamp_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestState {
    Pending,
    Executed,
    Cancelled,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SpendRequest {
    pub id: u32,
    pub recipient: AccountId,
    pub amount: U128,
    pub clause_id: u8,
    pub evidence_url: String,
    pub receipt_hash: String,
    pub rationale: String,
    pub proposal_id: Option<u64>,
    pub state: RequestState,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Renewal {
    pub report_text: String,
    pub report_hash: String,
    pub requested_term_secs: u64,
    pub requested_topup: U128,
    pub proposal_id: Option<u64>,
    pub timestamp_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MandateView {
    pub dao_id: AccountId,
    pub mission: Option<Mission>,
    pub status: Status,
    pub spend_threshold: U128,
    pub max_request: U128,
    pub term_start_ms: u64,
    pub term_end_ms: u64,
    pub term_number: u32,
    pub agent_key: Option<PublicKey>,
    pub budget_total: U128,
    pub budget_spent: U128,
    pub budget_available: U128,
}
