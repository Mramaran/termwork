/** TypeScript mirrors of contracts/mandate/src/types.rs. Amounts are yoctoNEAR decimal strings. */

export type Yocto = string;

export interface Clause {
  id: number;
  text: string;
  max_amount: Yocto | null;
  pays: boolean;
}

export interface Mission {
  title: string;
  clauses: Clause[];
}

export type Status = "Unhired" | "Active" | "Expired" | "Fired";

export type EntryKind =
  | "Hired"
  | "Paid"
  | "PaidApproved"
  | "Requested"
  | "Work"
  | "RenewalProposed"
  | "Renewed"
  | "Expired"
  | "Fired"
  | "Swept"
  | "Released";

export interface LogEntry {
  index: number;
  kind: EntryKind;
  clause_id: number | null;
  amount: Yocto | null;
  recipient: string | null;
  evidence_url: string | null;
  receipt_hash: string | null;
  note: string | null;
  timestamp_ms: number;
}

export type RequestState = "Pending" | "Executed" | "Cancelled";

export interface SpendRequest {
  id: number;
  recipient: string;
  amount: Yocto;
  clause_id: number;
  evidence_url: string;
  receipt_hash: string;
  rationale: string;
  proposal_id: number | null;
  state: RequestState;
}

export interface Renewal {
  report_text: string;
  report_hash: string;
  requested_term_secs: number;
  requested_topup: Yocto;
  proposal_id: number | null;
  timestamp_ms: number;
}

export interface MandateView {
  dao_id: string;
  mission: Mission | null;
  status: Status;
  spend_threshold: Yocto;
  max_request: Yocto;
  term_start_ms: number;
  term_end_ms: number;
  term_number: number;
  /** Public key string (ed25519:...) or null. The retired key is not exposed by get_mandate. */
  agent_key: string | null;
  /** Hire deposit plus renewal top-ups: the most the agent can ever spend. */
  budget_total: Yocto;
  budget_spent: Yocto;
  budget_available: Yocto;
}
