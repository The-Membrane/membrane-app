import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasketPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
// import useMintState from './useMintState'
import { buildBidMsg } from '@/services/liquidation'
import useBidState from './useBidState'
import { decodeMsgs } from '@/helpers/decodeMsg'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { shiftDigits } from '@/helpers/math'
import { coin } from '@cosmjs/stargate'
import { queryClient } from '@/pages/_app'

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

      const msg = buildBidMsg({
        address,
        asset: selectedAsset,
        liqPremium: premium,
        funds,
      })
      return [msg] as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address && !!selectedAsset && !!premium && !!cdt,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['liquidation info'] })
    queryClient.invalidateQueries({ queryKey: ['user bids'] })
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
