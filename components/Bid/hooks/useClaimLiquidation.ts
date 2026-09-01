import { ClaimsResponse } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.types'
import { ClaimsResponse as SPClaimsResponse } from '@/contracts/codegen/stability_pool/StabilityPool.types'
import { num } from '@/helpers/num'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useRouter } from 'next/router'
import type { EvmCall } from '@/services/chain/types'
import { liqQueueAbi } from '@/contracts/abis'
import { getContractAddress } from '@/config/evm/contracts'
import { assetKey, getUserBids } from '@/services/chain/liquidation'
import { getPublicClient } from '@/services/chain/client'

const onSuccess = () => {
  queryClient.invalidateQueries({ queryKey: ['liquidation claims'] })
  queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
  queryClient.invalidateQueries({ queryKey: ['user bids'] })
  queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  //Reset points queries
  queryClient.invalidateQueries({ queryKey: ['all users points'] })
  queryClient.invalidateQueries({ queryKey: ['one users points'] })
  queryClient.invalidateQueries({ queryKey: ['one users level'] })

}

const useClaimLiquidation = (claims: ClaimsResponse[] = [], sp_claims: SPClaimsResponse | undefined, run: boolean) => {
  const { address, chain } = useWallet()
  const claimKeys = claims.map((claim) => claim.bid_for)
  const router = useRouter()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['msg claim liquidation', address, claimKeys, run, router.pathname],
    queryFn: async () => {
      if (router.pathname != "/bid" && !run) return
      if (!address || claimKeys.length === 0) return [] as EvmCall[]

      const liqQueue = getContractAddress(chain.id, 'liqQueue')
      if (!liqQueue) return [] as EvmCall[]

      // LiqQueue.claimLiquidations(asset, bidIds) needs the user's bid ids, which the
      // service reconstructs from BidSubmitted events.
      const client = getPublicClient()
      // Each claim queries an independent asset's user bids — fan out, then keep the
      // resolved calls in claim order (Promise.all preserves map order).
      const maybeCalls = await Promise.all(
        claims.map(async (claim): Promise<EvmCall | null> => {
          if (!num(claim.pending_liquidated_collateral).gt(0)) return null
          const asset = assetKey(claim.bid_for)
          const bids = await getUserBids(client, asset, address)
          const bidIds = (bids ?? []).flatMap((b) => (b.pendingLiquidatedCollateral > 0n ? [b.id] : []))
          if (bidIds.length === 0) return null
          return {
            address: liqQueue,
            abi: liqQueueAbi,
            functionName: 'claimLiquidations',
            args: [asset, bidIds],
          }
        }),
      )
      const calls: EvmCall[] = maybeCalls.filter((c): c is EvmCall => c !== null)

      // TODO(evm-migration): sp_claims dropped — the Solidity port has no stability pool
      // (LiquidationEngine/LtvDisco replace it by design). Points bracketing (checkClaims/
      // givePoints) also dropped — PointsSystem.sol awards points on-chain via authorized
      // sources, not user msgs.

      return calls
    },
    enabled: !!address,
  })

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['claim liquidation sim', (msgs?.toString() ?? '0')],
      onSuccess,
    }), msgs
  }
}

export default useClaimLiquidation