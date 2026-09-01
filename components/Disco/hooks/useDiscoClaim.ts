import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import useAppState from '@/persisted-state/useAppState'

/**
 * Parameters for claiming revenue from Disco
 */
interface UseDiscoClaimParams {
  /** The asset denom to claim revenue for */
  asset: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to claim pending CDT revenue from Disco deposits.
 * Routes through the points contract's ClaimDiscoRevenueAndGivePoints to earn points.
 * The points contract wraps the disco claim as a submessage and awards disco_revenue points.
 *
 * @example
 * ```typescript
 * const claim = useDiscoClaim({
 *   asset: 'ibc/...',
 *   txSuccess: () => console.log('Claim successful!'),
 * })
 * ```
 */
const useDiscoClaim = ({
  asset,
  txSuccess,
}: UseDiscoClaimParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()
  const pointsContract = contracts.points

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['disco_claim', 'msgs', address, asset, appState.rpcUrl],
    staleTime: 1000 * 60 * 5,
    queryFn: () => {
      if (!address || !asset) {
        return { msgs: undefined }
      }
      if (!pointsContract || pointsContract === '') {
        return { msgs: undefined }
      }

      // Route through points contract to earn disco_revenue points.
      // The points contract forwards claim_revenue_for_user to the disco contract
      // as a submessage and awards points based on the revenue_claimed reply attribute.
      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: pointsContract,
          msg: toUtf8(JSON.stringify({
            claim_disco_revenue_and_give_points: {
              user: address,
              asset,
            }
          })),
          funds: [],
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!asset,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['disco'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    // Invalidate points queries after earning disco_revenue points
    queryClient.invalidateQueries({ queryKey: ['all users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users level'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['disco_claim_sim', address, asset],
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useDiscoClaim
