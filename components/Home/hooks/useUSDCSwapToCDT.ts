import { useBasket } from '@/hooks/useCDP'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useQuickActionState from './useQuickActionState'
import { queryClient } from '@/pages/_app'
import { swapToCDTMsg } from '@/helpers/osmosis'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useOraclePrice } from '@/hooks/useOracle'
import { denoms } from '@/config/defaults'
import contracts from '@/config/contracts.json'

import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'

const useSwapToCDT = ({ onSuccess, run }: { onSuccess: () => void, run: boolean }) => {
  const { quickActionState } = useQuickActionState()

  const { address } = useWallet()
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  const usdcAsset = useAssetBySymbol('USDC')



  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'home_page_swap',
      address,
      quickActionState?.usdcSwapToCDT,
      quickActionState?.enterVaultToggle,
      prices,
      usdcAsset,
      run
    ],
    queryFn: () => {
      if (!address || !basket || !prices || !usdcAsset || quickActionState?.usdcSwapToCDT === 0 || !run) return { msgs: [] }
      var msgs = [] as MsgExecuteContractEncodeObject[]
      const cdtPrice = parseFloat(prices?.find((price) => price.denom === denoms.CDT[0])?.price ?? "0")

      //1) Swap USDC to CDT
      const { msg: swap, tokenOutMinAmount, foundToken } = swapToCDTMsg({
        address,
        swapFromAmount: quickActionState?.usdcSwapToCDT,
        swapFromAsset: usdcAsset,
        prices,
        cdtPrice,
        tokenOut: 'CDT'
      })
      msgs.push(swap as MsgExecuteContractEncodeObject)

      //2) Enter Vault (?)
      if (quickActionState?.enterVaultToggle) {
        const funds = [{ amount: tokenOutMinAmount.toString(), denom: denoms.CDT[0] as string }]
        let enterMsg = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: MsgExecuteContract.fromPartial({
            sender: address,
            contract: contracts.rangeboundLP,
            msg: toUtf8(JSON.stringify({
              enter_vault: {}
            })),
            funds: funds
          })
        } as MsgExecuteContractEncodeObject
        //Add msg
        msgs.push(enterMsg)
      }

      return { msgs }

    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs ?? []

  console.log("swap to cdt msgs", msgs)

  const onInitialSuccess = () => {
    onSuccess()
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_swap_sim', (msgs?.toString() ?? "0")],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    })
  }
}

export default useSwapToCDT
