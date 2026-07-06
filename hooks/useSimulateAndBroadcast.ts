import useSimulate from './useSimulate'
import useTransaction from './useTransaction'
import type { EvmCall } from '@/services/chain/types'

type SimulateAndBroadcast = {
  simulate: ReturnType<typeof useSimulate>
  tx: ReturnType<typeof useTransaction>
}

type Props = {
  msgs?: EvmCall[]
  queryKey?: string[]
  enabled?: boolean
  amount?: string
  onSuccess?: () => void
  /** legacy param, ignored — chain comes from the wagmi account context */
  chain_id?: string
  shrinkMessage?: boolean
}

const useSimulateAndBroadcast = ({
  msgs,
  queryKey,
  amount,
  onSuccess,
  enabled = false,
  shrinkMessage = false,
}: Props): SimulateAndBroadcast => {
  const simulate = useSimulate({
    msgs,
    amount,
    queryKey,
    enabled,
  })

  const [fee] = simulate.data || []

  const tx = useTransaction({
    msgs,
    fee,
    onSuccess,
    shrinkMessage,
  })

  return {
    simulate,
    tx,
  }
}

export default useSimulateAndBroadcast
