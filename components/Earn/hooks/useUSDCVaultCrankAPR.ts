import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { transmuterAbi } from '@/contracts/abis/transmuter'
import { getContractAddress } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'

/**
 * Permissionless "crank" that refreshes the vault's rate/APR bookkeeping — migrated to EVM.
 *
 * Cosmos flow was marsUSDCvault.crank_a_p_r + earn.crank_realized_a_p_r. The EVM analog on the
 * Transmuter is the pair of permissionless, no-arg maintenance calls:
 *   crank_a_p_r          → Transmuter.addToRateHistory()   (append current conversion rate)
 *   crank_realized_a_p_r → Transmuter.updateVolumeWindow() (roll the volume window)
 * Two separate signatures (EvmCall[] is not atomic — see services/chain/types.ts), which is fine:
 * each crank is independent and idempotent.
 */
const useUSDCVaultCrankAPR = () => {
  const { address, chain } = useWallet()
  const transmuterAddr = chain ? getContractAddress(chain.id, 'transmuter') : undefined

  const { data: queryData } = useQuery<{ msgs: EvmCall[] | undefined }>({
    queryKey: ['earn_page_management_crank_msg_creation', address, transmuterAddr],
    queryFn: () => {
      if (!address || !transmuterAddr) return { msgs: undefined }
      const msgs: EvmCall[] = [
        {
          address: transmuterAddr,
          abi: transmuterAbi,
          functionName: 'addToRateHistory',
          args: [],
        },
        {
          address: transmuterAddr,
          abi: transmuterAbi,
          functionName: 'updateVolumeWindow',
          args: [],
        },
      ]
      return { msgs }
    },
    enabled: !!address && !!transmuterAddr,
  })

  const { msgs } = useMemo(() => queryData ?? { msgs: undefined }, [queryData])

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['useEarnUSDCRealizedAPR'] })
    queryClient.invalidateQueries({ queryKey: ['useEarnUSDCEstimatedAPR'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['earn_page_management_crank_apr', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs,
    }),
  }
}

export default useUSDCVaultCrankAPR
