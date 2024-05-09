import { getDepostAndWithdrawMsgs, getMintAndRepayMsgs } from '@/helpers/mint'
import { useBasket, useUserPositions } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { useEffect, useMemo } from 'react'
import { LPMsg, swapToMsg } from '@/helpers/osmosis'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useOraclePrice } from '@/hooks/useOracle'

const useQuickAction = () => {
  const { quickActionState } = useQuickActionState()
  const { summary = [] } = quickActionState
  const { address } = useWallet()
  const { data: basketPositions, ...basketErrors } = useUserPositions()
  const { data: basket } = useBasket()
  const usdcAsset = useAssetBySymbol("USDC")
  const { data: prices } = useOraclePrice()
  const cdtAsset = useAssetBySymbol('CDT')

  /////First we'll do new positions only, but these actions will be usable by all positions & multiple per user in the future//////

  //Use first position id or use the basket's next position ID (for new positions)
  const positionId = useMemo(() => {
    if (basketPositions !== undefined) {
      return basketPositions?.[0]?.positions?.[0]?.position_id
    } else {
      //Use the next position ID
      return basket?.current_position_id ?? ""
    }
  }, [basket, basketPositions])

  const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
    queryKey: [
      'mint',
      address,
      positionId,
      summary?.map((s: any) => String(s.amount)) || '0',
      quickActionState?.mint,
      quickActionState?.selectedAsset,
      usdcAsset,
      prices,
      cdtAsset
    ],
    queryFn: () => {
      console.log(!address, !basket, !usdcAsset, !prices, !cdtAsset)
      if (!address || !basket || !usdcAsset || !prices || !cdtAsset) return
      const deposit = getDepostAndWithdrawMsgs({ summary, address, positionId, hasPosition: basketPositions !== undefined })
      const mint = getMintAndRepayMsgs({
        address,
        positionId,
        mintAmount: quickActionState?.mint,
        repayAmount: 0,
      })
      const { msg: swap, tokenOutMinAmount } = swapToMsg({
        address, 
        cdtAmount: quickActionState?.mint??0, 
        swapToAsset: usdcAsset,
        prices,
        cdtAsset,
      })   
      var msgs = [] as MsgExecuteContractEncodeObject[]
      msgs = msgs.concat(deposit)
      msgs = msgs.concat(mint)
      msgs.push(swap as MsgExecuteContractEncodeObject)      
      console.log(msgs)
      const lp = LPMsg({
        address,
        cdtInAmount: quickActionState?.mint??0,
        cdtAsset,
        pairedAssetInAmount: tokenOutMinAmount,
        pairedAsset: usdcAsset,
        poolID: 1268,
      })
      msgs.push(lp as MsgExecuteContractEncodeObject)

      return msgs as MsgExecuteContractEncodeObject[]
    },
    enabled: !!address,
  })

  const onSuccess = () => {    
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: [],
    enabled: !!msgs,
    onSuccess,
  })
}

export default useQuickAction
