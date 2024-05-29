import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import useSimulate from './useSimulate'
import useTransaction from './useTransaction'
import { QueryKey } from '@tanstack/react-query'

type SimulateAndBroadcast = {
  simulate: ReturnType<typeof useSimulate>
  tx: ReturnType<typeof useTransaction>
}

type Props = {
  msgs?: MsgExecuteContractEncodeObject[]
  queryKey?: QueryKey
  enabled?: boolean
  amount?: string
  onSuccess?: () => void
}

const useSimulateAndBroadcast = ({
  msgs,
  queryKey,
  amount,
  onSuccess,
}: Props): SimulateAndBroadcast => {
  const simulate = useSimulate({
    msgs,
    amount,
    queryKey,
  })

  const [fee] = simulate.data || []

  const tx = useTransaction({
    msgs,
    fee,
    onSuccess,
  })

  return {
    simulate,
    tx,
  }
}

export default useSimulateAndBroadcast
