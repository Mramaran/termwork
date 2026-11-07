import type { Mission } from "./types.js";

const ONE_NEAR = 10n ** 24n;

/** Parses a NEAR amount string like "0.5" into yoctoNEAR. */
const near = (s: string): bigint => {
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * ONE_NEAR + BigInt(f.padEnd(24, "0").slice(0, 24));
};

/** The demo mission hired on testnet (scripts/src/hire.ts). */
export const DEMO_MISSION: Mission = {
  title: "Contributor Rewards Steward",
  clauses: [
    { id: 1, text: "Reward every valid pull request merged inside the review window the steward is asked to check. A trivial change (a typo, whitespace or formatting only, or an automated bot update) is not valid and earns nothing.", max_amount: near("0.5").toString(), pays: true },
    { id: 2, text: "Standard reward: 0.2 NEAR per qualifying pull request.", max_amount: near("0.2").toString(), pays: true },
    {
      id: 3,
      text: "A larger pull request (a `feature` label, or more than 200 changed lines) deserves 0.5 NEAR. Because that is over the spend threshold, it goes to a DAO vote instead of being paid directly.",
      max_amount: near("0.5").toString(),
      pays: true,
    },
    { id: 4, text: "Never pay a pull request twice, or one without a NEAR account given in its body. Only the first 2 merged pull requests from each contributor inside one review window are considered.", max_amount: null, pays: false },
  ],
};

/** Clause 4: only this many merged pull requests per contributor are considered in one review window. */
export const MAX_PRS_PER_CONTRIBUTOR = 2;

/** Spend threshold for the demo mandate: 0.2 NEAR in yoctoNEAR. */
export const DEMO_SPEND_THRESHOLD = near("0.2").toString();

/** Max single request for the demo mandate: 0.5 NEAR in yoctoNEAR. */
export const DEMO_MAX_REQUEST = near("0.5").toString();
