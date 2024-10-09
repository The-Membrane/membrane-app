import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'

import { getRiskyPositions } from '@/services/cdp'
import { useBasket, useBasketPositions, useCollateralInterest, useUserDiscountValue } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getLiquidationMsgs } from '@/helpers/mint'
import useBidState from '@/components/Bid/hooks/useBidState'

export type Liq = {
    position_id: string
    position_fee: string
}

type QueryData = {
  msgs: MsgExecuteContractEncodeObject[] | undefined
  liquidating_positions: Liq[]
}

const useProtocolLiquidations = () => {
  const liquidating_positions: Liq[] = [];
  const { address } = useWallet()
  const { setBidState } = useBidState()

  const { data: prices } = useOraclePrice()
  const { data: allPositions } = useBasketPositions()
  const { data: basket } = useBasket()
  const { data: interest } = useCollateralInterest()

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['msg liquidations', address, allPositions, prices, basket, interest],
    queryFn: () => {
        if (!address || !allPositions || !prices || !basket || !interest) {console.log("liq attempt", !address, !allPositions, !prices, !basket, !interest); return { msgs: [], liquidating_positions: [] }}

        //For metric purposes
        console.log("total # of CDPs: ", allPositions?.length)
        var msgs = [] as MsgExecuteContractEncodeObject[]
        
        const cdpCalcs = getRiskyPositions(true, allPositions, prices, basket, interest)
        const liq = cdpCalcs.liquidatibleCDPs.filter((pos) => pos !== undefined) as {address: string, id: string, fee: string}[]
        console.log("liquidatible positions:", liq)
        console.log("undiscounted total expected annual revenue", cdpCalcs.undiscountedTER.toString())
        console.log("total expected annual revenue", cdpCalcs.totalExpectedRevenue.toString())
        setBidState({cdpExpectedAnnualRevenue: cdpCalcs.totalExpectedRevenue})
        

        if (liq.length > 0) {
            const liq_msgs = getLiquidationMsgs({address, liq_info: liq})
            msgs = msgs.concat( liq_msgs )

            liq.map((pos) => {
                liquidating_positions.push({
                    position_id: pos.id,
                    position_fee: pos.fee
                })
            })
        }

        return {msgs, liquidating_positions}
    },
    enabled: !!address,
  })
  
  const { msgs, liquidating_positions: liq_pos } = useMemo(() => {
    if (!queryData) return { msgs: [], liquidating_positions: liquidating_positions }
    else return queryData
  }, [queryData])
  

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
    queryClient.invalidateQueries({ queryKey: ['msg liquidations'] })
    //Reset points queries
    queryClient.invalidateQueries({ queryKey: ['all users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users points'] })
    queryClient.invalidateQueries({ queryKey: ['one users level'] })
  }

  return {action: useSimulateAndBroadcast({
    msgs,
    queryKey: ['protocol liquidation sim', (msgs?.toString() ?? '0')],
    onSuccess,
  }), liquidating_positions: liq_pos}
}

export default useProtocolLiquidations