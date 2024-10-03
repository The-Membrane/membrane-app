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
import { queryClient } from '@/pages/_app'
import { PointsMsgComposer } from '@/contracts/codegen/points/Points.message-composer'

const useClaimLiquidation = (claims: ClaimsResponse[] = [], sp_claims: SPClaimsResponse | undefined) => {
  const { address } = useWallet()
  const claimKeys = claims.map((claim) => claim.bid_for)

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg claim liquidation', address, claimKeys, sp_claims],
    queryFn: () => {
      if (!address || (claimKeys.length === 0 && !sp_claims)) return [] as MsgExecuteContractEncodeObject[]

      const messageComposer = new LiquidationQueueMsgComposer(address, contracts.liquidation)
      const pointsMessageComposer = new PointsMsgComposer(address, contracts.points)

      //Start msgs with a ClaimCheck so we can award points
      var msgs = [ pointsMessageComposer.checkClaims({
        cdpRepayment: undefined,
        spClaims: sp_claims ? true : false,
        lqClaims: claimKeys.length > 0,
      }) ] as MsgExecuteContractEncodeObject[]

      msgs = msgs.concat(claims
        .filter((claim) => num(claim.pending_liquidated_collateral).gt(0))
        .map((claim) => {
          return messageComposer.claimLiquidations({
            bidFor: {
              native_token: {
                denom: claim.bid_for,
              },
            },
          })
        }))

      if (sp_claims && sp_claims.claims.length > 0) {
        const spMessageComposer = new StabilityPoolMsgComposer(address, contracts.stabilityPool)
        msgs = msgs.concat(
          spMessageComposer.claimRewards()
        )
      }

      //End msgs with GivePoints to allocate points from claims
      msgs.push(
        pointsMessageComposer.givePoints({
          cdpRepayment: false,
          spClaims: sp_claims ? true : false,
          lqClaims: claimKeys.length > 0,
        })
      )

      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })

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

  return {
    action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['claim liquidation sim', (msgs?.toString() ?? '0')],
    onSuccess,
  }), msgs}
}

export default useClaimLiquidation