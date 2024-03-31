import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { getSigningLiquidationClient } from '@/services/liquidation'
import { getSigningStakingClient } from '@/services/staking'

const useClaimLiquidation = (restake = false) => {
  const { address, getSigningCosmWasmClient } = useWallet()

  return useExecute({
    onSubmit: async () => {
      if (!address) return Promise.reject('No address found')
      const signingClient = await getSigningCosmWasmClient()
      const client = getSigningLiquidationClient(signingClient, address)
      return client.claimLiquidations({})
    },
  })
}

export default useClaimLiquidation
