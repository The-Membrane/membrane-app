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
import { shiftDigits } from '@/helpers/math'
import { isGreaterThanZero } from '@/helpers/num'

const useProtocolClaims = () => {
  const { address } = useWallet()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['msg all protocol claims', address],
    queryFn: () => {
        
        /////Add Liquidation claims/////        
        const { data: claims } = useCheckClaims()
        const { data: SP_claims } = useCheckSPClaims()
        var msgs = useClaimLiquidation(claims, SP_claims).msgs ?? []
        /////Add Staking Claims////
        const { data } = useStaked()        
        const { staked = [] } = data || {}
        const { unstaking = [] } = data || {}
        const mbrnAsset = useAssetBySymbol('MBRN')
        const claimable = useMemo(() => {
            if (!staked?.rewards || !mbrnAsset) return '0.00'
        
            return shiftDigits(staked?.rewards?.accrued_interest, -mbrnAsset?.decimal).toString()
          }, [staked, mbrnAsset])

        //If there is anything to claim, claim
        if (isGreaterThanZero(claimable)) msgs.concat(useStakingClaim(false).msgs ?? [])
        //If there is anything to unstake, unstake
        if (unstaking?.find((unstake: any, index: number) => {            
            const { minutesLeft } = getTimeLeft(unstake?.unstake_start_time)
            minutesLeft <= 0
        })){
            msgs.concat(useStakingClaim(false).msgs ?? [])
        }
        /////Add Vesting Claims////

        ///Add SP Unstaking////


      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['liquidation claims'] })
    queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
    queryClient.invalidateQueries({ queryKey: ['user bids'] })
    queryClient.invalidateQueries({ queryKey: ['staked'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
    onSuccess,
  })
}

export default useClaimLiquidation
