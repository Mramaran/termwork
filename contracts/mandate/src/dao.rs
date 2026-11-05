use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

use crate::types::*;
use crate::*;

pub const GAS_ADD_PROPOSAL: Gas = Gas::from_tgas(30);
pub const GAS_CALLBACK: Gas = Gas::from_tgas(10);
/// Gas the DAO attaches to the approved function call back into this contract.
pub const GAS_PROPOSAL_ACTION: &str = "50000000000000";

/// Files a Sputnik v2 `FunctionCall` proposal that calls `method` on this contract.
pub fn add_proposal(
    dao_id: AccountId,
    description: String,
    method: &str,
    args: Vec<u8>,
    bond: NearToken,
) -> Promise {
    add_proposal_with_deposit(dao_id, description, method, args, bond, NearToken::from_yoctonear(0))
}

/// Like `add_proposal`, but the approved call attaches `action_deposit` from the DAO.
pub fn add_proposal_with_deposit(
    dao_id: AccountId,
    description: String,
    method: &str,
    args: Vec<u8>,
    bond: NearToken,
    action_deposit: NearToken,
) -> Promise {
    let body = json!({
        "proposal": {
            "description": description,
            "kind": {
                "FunctionCall": {
                    "receiver_id": env::current_account_id(),
                    "actions": [{
                        "method_name": method,
                        "args": Base64VecU8::from(args),
                        "deposit": action_deposit.as_yoctonear().to_string(),
                        "gas": GAS_PROPOSAL_ACTION,
                    }]
                }
            }
        }
    });
    Promise::new(dao_id).function_call(
        "add_proposal".to_string(),
        body.to_string().into_bytes(),
        bond,
        GAS_ADD_PROPOSAL,
    )
}

/// Yocto amount as a plain decimal NEAR string, e.g. "0.6".
pub fn fmt_near(yocto: u128) -> String {
    const ONE: u128 = 1_000_000_000_000_000_000_000_000;
    let whole = yocto / ONE;
    let frac = format!("{:024}", yocto % ONE);
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{frac}")
    }
}

#[near]
impl Mandate {
    /// Agent asks the DAO to approve a payment above the per-transaction threshold.
    /// The contract pays the proposal bond from its own balance.
    pub fn request_spend(
        &mut self,
        recipient: AccountId,
        amount: U128,
        clause_id: u8,
        evidence_url: String,
        receipt_hash: String,
        rationale: String,
    ) -> Promise {
        self.assert_agent_active();
        let clause = self.find_clause(clause_id);
        require!(clause.pays, "clause does not pay");
        if let Some(max) = clause.max_amount {
            require!(amount.0 <= max.0, "over clause max");
        }
        require!(amount.0 > self.spend_threshold, "use spend");
        require!(amount.0 <= self.max_request, "over max request");
        require!(
            amount
                .0
                .checked_add(self.proposal_bond)
                .map_or(false, |need| need <= self.budget_available()),
            "insufficient budget"
        );
        require!(!self.paid_refs.contains(&evidence_url), "already paid");

        let id = self.next_request_id;
        self.next_request_id += 1;
        self.requests.insert(
            id,
            SpendRequest {
                id,
                recipient: recipient.clone(),
                amount,
                clause_id,
                evidence_url: evidence_url.clone(),
                receipt_hash: receipt_hash.clone(),
                rationale: rationale.clone(),
                proposal_id: None,
                state: RequestState::Pending,
            },
        );
        self.push_log(LogEntry {
            index: 0,
            kind: EntryKind::Requested,
            clause_id: Some(clause_id),
            amount: Some(amount),
            recipient: Some(recipient.clone()),
            evidence_url: Some(evidence_url.clone()),
            receipt_hash: Some(receipt_hash),
            note: Some(rationale.clone()),
            timestamp_ms: now_ms(),
        });

        let description = format!(
            "Termwork: big spend #{} — {} NEAR to {} for {}. Rationale: {}",
            id,
            fmt_near(amount.0),
            recipient,
            evidence_url,
            rationale
        );
        let args = json!({ "request_id": id }).to_string().into_bytes();
        add_proposal(
            self.dao_id.clone(),
            description,
            "execute_approved_spend",
            args,
            NearToken::from_yoctonear(self.proposal_bond),
        )
        .then(Promise::new(env::current_account_id()).function_call(
            "on_proposal_added".to_string(),
            json!({ "request_id": id }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_CALLBACK,
        ))
    }

    #[private]
    pub fn on_proposal_added(
        &mut self,
        request_id: u32,
        #[callback_result] r: Result<u64, PromiseError>,
    ) {
        let Some(mut req) = self.requests.get(&request_id).cloned() else {
            return;
        };
        match r {
            Ok(proposal_id) => {
                req.proposal_id = Some(proposal_id);
                self.requests.insert(request_id, req);
            }
            Err(_) => {
                let (clause_id, amount, recipient) =
                    (req.clause_id, req.amount, req.recipient.clone());
                req.state = RequestState::Cancelled;
                self.requests.insert(request_id, req);
                self.push_log(LogEntry {
                    index: 0,
                    kind: EntryKind::Work,
                    clause_id: Some(clause_id),
                    amount: Some(amount),
                    recipient: Some(recipient),
                    evidence_url: None,
                    receipt_hash: None,
                    note: Some(format!(
                        "Big-spend request #{request_id} cancelled: the DAO proposal could not be filed"
                    )),
                    timestamp_ms: now_ms(),
                });
            }
        }
    }
}
