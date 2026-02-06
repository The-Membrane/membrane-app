import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { toUtf8, fromUtf8 } from '@cosmjs/encoding'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import contracts from '@/config/contracts.json'
import { getUserLockedDeposits } from '@/services/disco'
import { getStaked } from '@/services/staking'
import { shiftDigits } from '@/helpers/math'

/**
 * Vote allocation from emissions_voting contract
 */
interface VoteAllocation {
  graph_id: string
  weight: string
}

/**
 * Parameters for the emissions voting sandwich helper
 */
interface UseEmissionsVotingSandwichParams {
  /** The emissions_voting contract address */
  emissionsVotingContract: string | undefined
  /** The action messages to wrap with vote removal/restoration */
  actionMsgs: MsgExecuteContractEncodeObject[]
  /** Whether to run the query (defaults to true) */
  enabled?: boolean
}

/**
 * Build a RemoveVote message for a specific graph
 */
const buildRemoveVoteMsg = (
  sender: string,
  contract: string,
  graphId: string
): MsgExecuteContractEncodeObject => ({
  typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
  value: MsgExecuteContract.fromPartial({
    sender,
    contract,
    msg: toUtf8(JSON.stringify({
      remove_vote: { graph_id: graphId }
    })),
    funds: [],
  }),
})

/**
 * Build a Vote message to restore allocation
 */
const buildVoteMsg = (
  sender: string,
  contract: string,
  graphId: string,
  weight: string
): MsgExecuteContractEncodeObject => ({
  typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
  value: MsgExecuteContract.fromPartial({
    sender,
    contract,
    msg: toUtf8(JSON.stringify({
      vote: { graph_id: graphId, weight }
    })),
    funds: [],
  }),
})

/**
 * Calculate lock multiplier (mirrors Rust logic from emissions-voting contract)
 */
const calculateLockMultiplier = (locked: any, currentTime: number): number => {
  if (!locked) return 1

  if (locked.perpetual_lock) {
    return locked.perpetual_lock + 1
  }

  if (locked.locked_until > currentTime) {
    const remainingSeconds = locked.locked_until - currentTime
    const remainingDays = Math.floor(remainingSeconds / 86400) // SECONDS_PER_DAY
    return remainingDays + 1
  }

  return 1 // Lock expired
}

/**
 * Calculate voting power from deposits (mirrors Rust logic)
 */
const calculateVotingPower = (
  discoDeposits: any[],
  stakingDeposits: any[],
  currentTime: number
): number => {
  let totalPower = 0

  // LTV Disco deposits
  for (const lockedDeposit of discoDeposits) {
    const deposit = lockedDeposit.deposit
    const depositAmount = parseFloat(deposit.vault_tokens || '0')
    const lockMultiplier = calculateLockMultiplier(deposit.locked, currentTime)
    totalPower += depositAmount * lockMultiplier
  }

  // Staking deposits (excluding unstaking)
  for (const stakeDeposit of stakingDeposits) {
    if (stakeDeposit.unstake_start_time) continue // Skip unstaking deposits

    const depositAmount = parseFloat(stakeDeposit.amount || '0')
    const lockMultiplier = calculateLockMultiplier(stakeDeposit.locked, currentTime)
    totalPower += depositAmount * lockMultiplier
  }

  return totalPower
}

/**
 * Parse action messages to identify withdraw/unstake operations
 */
const parseActionMessages = (actionMsgs: MsgExecuteContractEncodeObject[]) => {
  const actions: Array<{ type: 'disco_withdraw' | 'staking_unstake', params: any }> = []

  for (const msg of actionMsgs) {
    try {
      const msgStr = fromUtf8(msg.value.msg)
      const msgObj = JSON.parse(msgStr)

      // Check for disco withdraw
      if (msgObj.withdraw) {
        actions.push({
          type: 'disco_withdraw',
          params: {
            asset: msgObj.withdraw.asset,
            max_ltv: msgObj.withdraw.max_ltv,
            max_borrow_ltv: msgObj.withdraw.max_borrow_ltv,
            amount: msgObj.withdraw.amount, // Optional, in micro units
          },
        })
      }

      // Check for staking unstake
      if (msgObj.unstake) {
        actions.push({
          type: 'staking_unstake',
          params: {
            mbrn_amount: msgObj.unstake.mbrn_amount, // Optional, in micro units
          },
        })
      }
    } catch (error) {
      // Ignore parsing errors, continue with other messages
      console.warn('Failed to parse action message:', error)
    }
  }

  return actions
}

/**
 * Hook that handles emissions voting sandwich pattern.
 * 
 * When users have active votes in the emissions_voting contract, they cannot
 * withdraw or reduce lock durations. This hook:
 * 1. Queries HasAnyVotes to check if user has active votes
 * 2. If true, queries UserVotes to get current allocations
 * 3. Returns sandwiched messages: [RemoveVotes...] + [ActionMsgs...] + [ReVotes...]
 * 
 * If user has no votes, returns the original action messages unchanged.
 * 
 * @example
 * ```typescript
 * const { sandwichedMsgs, hasVotes, isLoading } = useEmissionsVotingSandwich({
 *   emissionsVotingContract: config.emissions_voting,
 *   actionMsgs: [withdrawMsg],
 *   enabled: !!withdrawMsg,
 * })
 * ```
 */
export const useEmissionsVotingSandwich = ({
  emissionsVotingContract,
  actionMsgs,
  enabled = true,
}: UseEmissionsVotingSandwichParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()
  const { data: client } = useCosmWasmClient(appState.rpcUrl)

  type QueryData = {
    sandwichedMsgs: MsgExecuteContractEncodeObject[]
    hasVotes: boolean
    userVotes: VoteAllocation[]
  }

  const { data: queryData, isLoading, error } = useQuery<QueryData>({
    queryKey: [
      'emissions_voting_sandwich',
      address,
      emissionsVotingContract,
      actionMsgs?.length ?? 0,
      actionMsgs?.map(m => JSON.stringify(m)).join('|') ?? '',
    ],
    queryFn: async () => {
      // Early return if missing dependencies
      if (!address || !client || !emissionsVotingContract || !actionMsgs?.length) {
        return {
          sandwichedMsgs: actionMsgs ?? [],
          hasVotes: false,
          userVotes: [],
        }
      }

      try {
        // 1. Query HasAnyVotes
        const hasVotesResponse = await client.queryContractSmart(emissionsVotingContract, {
          has_any_votes: { user: address }
        })
        
        const hasVotes = hasVotesResponse?.has_votes ?? false

        // If no votes, return original messages unchanged
        if (!hasVotes) {
          return {
            sandwichedMsgs: actionMsgs,
            hasVotes: false,
            userVotes: [],
          }
        }

        // 2. Query UserVotes to get current allocations
        const userVotesResponse = await client.queryContractSmart(emissionsVotingContract, {
          user_votes: { user: address }
        })

        const userVotes: VoteAllocation[] = userVotesResponse?.votes ?? []

        // If no vote allocations found, return original messages
        if (!userVotes.length) {
          return {
            sandwichedMsgs: actionMsgs,
            hasVotes: true,
            userVotes: [],
          }
        }

        // 3. Calculate post-action voting power
        // Parse action messages to identify withdraw/unstake operations
        const actions = parseActionMessages(actionMsgs)
        
        // Query current deposits
        const discoContract = (contracts as any).ltv_disco
        const stakingContract = (contracts as any).staking
        
        const [discoDepositsResponse, stakingDepositsResponse] = await Promise.all([
          discoContract ? getUserLockedDeposits(client, address, discoContract).catch(() => null) : null,
          stakingContract ? getStaked(address, client).catch(() => null) : null,
        ])

        const discoDeposits = discoDepositsResponse?.locked_deposits || []
        const stakingDeposits = stakingDepositsResponse?.deposit_list || []

        // Calculate current voting power
        const currentTime = Math.floor(Date.now() / 1000)
        const currentVotingPower = calculateVotingPower(discoDeposits, stakingDeposits, currentTime)

        // Calculate voting power loss from actions
        let votingPowerLoss = 0

        for (const action of actions) {
          if (action.type === 'disco_withdraw') {
            // Find deposits matching the withdraw criteria
            const matchingDeposits = discoDeposits.filter((ld: any) => {
              const matchesAsset = ld.asset === action.params.asset
              const matchesLtv = parseFloat(ld.ltv || '0') === parseFloat(action.params.max_ltv || '0')
              const matchesBorrowLtv = parseFloat(ld.max_borrow_ltv || '0') === parseFloat(action.params.max_borrow_ltv || '0')
              return matchesAsset && matchesLtv && matchesBorrowLtv
            })

            if (action.params.amount) {
              // Partial withdraw: calculate proportional loss
              const withdrawAmount = parseFloat(action.params.amount)
              for (const lockedDeposit of matchingDeposits) {
                const deposit = lockedDeposit.deposit
                const depositAmount = parseFloat(deposit.vault_tokens || '0')
                const lockMultiplier = calculateLockMultiplier(deposit.locked, currentTime)
                const depositVotingPower = depositAmount * lockMultiplier
                
                // Calculate proportional loss (if withdrawing from this deposit)
                if (depositAmount > 0) {
                  const proportion = Math.min(1, withdrawAmount / depositAmount)
                  votingPowerLoss += depositVotingPower * proportion
                }
              }
            } else {
              // Full withdraw: remove all matching deposits
              for (const lockedDeposit of matchingDeposits) {
                const deposit = lockedDeposit.deposit
                const depositAmount = parseFloat(deposit.vault_tokens || '0')
                const lockMultiplier = calculateLockMultiplier(deposit.locked, currentTime)
                votingPowerLoss += depositAmount * lockMultiplier
              }
            }
          } else if (action.type === 'staking_unstake') {
            // Staking unstake uses FIFO order
            // Calculate which deposits will be unstaked
            const unstakeAmount = action.params.mbrn_amount 
              ? parseFloat(action.params.mbrn_amount)
              : null // If null, unstakes all

            let remainingToUnstake = unstakeAmount || Infinity
            const sortedDeposits = [...stakingDeposits]
              .filter(d => !d.unstake_start_time) // Only active deposits
              .sort((a, b) => parseFloat(a.stake_time || '0') - parseFloat(b.stake_time || '0')) // FIFO

            for (const stakeDeposit of sortedDeposits) {
              if (remainingToUnstake <= 0) break

              const depositAmount = parseFloat(stakeDeposit.amount || '0')
              const lockMultiplier = calculateLockMultiplier(stakeDeposit.locked, currentTime)
              const depositVotingPower = depositAmount * lockMultiplier

              if (unstakeAmount === null) {
                // Unstake all
                votingPowerLoss += depositVotingPower
              } else {
                // Partial unstake
                const amountToUnstake = Math.min(remainingToUnstake, depositAmount)
                const proportion = amountToUnstake / depositAmount
                votingPowerLoss += depositVotingPower * proportion
                remainingToUnstake -= amountToUnstake
              }
            }
          }
        }

        // Calculate post-action voting power
        const postActionVotingPower = currentVotingPower - votingPowerLoss

        // Only include revote messages if user will have voting power after the action
        if (postActionVotingPower <= 0) {
          // User will have no voting power, don't revote
          return {
            sandwichedMsgs: [
              ...userVotes.map(vote => buildRemoveVoteMsg(address, emissionsVotingContract, vote.graph_id)),
              ...actionMsgs,
              // No revote messages
            ],
            hasVotes: true,
            userVotes,
          }
        }

        // 4. Build sandwich messages
        // Before: RemoveVote for each graph
        const removeVoteMsgs = userVotes.map(vote =>
          buildRemoveVoteMsg(address, emissionsVotingContract, vote.graph_id)
        )

        // After: Vote to restore exact same allocations
        const reVoteMsgs = userVotes.map(vote =>
          buildVoteMsg(address, emissionsVotingContract, vote.graph_id, vote.weight)
        )

        // Sandwiched: [RemoveVotes...] + [ActionMsgs...] + [ReVotes...]
        const sandwichedMsgs = [
          ...removeVoteMsgs,
          ...actionMsgs,
          ...reVoteMsgs,
        ]

        return {
          sandwichedMsgs,
          hasVotes: true,
          userVotes,
        }
      } catch (error) {
        console.error('Error building voting sandwich:', error)
        // On error, return original messages (let the transaction fail naturally if needed)
        return {
          sandwichedMsgs: actionMsgs,
          hasVotes: false,
          userVotes: [],
        }
      }
    },
    enabled: enabled && !!address && !!client && !!emissionsVotingContract && !!actionMsgs?.length,
    staleTime: 1000 * 30, // 30 seconds - votes don't change that often
  })

  return {
    /** The sandwiched messages (or original messages if no votes) */
    sandwichedMsgs: queryData?.sandwichedMsgs ?? actionMsgs ?? [],
    /** Whether the user has active votes */
    hasVotes: queryData?.hasVotes ?? false,
    /** The user's current vote allocations */
    userVotes: queryData?.userVotes ?? [],
    /** Whether the query is loading */
    isLoading,
    /** Any error that occurred */
    error,
  }
}

export default useEmissionsVotingSandwich




