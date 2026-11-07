/** NEP-413 recipient for council proofs. Shared by the browser and the API. */
export const AUTH_RECIPIENT = "mission-dao";
export const AUTH_ACTION = "mission-dao-pay";
export const AUTH_MAX_SKEW_MS = 300_000;

export interface CouncilProof {
  accountId: string;
  publicKey: string;
  /** base64 */
  signature: string;
  message: string;
  /** base64, 32 bytes */
  nonce: string;
}
