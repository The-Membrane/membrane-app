import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import { useMemo } from 'react'
import type { EvmCall } from '@/services/chain/types'

export type Liq = {
  position_id: string
  position_fee: string
}

type QueryData = {
  msgs: EvmCall[] | undefined
  liquidating_positions: Liq[]
}

/**
 * TODO(evm-migration): protocol-wide keeper liquidations are stubbed. The Cosmos flow
 * scanned ALL positions (useBasketPositions) and risk-scored them client-side
 * (getRiskyPositions) — Cdp.sol has no position-enumeration view, so the scan needs an
 * indexer or event reconstruction. The EVM write path exists (LiquidationEngine.sol /
 * LiqQueue.liquidate) once a liquidatable-position feed is available.
 */
const useProtocolLiquidations = ({ run }: { run: boolean }) => {
  const { address } = useWallet()

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['msg_liquidations', run, address],
    queryFn: () => {
      return { msgs: [], liquidating_positions: [] }
    },
    enabled: !!address,
  })

  const { msgs, liquidating_positions: liq_pos } = useMemo(() => {
    if (!queryData) return { msgs: [] as EvmCall[], liquidating_positions: [] as Liq[] }
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