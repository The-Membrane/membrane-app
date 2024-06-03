import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import useSimulate from './useSimulate'
import useTransaction from './useTransaction'

type SimulateAndBroadcast = {
  simulate: ReturnType<typeof useSimulate>
  tx: ReturnType<typeof useTransaction>
}

type Props = {
  msgs?: MsgExecuteContractEncodeObject[]
  queryKey?: string[]
  enabled?: boolean
  amount?: string
  onSuccess?: () => void
  chain_id?: string
}

const useSimulateAndBroadcast = ({
  msgs,
  queryKey,
  amount,
  onSuccess,
  chain_id = 'osmosis',
}: Props): SimulateAndBroadcast => {
  const simulate = useSimulate({
    msgs,
    amount,
    queryKey,
    chain_id
  })

  const [fee] = simulate.data || []

  const tx = useTransaction({
    msgs,
    fee,
    onSuccess,
    chain_id
  })

  return {
    simulate,
    tx,
  }
}

export default useSimulateAndBroadcast
