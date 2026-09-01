import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
import { useEmissionsVotingSandwich } from '@/hooks/useEmissionsVotingSandwich'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'

/**
 * Parameters for unstaking from Disco (2-step process)
 */
interface UseDiscoUnstakeParams {
  /** The asset denom */
  asset: string
  /** Slot number (1-9) */
  slot: number
  /** Deposit ID */
  depositId: string
  /** Vault tokens to unstake (human-readable). If undefined, unstakes all. */
  amount?: string
  /** Which action to perform */
  action: 'request' | 'complete' | 'cancel'
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook for 2-step unstaking from Disco deposits.
 *
 * Flow: request_unstake -> cooldown (2 days) -> complete_unstake
 * The request_unstake uses voting sandwich if user has active votes.
 *
 * @example
 * ```typescript
 * // Request unstake
 * const unstake = useDiscoUnstake({
 *   asset: 'ibc/...', slot: 3, depositId: '5',
 *   amount: '100', action: 'request',
 * })
 *
 * // Complete unstake (after cooldown)
 * const complete = useDiscoUnstake({
 *   asset: 'ibc/...', slot: 3, depositId: '5',
 *   action: 'complete',
 * })
 * ```
 */
const useDiscoUnstake = ({
  asset,
  slot,
  depositId,
  amount,
  action: unstakeAction,
  txSuccess,
}: UseDiscoUnstakeParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()
  const { data: client } = useCosmWasmClient(appState.rpcUrl)
  const discoContract = (contracts as any).ltv_disco

  // Query disco config to get emissions_voting contract address (for request_unstake sandwich)
  const { data: configData } = useQuery({
    queryKey: ['disco_config', discoContract, appState.rpcUrl],
    queryFn: async () => {
      if (!client || !discoContract || discoContract === '') return null
      try {
        return await client.queryContractSmart(discoContract, { config: {} })
      } catch (error) {
        console.error('Error fetching disco config:', error)
        return null
      }
    },
    enabled: !!client && !!discoContract && discoContract !== '' && unstakeAction === 'request',
    staleTime: 1000 * 60 * 5,
  })

  const emissionsVotingContract = configData?.emissions_voting_contract

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  // Build the unstake message based on action type
  const { data: baseQueryData } = useQuery<QueryData>({
    queryKey: ['disco_unstake', 'base_msgs', address, asset, slot, depositId, amount, unstakeAction, appState.rpcUrl],
    staleTime: 1000 * 60 * 5,
    queryFn: () => {
      if (!address || !asset || !slot || !depositId) {
        return { msgs: undefined }
      }
      if (!discoContract || discoContract === '') {
        return { msgs: undefined }
      }

      let executeMsg: any

      if (unstakeAction === 'request') {
        executeMsg = {
          request_unstake: {
            asset,
            slot,
            deposit_id: depositId,
            ...(amount ? { amount: shiftDigits(amount, 6).dp(0).toString() } : {}),
          }
        }
      } else if (unstakeAction === 'complete') {
        executeMsg = {
          complete_unstake: {
            asset,
            slot,
            deposit_id: depositId,
          }
        }
      } else if (unstakeAction === 'cancel') {
        executeMsg = {
          cancel_unstake: {
            asset,
            slot,
            deposit_id: depositId,
          }
        }
      } else {
        return { msgs: undefined }
      }

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: discoContract,
          msg: toUtf8(JSON.stringify(executeMsg)),
          funds: [],
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!asset && slot >= 1 && slot <= 9 && !!depositId,
  })

  const baseMsgs = baseQueryData?.msgs ?? []

  // Use voting sandwich only for request_unstake
  const { sandwichedMsgs, hasVotes, isLoading: isSandwichLoading } = useEmissionsVotingSandwich({
    emissionsVotingContract: unstakeAction === 'request' ? emissionsVotingContract : undefined,
    actionMsgs: baseMsgs,
    enabled: !!baseMsgs?.length && unstakeAction === 'request' && !!emissionsVotingContract,
  })

  // For request, use sandwiched msgs; for complete/cancel, use base msgs
  const msgs = unstakeAction === 'request' ? sandwichedMsgs : baseMsgs

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['disco'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    if (unstakeAction === 'request') {
      queryClient.invalidateQueries({ queryKey: ['emissions_user_votes'] })
    }
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['disco_unstake_sim', unstakeAction, address, asset, slot, depositId, amount],
    enabled: !!msgs?.length && (unstakeAction !== 'request' || !isSandwichLoading),
    onSuccess,
  })

  return {
    action,
    msgs,
    hasVotes,
    isSandwichLoading,
  }
}

export default useDiscoUnstake
