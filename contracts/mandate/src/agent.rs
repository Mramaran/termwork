use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::types::*;
use crate::*;

impl Mandate {
    /// Guard for agent methods: signed by the agent's own function-call key.
    /// Contract callbacks also have predecessor == current account, so the
    /// signer key is checked too.
    pub(crate) fn assert_agent_active(&self) {
        require!(
            env::predecessor_account_id() == env::current_account_id()
                && self.agent_key.as_ref() == Some(&env::signer_account_pk()),
            "agent only"
        );
        require!(self.status == Status::Active, "not active");
        require!(now_ms() < self.term_end_ms, "term ended");
    }

    fn find_clause(&self, clause_id: u8) -> &Clause {
        self.mission
            .as_ref()
            .and_then(|m| m.clauses.iter().find(|c| c.id == clause_id))
            .unwrap_or_else(|| env::panic_str("unknown clause"))
    }
}

#[near]
impl Mandate {
    /// Agent pays a recipient under a paying clause, within all caps.
    pub fn spend(
        &mut self,
        recipient: AccountId,
        amount: U128,
        clause_id: u8,
        evidence_url: String,
        receipt_hash: String,
    ) {
        self.assert_agent_active();
        let clause = self.find_clause(clause_id);
        require!(clause.pays, "clause does not pay");
        if let Some(max) = clause.max_amount {
            require!(amount.0 <= max.0, "over clause max");
        }
        require!(amount.0 <= self.spend_threshold, "over threshold");
        require!(amount.0 <= self.budget_available(), "insufficient budget");
        require!(self.paid_refs.insert(evidence_url.clone()), "already paid");

        self.budget_spent += amount.0;
        self.push_log(LogEntry {
            index: 0,
            kind: EntryKind::Paid,
            clause_id: Some(clause_id),
            amount: Some(amount),
            recipient: Some(recipient.clone()),
            evidence_url: Some(evidence_url),
            receipt_hash: Some(receipt_hash),
            note: None,
            timestamp_ms: now_ms(),
        });
        let _ = Promise::new(recipient).transfer(NearToken::from_yoctonear(amount.0));
    }

    /// Agent records work against a clause. Moves no money.
    pub fn log_work(
        &mut self,
        clause_id: u8,
        summary: String,
        evidence_url: Option<String>,
        receipt_hash: Option<String>,
    ) {
        self.assert_agent_active();
        let _ = self.find_clause(clause_id);
        self.push_log(LogEntry {
            index: 0,
            kind: EntryKind::Work,
            clause_id: Some(clause_id),
            amount: None,
            recipient: None,
            evidence_url,
            receipt_hash,
            note: Some(summary),
            timestamp_ms: now_ms(),
        });
    }
}
