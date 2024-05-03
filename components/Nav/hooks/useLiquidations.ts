import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { getTimeLeft } from '@/components/Stake/Unstaking'
import { useMemo } from 'react'
import { isGreaterThanZero, num } from '@/helpers/num'
import { denoms } from '@/config/defaults'
import { claimstoCoins } from '@/services/liquidation'

import { getRiskyPositions } from '@/services/cdp'
import { useBasketPositions } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { get } from 'lodash'
import { getLiquidationMsgs } from '@/helpers/mint'

export type Liq = {
    position_id: string
    position_fee: number
}

type QueryData = {
  msgs: MsgExecuteContractEncodeObject[] | undefined
  liquidating_positions: Liq[]
}

const useProtocolLiquidations = () => {
  const liquidating_positions: Liq[] = [];
  const { address } = useWallet()

  const { data: prices } = useOraclePrice()
  const { data: allPositions } = useBasketPositions()
  //For metric purposes
//   console.log("total # of CDPs: ", allPositions?.length)
  //
//   let liq = allPositions?.find((pos) => pos.positions[0].position_id === '282')
//   console.log(liq)
  
//   const liq = useMemo(() =>{
//     return getRiskyPositions(allPositions, prices).filter((pos) => pos !== undefined) as {address: string, id: string, fee: number}[]
//     },
//   [allPositions, prices])

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['msg liquidations', address, allPositions, prices],
    queryFn: () => {
        if (!address) return {msgs: undefined, liquidating_positions: []}

        var msgs = [] as MsgExecuteContractEncodeObject[]

        const liq = getRiskyPositions(allPositions, prices).filter((pos) => pos !== undefined) as {address: string, id: string, fee: number}[]
        console.log(liq)

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
    if (!queryData) return {msgs: undefined, liquidating_positions: liquidating_positions}
    else return queryData
  }, [queryData])
  

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['balances'] })
  }

  return {action: useSimulateAndBroadcast({
    msgs,
    enabled: !!msgs,
    onSuccess,
  }), liquidating_positions: liq_pos}
}

export default useProtocolLiquidations