use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise, PromiseError};

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

    pub(crate) fn find_clause(&self, clause_id: u8) -> &Clause {
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

    /// Agent writes its own renewal case inside the last 30% of the term and
    /// files it as a DAO proposal.
    pub fn propose_renewal(
        &mut self,
        report_text: String,
        requested_term_secs: u64,
        requested_topup: U128,
    ) -> Promise {
        self.assert_agent_active();
        require!(report_text.len() <= MAX_REPORT_BYTES, "report too long");
        require!(requested_term_secs > 0, "term must be positive");
        let now = now_ms();
        let term_ms = self.term_end_ms - self.term_start_ms;
        let window_start = self.term_end_ms - term_ms * RENEWAL_WINDOW_PCT / 100;
        require!(now >= window_start, "renewal window not open");
        require!(
            self.proposal_bond <= self.budget_available(),
            "insufficient budget"
        );

        let report_hash: String = env::sha256(report_text.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        self.renewal = Some(Renewal {
            report_text,
            report_hash: report_hash.clone(),
            requested_term_secs,
            requested_topup,
            proposal_id: None,
            timestamp_ms: now,
        });
        self.push_log(LogEntry {
            index: 0,
            kind: EntryKind::RenewalProposed,
            clause_id: None,
            amount: Some(requested_topup),
            recipient: None,
            evidence_url: None,
            receipt_hash: Some(report_hash.clone()),
            note: Some(format!("{requested_term_secs} s requested")),
            timestamp_ms: now,
        });

        let description = format!(
            "Termwork: renewal for term #{} — report hash {}",
            self.term_number, report_hash
        );
        let args = json!({ "term_secs": requested_term_secs, "agent_public_key": null })
            .to_string()
            .into_bytes();
        crate::dao::add_proposal_with_deposit(
            self.dao_id.clone(),
            description,
            "renew",
            args,
            NearToken::from_yoctonear(self.proposal_bond),
            NearToken::from_yoctonear(requested_topup.0),
        )
        .then(Promise::new(env::current_account_id()).function_call(
            "on_renewal_proposal_added".to_string(),
            b"{}".to_vec(),
            NearToken::from_yoctonear(0),
            crate::dao::GAS_CALLBACK,
        ))
    }

    #[private]
    pub fn on_renewal_proposal_added(
        &mut self,
        #[callback_result] r: Result<u64, PromiseError>,
    ) {
        if let Some(rn) = self.renewal.as_mut() {
            match r {
                Ok(id) => rn.proposal_id = Some(id),
                Err(_) => self.renewal = None,
            }
        }
    }
}
