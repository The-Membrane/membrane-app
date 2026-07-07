import type { EvmCall } from '@/services/chain/types'

/**
 * Vote allocation shape (kept for return-type parity with the pre-migration hook).
 */
interface VoteAllocation {
  graph_id: string
  weight: string
}

/**
 * Parameters for the emissions voting sandwich helper.
 */
interface UseEmissionsVotingSandwichParams {
  /** The emissions_voting contract address (unused in the port — see note below) */
  emissionsVotingContract: string | undefined
  /** The action messages to (previously) wrap with vote removal/restoration */
  actionMsgs: EvmCall[]
  /** Whether to run the query (defaults to true) */
  enabled?: boolean
}

/**
 * TODO(evm-migration): the Cosmos "emissions voting sandwich" (remove_vote → action →
 * re_vote around a withdraw/unstake) has NO analog in the Solidity port. There is no
 * emissions_voting contract in the port; Staking.sol instead guards unstake with a plain
 * `unstake(mbrnAmount, hasActiveGovernanceLock)` bool (a live lock reverts with
 * `GovernanceLockActive`, see contracts/abis/staking.ts). Because nothing needs to be
 * removed and restored around an action, a faithful mapping is a no-op: this hook is now a
 * pass-through that returns `actionMsgs` unchanged and reports `hasVotes: false`. The
 * governance-lock check itself is handled at the unstake call site, not here.
 *
 * Every exported field the previous version returned is preserved so consumers
 * (components/Disco/hooks/useDiscoUnstake.ts) keep compiling.
 */
export const useEmissionsVotingSandwich = ({
  actionMsgs,
}: UseEmissionsVotingSandwichParams) => {
  return {
    /** Pass-through: no sandwich exists in the port, so this is just the action msgs. */
    sandwichedMsgs: (actionMsgs ?? []) as EvmCall[],
    /** No emissions_voting contract in the port. */
    hasVotes: false,
    /** No vote allocations to surface. */
    userVotes: [] as VoteAllocation[],
    /** Synchronous pass-through — never loading. */
    isLoading: false,
    /** No async work, so no error. */
    error: null as unknown,
  }
}

export default useEmissionsVotingSandwich
