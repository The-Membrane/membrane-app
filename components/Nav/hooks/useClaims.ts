import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import useCheckSPClaims from '@/components/Bid/hooks/useCheckSPClaims'
import useCheckClaims from '@/components/Bid/hooks/useCheckClaims'
import useClaimLiquidation from '@/components/Bid/hooks/useClaimLiquidation'
import { useStakingClaim } from '@/components/Stake/hooks/useStakingClaim'
import useStaked from '@/components/Stake/hooks/useStaked'
import { getTimeLeft } from '@/components/Stake/Unstaking'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useMemo } from 'react'
import { isGreaterThanZero, num } from '@/helpers/num'
import useClaimFees from '@/components/Lockdrop/hooks/useClaimFees'
import useWithdrawStabilityPool from '@/components/Bid/hooks/useWithdrawStabilityPool'
import useStabilityAssetPool from '@/components/Bid/hooks/useStabilityAssetPool'
import { getSPTimeLeft } from '@/components/Bid/StabilityPool'
import useClaimUnstake from '@/components/Stake/hooks/useClaimUnstake'
import { Coin } from '@cosmjs/stargate'
import { denoms } from '@/config/defaults'
import { claimstoCoins } from '@/services/liquidation'
import useAllocation from '@/components/Lockdrop/hooks/useAllocation'
import { m } from 'framer-motion'

type ClaimsSummary = {
  liquidation: Coin[]
  sp_unstaking: Coin[]
  staking: Coin[]
  vesting: Coin[]
}

type QueryData = {
  msgs: MsgExecuteContractEncodeObject[] | undefined
  claims: ClaimsSummary
}

const useProtocolClaims = () => {
  const claims_summary: ClaimsSummary = {
    liquidation: [],
    sp_unstaking: [],
    staking: [],
    vesting: []
  };
  const { address } = useWallet()

  //Liquidations
  const { data: claims } = useCheckClaims()
  const { data: SP_claims } = useCheckSPClaims()
  const claimLiq = useClaimLiquidation(claims, SP_claims)
  //SP Unstaking  
  const { data: stabilityPoolAssets } = useStabilityAssetPool()
  const { deposits = [] } = stabilityPoolAssets || {}

  //Staking
  const { data } = useStaked()        
  const { staked = [], unstaking = [], rewards = []} = data || {}  
  const stakingClaim = useStakingClaim(false)
  const unstakeClaim = useClaimUnstake()
  const mbrnAsset = useAssetBySymbol('MBRN')
  //Sum claims
  const mbrnClaimable = useMemo(() => {
  if (!rewards || !mbrnAsset) return '0.00'

    const reward = rewards.reduce((acc, reward) => {
      if (reward?.asset?.symbol === 'MBRN') {
        return acc.plus(reward?.amount)
      }
      return acc.plus(0)
    }, num(0))

    return reward.toString()
  }, [rewards, staked, mbrnAsset])
  const cdtClaimable = useMemo(() => {
    if (!rewards || !mbrnAsset) return '0.00'

    const reward = rewards.reduce((acc, reward) => {
      if (reward?.asset?.symbol === 'CDT') {
        return acc.plus(reward?.amount)
      }
      return acc.plus(0)
    }, num(0))

    return reward.toString()
  }, [rewards, staked, mbrnAsset])
  //

  //Vesting
  const claimFees = useClaimFees()
  const { data: allocations } = useAllocation()
  const { claimables } = allocations || {}

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['msg all protocol claims', address, claims, SP_claims, unstaking, claimables, deposits, mbrnClaimable, cdtClaimable],
    queryFn: () => {
        var msgs = [] as MsgExecuteContractEncodeObject[]

        /////Add Liquidation claims/////        
        if (!claimLiq?.action.simulate.isError && (claims || SP_claims)){
          //If SP_claims is undefined, make sure LQ_claims aren't all 0
          let nonZeroClaims = claims?.filter((claim) => num(claim.pending_liquidated_collateral).isGreaterThan(0)) || []
          //add msg
          if (nonZeroClaims.length > 0 || SP_claims){
            msgs = msgs.concat(claimLiq.msgs ?? [])
          }
        }
        /////Add Staking reward and Stake Claims////
        //If there is anything to claim, claim
        if (isGreaterThanZero(mbrnClaimable) || isGreaterThanZero(cdtClaimable)) {
          if (!stakingClaim?.action.simulate.isError){
            msgs = msgs.concat(stakingClaim.msgs ?? [])
          }
        }
        //If there is anything to unstake, unstake
        if (unstaking?.find((unstake: any, index: number) => {            
            const { minutesLeft } = getTimeLeft(unstake?.unstake_start_time)
            minutesLeft <= 0
        })){          
          if (!unstakeClaim?.action.simulate.isError){
            msgs = msgs.concat(unstakeClaim.msgs ?? [])         
          }
        }
        /////Add Vesting Claims////
        if (!claimFees?.action.simulate.isError && (claimables?.length??0) > 0){
          msgs = msgs.concat(claimFees.msgs ?? [])
        }

        ///Add SP Unstaking////
        //sum the deposits that are ready to be withdrawn
        // const totalwithdrawableDeposits = deposits.reduce((acc, deposit) => {
        //     if (deposit.unstake_time) {
        //       //How much time left
        //       const { minutesLeft } = getSPTimeLeft(deposit.unstake_time)
        //       if (minutesLeft <= 0) {
        //         return acc + Number(deposit.amount)
        //       }
        //     }
        //     return acc
        // }, 0)
        // if (totalwithdrawableDeposits > 0){
        //     const SPwithdraw = useWithdrawStabilityPool(totalwithdrawableDeposits.toString())
            
        //     if (!SPwithdraw?.action.simulate.isError){
        //       msgs = msgs.concat(SPwithdraw.msgs ?? [])
        //       //Update claims summary
        //       claims_summary.sp_unstaking = [{
        //         denom: denoms.CDT[0] as string,
        //         amount: totalwithdrawableDeposits.toString()              
        //       }]
        //     }
        // }

        ///Summary        
        if (claims){
          claims_summary.liquidation = claimstoCoins(claims)
        }
        if (SP_claims){
          claims_summary.liquidation = claims_summary.liquidation.concat(SP_claims.claims)
        }
        if (claimables){
          claims_summary.vesting = claimables.map((claimable) => {
            if (!claimable) return { denom: '', amount: '0'}
            return {
              denom: claimable.info.native_token.denom,
              amount: claimable.amount
            }
          })
        }        
      //Add claims to summary
      if (isGreaterThanZero(mbrnClaimable)){
        claims_summary.staking.push({
          denom: mbrnAsset?.base as string,
          amount: mbrnClaimable
        })        
      }
      if (isGreaterThanZero(cdtClaimable)){
        claims_summary.staking.push({
          denom: denoms.CDT[0] as string,
          amount: cdtClaimable
        })
      }
      //Update claims summary with unstaking
      claims_summary.staking = claims_summary.staking.concat(unstaking.map((unstake) => {
        if (!unstake) return
        if (getTimeLeft(unstake?.unstake_start_time).minutesLeft <= 0) {           
        return {
          denom: mbrnAsset?.base as string,
          amount: unstake?.amount
        }
      }}))      

      return {msgs, claims: claims_summary}
    },
    enabled: !!address,
  })
  
  const { msgs, claims: queryclaimsSummary } = useMemo(() => {
    if (!queryData) return {msgs: undefined, claims: claims_summary}
    else return queryData
  }, [queryData])
  

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['liquidation claims'] })
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['allocation claim fees'] })
    queryClient.invalidateQueries({ queryKey: ['stability pool claims'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  
  //Transform claim summary to a single list of Coin
  const claims_summ = Object.values(queryclaimsSummary).reduce((acc, val) => acc.concat(val), [])
  //Aggregate coins in claims that have the same denom
  const definedClaims = claims_summ.filter((coin) => coin !== undefined)
  const agg_claims = definedClaims.filter((coin) => num(coin.amount).isGreaterThan(0))
  .reduce((acc, claim) => {
    const existing = acc.find((c) => c.denom === claim.denom)
    if (existing) {
      //Remove claim from acc
      acc = acc.filter((c) => c.denom !== claim.denom)
      //Add new
      acc.push({
        denom: claim.denom,
        amount: num(claim.amount).plus(existing.amount).toString(),
      })
    } else {
      acc.push(claim)
    }
    return acc
  }, [] as Coin[])
  console.log(agg_claims)

  return {action: useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
    onSuccess,
  }), claims_summary: agg_claims}
}

export default useProtocolClaims