import type { RunData } from "./run";

/** A copy of web/public/run.json, the recorded run, for tests. */
export const FIXTURE: RunData = {
  "recordedAt": "2026-11-06T16:40:18.334Z",
  "network": "testnet",
  "mandate": "steward.termwork-m2-fba0b2.testnet",
  "dao": "twfba0b2.sputnikv2.testnet",
  "model": "Qwen/Qwen3.8-27B",
  "mission": {
    "title": "Contributor Rewards Steward",
    "clauses": [
      {
        "id": 1,
        "text": "Reward first-time contributors whose pull requests are merged into the repo, within 48 hours of the merge.",
        "max_amount": "500000000000000000000000",
        "pays": true
      },
      {
        "id": 2,
        "text": "Standard reward: 0.2 NEAR per qualifying pull request.",
        "max_amount": "200000000000000000000000",
        "pays": true
      },
      {
        "id": 3,
        "text": "A larger pull request (a `feature` label, or more than 200 changed lines) deserves 0.5 NEAR. Because that is over the spend threshold, it goes to a DAO vote instead of being paid directly.",
        "max_amount": "500000000000000000000000",
        "pays": true
      },
      {
        "id": 4,
        "text": "Never pay a pull request twice, or one without a NEAR account given in its body.",
        "max_amount": null,
        "pays": false
      }
    ]
  },
  "spendThreshold": "200000000000000000000000",
  "maxRequest": "500000000000000000000000",
  "termSecs": 300,
  "hire": {
    "proposalId": 0,
    "proposeTx": "9YMqHeQZi395zDsKEhroY94PLR8JgkRwmptMUHUppVpG",
    "voteTxs": [
      "3QXrvFx9z3Eg6YAjT8xTUf7TdV6JiL8PY8EJryBgNuzK",
      "CM6DKWRTaAgddihJLkxsDsuYKoyTEfcsftEkkxvX8Yqz"
    ]
  },
  "prs": [
    {
      "url": "https://github.com/termwork/demo/pull/1",
      "number": 1,
      "title": "Fix typo in README",
      "firstTime": true,
      "changedLines": 12,
      "labels": [
        "docs"
      ],
      "nearAccount": "alice-dev.termwork-m3-fba0b2.testnet",
      "ai": {
        "qualifies": true,
        "clause_id": 1,
        "amount_near": "0.2",
        "rationale": "The pull request meets the criteria for Clause 1 as it is from a first-time contributor and has a valid NEAR account. The reward amount is set to 0.2 NEAR according to the standard rate in Clause 2."
      },
      "receiptHash": "e3ad67f3ab09ff5aab0806bf34ca107a70ab1df6b925314c8a617d89de479524",
      "verified": true,
      "outcome": "paid",
      "outcomeNote": "paid 0.2 NEAR under clause 1",
      "amount": "200000000000000000000000",
      "tx": "GkMBHRmPJEo7ouWmqsffTVKVrziyfyV1Nizm2JD9d5Wi",
      "logIndex": 1
    },
    {
      "url": "https://github.com/termwork/demo/pull/2",
      "number": 2,
      "title": "Add missing error message",
      "firstTime": true,
      "changedLines": 35,
      "labels": [
        "bug"
      ],
      "nearAccount": "bob-codes.termwork-m3-fba0b2.testnet",
      "ai": {
        "qualifies": true,
        "clause_id": 2,
        "amount_near": "0.2",
        "rationale": "The pull request is merged, the author is a first-time contributor, and the PR has a valid NEAR account, but it does not meet the criteria for the larger reward (no 'feature' label and <200 lines), so it qualifies for the standard reward under Clause 2."
      },
      "receiptHash": "b207f549bf9ff980247f47d7285e6a45cbc07c9c6b8503a87af608aee16aaecf",
      "verified": true,
      "outcome": "paid",
      "outcomeNote": "paid 0.2 NEAR under clause 2",
      "amount": "200000000000000000000000",
      "tx": "7KsGA9PNjAMG4o3zdc7dBvNETbZzDJpBSDtBgJ6Rphdv",
      "logIndex": 2
    },
    {
      "url": "https://github.com/termwork/demo/pull/3",
      "number": 3,
      "title": "Clarify install steps",
      "firstTime": true,
      "changedLines": 48,
      "labels": [
        "docs"
      ],
      "nearAccount": "carol-w.termwork-m3-fba0b2.testnet",
      "ai": {
        "qualifies": true,
        "clause_id": 2,
        "amount_near": "0.2",
        "rationale": "The pull request is a standard contribution (48 lines, docs label) by a contributor with a valid NEAR account. Clause 2 applies for the standard reward of 0.2 NEAR, as it does not meet the criteria for the larger reward in Clause 3."
      },
      "receiptHash": "e4605f893b0ab7b3e714e1a7dffdacda69759dc96a6d3e3db27c986959a46fbc",
      "verified": true,
      "outcome": "paid",
      "outcomeNote": "paid 0.2 NEAR under clause 2",
      "amount": "200000000000000000000000",
      "tx": "BP72wtzVVk2A9wr2rFLaRaoLY4XyE8svrYZxrzUn4NQu",
      "logIndex": 3
    },
    {
      "url": "https://github.com/termwork/demo/pull/4",
      "number": 4,
      "title": "Add CSV export feature",
      "firstTime": true,
      "changedLines": 340,
      "labels": [
        "feature"
      ],
      "nearAccount": "dave-builds.termwork-m3-fba0b2.testnet",
      "ai": {
        "qualifies": true,
        "clause_id": 3,
        "amount_near": "0.5",
        "rationale": "The pull request has a 'feature' label and 340 changed lines, exceeding the 200-line threshold defined in clause 3 for a larger reward. Although the contributor is a first-time contributor, the specific criteria for clause 3 regarding size or feature labels takes precedence for the reward amount calculation in this context."
      },
      "receiptHash": "52081c1123b30ff2a67b3cdf3cce3c0d405b9b90b017bbc285cecdf419b9d5ac",
      "verified": true,
      "outcome": "requested",
      "outcomeNote": "asked the DAO for 0.5 NEAR (over the spend threshold)",
      "amount": "500000000000000000000000",
      "tx": "5qYz2ZJFcdMbBGL2D788LfwcrTwhHtPFsQ1uxaL7nnjn",
      "logIndex": 4
    },
    {
      "url": "https://github.com/termwork/demo/pull/5",
      "number": 5,
      "title": "Refactor config loader",
      "firstTime": false,
      "changedLines": 60,
      "labels": [
        "refactor"
      ],
      "nearAccount": "alice-dev.termwork-m3-fba0b2.testnet",
      "ai": {
        "qualifies": true,
        "clause_id": 2,
        "amount_near": "0.2",
        "rationale": "The pull request qualifies for the standard reward under Clause 2 because it has a valid NEAR account, has not been paid before, and does not meet the criteria for the larger reward in Clause 3 (lacks 'feature' label and has fewer than 200 changed lines)."
      },
      "receiptHash": "2aa248389fed041f932bb64b3dc3523846e962afcce4beca774d335f8d5a4353",
      "verified": true,
      "outcome": "skipped",
      "outcomeNote": "not a first-time contributor",
      "amount": null,
      "tx": null,
      "logIndex": 5
    }
  ],
  "bigSpend": {
    "requestId": 0,
    "proposalId": 1,
    "requestTx": "5qYz2ZJFcdMbBGL2D788LfwcrTwhHtPFsQ1uxaL7nnjn",
    "rejectTxs": [
      "7fiuGGEEH3VokACsx4eEVXXj5ETTC1GvvNnikTqwpQxU",
      "43eyeVAaF1thcypFmUraCW2jYMCcemxnqYKNpJZA3E1N"
    ],
    "state": "Rejected"
  },
  "renewal": {
    "reportText": "Paid\n[#1] Paid 200,000,000,000,000,000,000,000 yoctoNEAR to alice-dev.termwork-m3-fba0b2.testnet.\n[#2] Paid 200,000,000,000,000,000,000,000 yoctoNEAR to bob-codes.termwork-m3-fba0b2.testnet.\n[#3] Paid 200,000,000,000,000,000,000,000 yoctoNEAR to carol-w.termwork-m3-fba0b2.testnet.\n\nSent to vote\n[#4] Requested 500,000,000,000,000,000,000,000 yoctoNEAR for dave-builds.termwork-m3-fba0b2.testnet. Note: The pull request has a 'feature' label and 340 changed lines, exceeding the 200-line threshold defined in clause 3 for a larger reward. Although the contributor is a first-time contributor, the specific criteria for clause 3 regarding size or feature labels takes precedence for the reward amount calculation in this context.\n\nSkipped\n[#5] Skipped work for clause 1. Note: skipped: not a first-time contributor.\n\nBudget left\nInitial budget: 1,400,000,000,000,000,000,000,000 yoctoNEAR.\nSpent: 600,000,000,000,000,000,000,000 yoctoNEAR (sum of [#1], [#2], [#3]).\nRemaining: 800,000,000,000,000,000,000,000 yoctoNEAR.\nNote: The requested amount in [#4] is not yet spent.\n\nNext term\nRenewal requested. The agent fulfilled payment obligations for clauses 1 and 2 (3 payments) and correctly skipped a non-qualifying work entry (clause 1). One request for clause 3 is pending vote.",
    "reportHash": "916d46a084c171f487574ad66aa9682c4853c0bf59601345e0ebd6ac26b7e950",
    "logIndex": 6,
    "proposalTx": "4E9r2Yernts3SYhCWvGEdZwjJzP3PuSaYaZ9TzqrVNyk",
    "receiptHash": "71a8ff68eebeb505527fe9e10d06481bd6a2e9be3c64b15365f985a9fd492372",
    "rejectTxs": [
      "Hb4BAw1ka28ZH4wm72fdcdFSv4zExSepb8s5BKN5pu2t",
      "5ZCSx9nJp3S71cF7TXHrrYeNXRmRkqM8oSsMYtF3M8zq"
    ]
  },
  "budget": {
    "total": "2000000000000000000000000",
    "spent": "600000000000000000000000",
    "availableAtReport": "1400000000000000000000000"
  },
  "end": {
    "termEndedTx": "2aTV7tu1htab2R5PCULxYUEcikf95HiTQM3qe2fLcvaq",
    "termEndedError": "Smart contract panicked: term ended",
    "fireProposeTx": "F1eJbeP4wVu3W1JTj7gUYV4ZMQuSxHT6JXnNbXsnrDw5",
    "fireVoteTxs": [
      "DgKD6hmxQKVyByZeiS1WeTQz3EA9QkSEbACFN4cYGhw7",
      "5fopmFDQ1MVGsoqoA5mx8Q1EPZ4gVbBW1caKqCkfWDEE"
    ],
    "sweepTx": "GZUCPi77BchtzET1dXtjNPdC4WE65uPkt5gytSTbkypP",
    "firedAmount": "2433371664646956000000000",
    "sweptAmount": "114510000000000000000000",
    "agentAttempt": "InvalidAccessKey (access key does not exist)"
  },
  "log": [
    {
      "index": 0,
      "kind": "Hired",
      "clause_id": null,
      "amount": "2000000000000000000000000",
      "recipient": null,
      "evidence_url": null,
      "receipt_hash": null,
      "note": "Contributor Rewards Steward",
      "timestamp_ms": 1793983281277
    },
    {
      "index": 1,
      "kind": "Paid",
      "clause_id": 1,
      "amount": "200000000000000000000000",
      "recipient": "alice-dev.termwork-m3-fba0b2.testnet",
      "evidence_url": "https://github.com/termwork/demo/pull/1",
      "receipt_hash": "e3ad67f3ab09ff5aab0806bf34ca107a70ab1df6b925314c8a617d89de479524",
      "note": null,
      "timestamp_ms": 1793983297002
    },
    {
      "index": 2,
      "kind": "Paid",
      "clause_id": 2,
      "amount": "200000000000000000000000",
      "recipient": "bob-codes.termwork-m3-fba0b2.testnet",
      "evidence_url": "https://github.com/termwork/demo/pull/2",
      "receipt_hash": "b207f549bf9ff980247f47d7285e6a45cbc07c9c6b8503a87af608aee16aaecf",
      "note": null,
      "timestamp_ms": 1793983307372
    },
    {
      "index": 3,
      "kind": "Paid",
      "clause_id": 2,
      "amount": "200000000000000000000000",
      "recipient": "carol-w.termwork-m3-fba0b2.testnet",
      "evidence_url": "https://github.com/termwork/demo/pull/3",
      "receipt_hash": "e4605f893b0ab7b3e714e1a7dffdacda69759dc96a6d3e3db27c986959a46fbc",
      "note": null,
      "timestamp_ms": 1793983317254
    },
    {
      "index": 4,
      "kind": "Requested",
      "clause_id": 3,
      "amount": "500000000000000000000000",
      "recipient": "dave-builds.termwork-m3-fba0b2.testnet",
      "evidence_url": "https://github.com/termwork/demo/pull/4",
      "receipt_hash": "52081c1123b30ff2a67b3cdf3cce3c0d405b9b90b017bbc285cecdf419b9d5ac",
      "note": "The pull request has a 'feature' label and 340 changed lines, exceeding the 200-line threshold defined in clause 3 for a larger reward. Although the contributor is a first-time contributor, the specific criteria for clause 3 regarding size or feature labels takes precedence for the reward amount calculation in this context.",
      "timestamp_ms": 1793983334240
    },
    {
      "index": 5,
      "kind": "Work",
      "clause_id": 1,
      "amount": null,
      "recipient": null,
      "evidence_url": "https://github.com/termwork/demo/pull/5",
      "receipt_hash": "2aa248389fed041f932bb64b3dc3523846e962afcce4beca774d335f8d5a4353",
      "note": "skipped: not a first-time contributor",
      "timestamp_ms": 1793983344481
    },
    {
      "index": 6,
      "kind": "RenewalProposed",
      "clause_id": null,
      "amount": "0",
      "recipient": null,
      "evidence_url": null,
      "receipt_hash": "916d46a084c171f487574ad66aa9682c4853c0bf59601345e0ebd6ac26b7e950",
      "note": "300 s requested",
      "timestamp_ms": 1793983526924
    },
    {
      "index": 7,
      "kind": "Fired",
      "clause_id": null,
      "amount": "2433371664646956000000000",
      "recipient": "twfba0b2.sputnikv2.testnet",
      "evidence_url": null,
      "receipt_hash": null,
      "note": "demo: term ended, not renewing",
      "timestamp_ms": 1793983634466
    },
    {
      "index": 8,
      "kind": "Swept",
      "clause_id": null,
      "amount": "114510000000000000000000",
      "recipient": "twfba0b2.sputnikv2.testnet",
      "evidence_url": null,
      "receipt_hash": null,
      "note": null,
      "timestamp_ms": 1793983689857
    }
  ]
} as RunData;
