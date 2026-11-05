import { accountFor, createFundedTestnetAccount } from "./accounts.js";
import { BOND, FACTORY, ONE_NEAR, TGAS, balanceOf, call, near, setEnv, view, waitFor, type State } from "./chain.js";

export const RANDOM_SUFFIX = (): string => Math.random().toString(16).slice(2, 8);

export interface ProposalView {
  id: number;
  status: string;
  proposer: string;
  description: string;
}

export function sputnikPolicy(members: string[]) {
  return {
    roles: [
      { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
      { name: "council", kind: { Group: members }, permissions: ["*:*"], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: "2" },
    proposal_bond: BOND.toString(),
    proposal_period: "604800000000000",
    bounty_bond: BOND.toString(),
    bounty_forgiveness_period: "86400000000000",
  };
}

/** Creates 3 funded council members (the only faucet accounts) and a 2-of-3 Sputnik DAO with a 0.1 NEAR bond, then tops the DAO up by 3 NEAR. */
export async function setupDao(log: (s: string) => void = console.log): Promise<State> {
  const suffix = RANDOM_SUFFIX();
  const members: string[] = [];
  for (const n of [1, 2, 3]) {
    const id = `termwork-m${n}-${suffix}.testnet`;
    await createFundedTestnetAccount(id);
    members.push(id);
    log(`  member ${n}: ${id}`);
  }
  const name = `tw${suffix}`;
  const daoId = `${name}.${FACTORY}`;
  const args = { config: { name, purpose: "Termwork demo DAO", metadata: "" }, policy: sputnikPolicy(members) };
  await call(members[0]!, FACTORY, "create", { name, args: Buffer.from(JSON.stringify(args)).toString("base64") }, { deposit: near("6"), gas: 300n * TGAS });
  await waitFor("DAO policy", () => view(daoId, "get_policy"), 60_000);
  await accountFor(members[0]!).transfer({ receiverId: daoId, amount: near("3") });
  log(`  DAO: ${daoId} (2-of-3, bond 0.1 NEAR), balance ${Number((await balanceOf(daoId)) / (ONE_NEAR / 1000n)) / 1000} NEAR`);
  const state: State = { suffix, members, daoId, contributors: {} };
  setEnv({ DAO_ID: daoId, NEAR_NETWORK: "testnet" });
  return state;
}

/** Files a FunctionCall proposal on the DAO against `receiver`. Returns the proposal id and tx hash. */
export async function propose(
  state: State,
  proposer: string,
  description: string,
  receiver: string,
  method: string,
  args: Record<string, unknown>,
  deposit: bigint = 0n,
): Promise<{ id: number; hash: string }> {
  const before = await view<number>(state.daoId, "get_last_proposal_id");
  const { hash } = await call(
    proposer,
    state.daoId,
    "add_proposal",
    {
      proposal: {
        description,
        kind: {
          FunctionCall: {
            receiver_id: receiver,
            actions: [{ method_name: method, args: Buffer.from(JSON.stringify(args)).toString("base64"), deposit: deposit.toString(), gas: (100n * TGAS).toString() }],
          },
        },
      },
    },
    { deposit: BOND },
  );
  const id = before;
  await waitFor(`proposal ${id}`, async () => (await view<number>(state.daoId, "get_last_proposal_id")) > id, 30_000);
  return { id, hash };
}

export const proposalStatus = async (state: State, id: number): Promise<string> => (await view<ProposalView>(state.daoId, "get_proposal", { id })).status;

/** Casts `action` from each of `voters` (stopping once the proposal is no longer InProgress). Returns every tx hash. */
export async function vote(state: State, id: number, action: "VoteApprove" | "VoteReject", voters: string[] = state.members.slice(0, 2)): Promise<string[]> {
  const hashes: string[] = [];
  for (const v of voters) {
    if ((await proposalStatus(state, id)) !== "InProgress") break;
    const { hash } = await call(v, state.daoId, "act_proposal", { id, action }, { gas: 300n * TGAS });
    hashes.push(hash);
  }
  return hashes;
}

export const decide = async (state: State, id: number, approve: boolean): Promise<{ status: string; hashes: string[] }> => {
  const hashes = await vote(state, id, approve ? "VoteApprove" : "VoteReject");
  const want = approve ? "Approved" : "Rejected";
  const status = await waitFor(`proposal ${id} ${want}`, async () => {
    const s = await proposalStatus(state, id);
    return s === "InProgress" ? undefined : s;
  }, 30_000);
  if (status !== want) throw new Error(`proposal ${id} ended ${status}, expected ${want}`);
  return { status, hashes };
};
