import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { useEmissionsVotingSandwich } from '@/hooks/useEmissionsVotingSandwich'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'

/**
 * Parameters for extending lock duration on a Disco deposit
 */
interface UseDiscoExtendLockParams {
  /** The asset denom for the deposit */
  asset: string
  /** Maximum LTV for the deposit tier */
  maxLtv: string
  /** Maximum borrow LTV for the deposit tier */
  maxBorrowLtv: string
  /** New lock duration in seconds */
  newDuration: number
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to extend (or modify) lock duration on an existing Disco deposit.
 * 
 * **IMPORTANT**: This hook uses voting sandwich logic when reducing lock duration.
 * If the user has active votes in the emissions_voting contract, the extend_lock
 * message will be wrapped with RemoveVote calls before and Vote calls after.
 * 
 * Note: Extending lock duration to a LONGER period may not require sandwich logic,
 * but we apply it defensively since the contract may still require it.
 * 
 * @example
 * ```typescript
 * const extendLock = useDiscoExtendLock({
 *   asset: 'factory/osmo.../CDT',
 *   maxLtv: '0.75',
 *   maxBorrowLtv: '0.70',
 *   newDuration: 86400 * 30, // 30 days in seconds
 *   txSuccess: () => console.log('Lock extended!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(extendLock.action, <Details />, { label: 'Extend Lock', actionType: 'lock' })
 * ```
 */
const useDiscoExtendLock = ({
  asset,
  maxLtv,
  maxBorrowLtv,
  newDuration,
  txSuccess,
}: UseDiscoExtendLockParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()
  const { data: client } = useCosmWasmClient(appState.rpcUrl)
  const discoContract = (contracts as any).ltv_disco

  // Query disco config to get emissions_voting contract address
  const { data: configData } = useQuery({
    queryKey: ['disco_config', discoContract],
    queryFn: async () => {
      if (!client || !discoContract || discoContract === '') return null
      try {
        const config = await client.queryContractSmart(discoContract, { config: {} })
        return config
      } catch (error) {
        console.error('Error fetching disco config:', error)
        return null
      }
    },
    enabled: !!client && !!discoContract && discoContract !== '',
    staleTime: 1000 * 60 * 5, // 5 minutes
  })

  const emissionsVotingContract = configData?.emissions_voting

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  // Build the base extend_lock message
  const { data: baseQueryData } = useQuery<QueryData>({
    queryKey: ['disco_extend_lock', 'base_msgs', address, asset, maxLtv, maxBorrowLtv, newDuration],
    queryFn: () => {
      if (!address || !asset || !maxLtv || !maxBorrowLtv || !newDuration) {
        return { msgs: undefined }
      }
      if (!discoContract || discoContract === '') {
        return { msgs: undefined }
      }

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: discoContract,
          msg: toUtf8(JSON.stringify({
            extend_lock: {
              asset,
              max_ltv: maxLtv,
              max_borrow_ltv: maxBorrowLtv,
              new_duration: newDuration.toString(),
            }
          })),
          funds: [],
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!asset && !!maxLtv && !!maxBorrowLtv && !!newDuration,
  })

  const baseMsgs = baseQueryData?.msgs ?? []

  // Use voting sandwich to wrap extend_lock message if user has active votes
  const { sandwichedMsgs, hasVotes, isLoading: isSandwichLoading } = useEmissionsVotingSandwich({
    emissionsVotingContract,
    actionMsgs: baseMsgs,
    enabled: !!baseMsgs?.length && !!emissionsVotingContract,
  })

  const msgs = sandwichedMsgs

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['disco_user_deposits'] })
    queryClient.invalidateQueries({ queryKey: ['disco_locked_deposits'] })
    queryClient.invalidateQueries({ queryKey: ['emissions_user_votes'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['disco_extend_lock_sim', (msgs?.toString() ?? '0')],
    enabled: !!msgs?.length && !isSandwichLoading,
    onSuccess,
  })

  return {
    action,
    msgs,
    /** Whether the user has active votes that required sandwich logic */
    hasVotes,
    /** Whether the sandwich query is still loading */
    isSandwichLoading,
  }
}

export default useDiscoExtendLock


























