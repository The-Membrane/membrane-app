import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQueries, useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'

import { getRiskyPositions, getUserDiscount } from '@/services/cdp'
import { useBasket, useBasketAssets, useBasketPositions, useCollateralInterest, useUserDiscount } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getLiquidationMsgs } from '@/helpers/mint'
import useBidState from '@/components/Bid/hooks/useBidState'
import useStaked from '@/components/Stake/hooks/useStaked'

export type Liq = {
  position_id: string
  position_fee: string
}

type QueryData = {
  msgs: MsgExecuteContractEncodeObject[] | undefined
  liquidating_positions: Liq[]
}

const useProtocolLiquidations = ({ run }: { run: boolean }) => {
  const liquidating_positions: Liq[] = [];
  const { address } = useWallet()

  const { data: prices } = useOraclePrice()
  const { data: allPositions } = useBasketPositions()
  const { data: basket } = useBasket()
  const { data: basketAssets } = useBasketAssets()



  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['msg_liquidations', run, address, allPositions, prices, basket, basketAssets],
    queryFn: () => {
      if (!address || !allPositions || !prices || !basket || !basketAssets || !run) {
        console.log("liq attempt", !address, !allPositions, !prices, !basket, !basketAssets, !run);
        return { msgs: [], liquidating_positions: [] }
      }

      //For metric purposes
      console.log("total # of CDPs: ", allPositions?.length)
      var msgs = [] as MsgExecuteContractEncodeObject[]

      const cdpCalcs = getRiskyPositions(allPositions, prices, basket, basketAssets)
      console.log("liquidatible positions:", cdpCalcs.liquidatibleCDPs)
      const liq = cdpCalcs.liquidatibleCDPs.filter((pos) => pos !== undefined) as { address: string, id: string, fee: string }[]
      console.log("liquidatible positions:", liq)


      if (liq.length > 0) {
        const liq_msgs = getLiquidationMsgs({ address, liq_info: liq })
        msgs = msgs.concat(liq_msgs)

        liq.map((pos) => {
          liquidating_positions.push({
            position_id: pos.id,
            position_fee: pos.fee
          })
        })
      }

      return { msgs, liquidating_positions }
    },
    enabled: !!address,
  })

  const { msgs, liquidating_positions: liq_pos } = useMemo(() => {
    if (!queryData) return { msgs: [], liquidating_positions: liquidating_positions }
    else return queryData
  }, [queryData])


  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    queryClient.invalidateQueries({ queryKey: ['msg_liquidations'] })
    queryClient.invalidateQueries({ queryKey: ['protocol_liquidation_sim'] })
    //Reset points queries
    queryClient.invalidateQueries({ queryKey: ['all users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users level'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['protocol_liquidation_sim', (msgs?.toString() ?? '0')],
      onSuccess,
    }), liquidating_positions: liq_pos
  }
}

export default useProtocolLiquidations