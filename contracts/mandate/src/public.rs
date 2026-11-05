use near_sdk::json_types::U128;
use near_sdk::{env, near, require, NearToken, Promise};

use crate::types::*;
use crate::*;

#[near]
impl Mandate {
    /// Anyone (or the agent key) can close out a term once it has ended.
    /// Deletes the agent key and marks the mandate Expired.
    pub fn expire(&mut self) {
        require!(self.status == Status::Active, "not active");
        require!(now_ms() >= self.term_end_ms, "term not ended");
        if let Some(k) = self.agent_key.take() {
            let _ = Promise::new(env::current_account_id()).delete_key(k.clone());
            self.retired_key = Some(k);
        }
        self.status = Status::Expired;
        self.push_log(LogEntry {
            index: 0,
            kind: EntryKind::Expired,
            clause_id: None,
            amount: None,
            recipient: None,
            evidence_url: None,
            receipt_hash: None,
            note: None,
            timestamp_ms: now_ms(),
        });
    }

    /// Anyone can forward leftover funds (e.g. a returned proposal bond) to the DAO after a fire.
    pub fn sweep(&mut self) {
        require!(self.status == Status::Fired, "not fired");
        let amount = self.withdrawable();
        if amount > 0 {
            self.push_log(LogEntry {
                index: 0,
                kind: EntryKind::Swept,
                clause_id: None,
                amount: Some(U128(amount)),
                recipient: Some(self.dao_id.clone()),
                evidence_url: None,
                receipt_hash: None,
                note: None,
                timestamp_ms: now_ms(),
            });
            let _ = Promise::new(self.dao_id.clone()).transfer(NearToken::from_yoctonear(amount));
        }
    }
}
