use near_sdk::json_types::U128;
use near_sdk::{env, near, require, Allowance, Promise, PublicKey};

use crate::types::*;
use crate::*;

#[near]
impl Mandate {
    /// DAO hires the agent for a term. Adds the agent's function-call key to this account.
    /// Allowed from Unhired, Expired or Fired; rejected while Active.
    #[payable]
    pub fn hire(
        &mut self,
        mission: Mission,
        spend_threshold: U128,
        max_request: U128,
        term_secs: u64,
        agent_public_key: PublicKey,
    ) {
        self.assert_dao();
        require!(self.status != Status::Active, "already hired");
        require!(
            !mission.clauses.is_empty(),
            "mission needs at least one clause"
        );
        require!(term_secs > 0, "term must be positive");

        let now = now_ms();
        let title = mission.title.clone();
        self.mission = Some(mission);
        self.spend_threshold = spend_threshold.0;
        self.max_request = max_request.0;
        self.term_start_ms = now;
        self.term_end_ms = now + term_secs * 1_000;
        self.term_number += 1;
        self.status = Status::Active;
        self.budget_spent = 0;
        self.agent_key = Some(agent_public_key.clone());
        self.renewal = None;

        self.push_log(LogEntry {
            index: 0,
            kind: EntryKind::Hired,
            clause_id: None,
            amount: Some(U128(env::attached_deposit().as_yoctonear())),
            recipient: None,
            evidence_url: None,
            receipt_hash: None,
            note: Some(title),
            timestamp_ms: now,
        });

        let _ = Promise::new(env::current_account_id()).add_access_key_allowance(
            agent_public_key,
            Allowance::limited(KEY_ALLOWANCE).expect("allowance must be non-zero"),
            env::current_account_id(),
            AGENT_METHODS.to_string(),
        );
    }
}
