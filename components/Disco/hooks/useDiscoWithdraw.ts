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
 * Parameters for withdrawing from LTV Disco
 */
interface UseDiscoWithdrawParams {
  /** The asset denom to withdraw from */
  asset: string
  /** Maximum LTV for the deposit tier */
  maxLtv: string
  /** Maximum borrow LTV for the deposit tier */
  maxBorrowLtv: string
  /** Amount of MBRN to withdraw (human-readable). If undefined, withdraws all. */
  amount?: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to withdraw MBRN tokens from a Disco deposit position.
 * 
 * **IMPORTANT**: This hook uses voting sandwich logic. If the user has active
 * votes in the emissions_voting contract, the withdraw message will be wrapped
 * with RemoveVote calls before and Vote calls after to allow the withdrawal.
 * 
 * @example
 * ```typescript
 * const withdraw = useDiscoWithdraw({
 *   asset: 'factory/osmo.../CDT',
 *   maxLtv: '0.75',
 *   maxBorrowLtv: '0.70',
 *   amount: '50', // or undefined to withdraw all
 *   txSuccess: () => console.log('Withdraw successful!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(withdraw.action, <Details />, { label: 'Withdraw', actionType: 'withdraw' })
 * ```
 */
const useDiscoWithdraw = ({
  asset,
  maxLtv,
  maxBorrowLtv,
  amount,
  txSuccess,
}: UseDiscoWithdrawParams) => {
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

  // Build the base withdraw message
  const { data: baseQueryData } = useQuery<QueryData>({
    queryKey: ['disco_withdraw', 'base_msgs', address, asset, maxLtv, maxBorrowLtv, amount],
    queryFn: () => {
      if (!address || !asset || !maxLtv || !maxBorrowLtv) {
        return { msgs: undefined }
      }
      if (!discoContract || discoContract === '') {
        return { msgs: undefined }
      }

      const withdrawMsg: any = {
        asset,
        max_ltv: maxLtv,
        max_borrow_ltv: maxBorrowLtv,
      }

      // If amount provided, include it; otherwise withdraws all
      if (amount) {
        const microAmount = shiftDigits(amount, 6).dp(0).toString()
        withdrawMsg.amount = microAmount
      }

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: discoContract,
          msg: toUtf8(JSON.stringify({ withdraw: withdrawMsg })),
          funds: [],
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!asset && !!maxLtv && !!maxBorrowLtv,
  })

  const baseMsgs = baseQueryData?.msgs ?? []

  // Use voting sandwich to wrap withdraw message if user has active votes
  const { sandwichedMsgs, hasVotes, isLoading: isSandwichLoading } = useEmissionsVotingSandwich({
    emissionsVotingContract,
    actionMsgs: baseMsgs,
    enabled: !!baseMsgs?.length && !!emissionsVotingContract,
  })

  const msgs = sandwichedMsgs

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['disco_user_deposits'] })
    queryClient.invalidateQueries({ queryKey: ['disco_ltv_queue'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['emissions_user_votes'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['disco_withdraw_sim', (msgs?.toString() ?? '0')],
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

export default useDiscoWithdraw

























