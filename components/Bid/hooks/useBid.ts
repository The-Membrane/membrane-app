import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { queryClient } from '@/pages/_app'
import { buildBidMsg } from '@/services/liquidation'
import { coin } from '@cosmjs/stargate'
import useBidState from './useBidState'
import { buildStabilityPooldepositMsg } from '@/services/stabilityPool'

type Props = {
  txSuccess?: () => void
}

const useBid = ({ txSuccess }: Props) => {
  const { bidState } = useBidState()
  const cdtAsset = useAssetBySymbol('CDT')
  const selectedAsset = bidState?.selectedAsset
  const { premium, cdt } = bidState?.placeBid
  const { address } = useWallet()

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: ['bid', 'msgs', address, selectedAsset?.base, premium, cdt],
    queryFn: () => {
      if (!address || !selectedAsset) return

      const microAmount = shiftDigits(cdt, 6).dp(0).toString()
      const funds = [coin(microAmount, cdtAsset?.base!)]
      console.log(premium)
      var msg;
      if (premium === 10){
        msg = buildStabilityPooldepositMsg({ address, funds })
      } else {
        msg = buildBidMsg({
          address,
          asset: selectedAsset,
          liqPremium: premium,
          funds,
        })
      }      
      return [msg] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address && !!selectedAsset && !!cdt,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
    queryClient.invalidateQueries({ queryKey: ['user bids'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: [],
    amount: cdt.toString(),
    enabled: !!msgs,
    onSuccess,
  })
}

export default useBid
