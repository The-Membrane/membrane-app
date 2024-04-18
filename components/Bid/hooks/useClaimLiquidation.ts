import contracts from '@/config/contracts.json'
import { LiquidationQueueMsgComposer } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.message-composer'
import { ClaimsResponse } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.types'
import { StabilityPoolMsgComposer } from '@/contracts/codegen/stability_pool/StabilityPool.message-composer'
import { ClaimsResponse as SPClaimsResponse } from '@/contracts/codegen/stability_pool/StabilityPool.types'
import { num } from '@/helpers/num'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'

const useClaimLiquidation = (claims: ClaimsResponse[] = [], sp_claims: SPClaimsResponse | undefined) => {
  const { address } = useWallet()
  const claimKeys = claims.map((claim) => claim.bid_for)

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg claim liquidation', address, claimKeys],
    queryFn: () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]

      const messageComposer = new LiquidationQueueMsgComposer(address, contracts.liquidation)

      var msgs = claims
        .filter((claim) => num(claim.pending_liquidated_collateral).gt(0))
        .map((claim) => {
          return messageComposer.claimLiquidations({
            bidFor: {
              native_token: {
                denom: claim.bid_for,
              },
            },
          })
        })

      if (sp_claims && sp_claims.claims.length > 0) {
        const spMessageComposer = new StabilityPoolMsgComposer(address, contracts.stabilityPool)
        msgs = msgs.concat(
          spMessageComposer.claimRewards()
        )
      }

      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })

  return useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
  })
}

export default useClaimLiquidation
