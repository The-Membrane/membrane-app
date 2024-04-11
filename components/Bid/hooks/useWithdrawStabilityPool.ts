import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { getSigningStabiityPoolClient } from '@/services/stabilityPool'

const useWithdrawStabilityPool = (amount: string) => {
  const { address, getSigningCosmWasmClient } = useWallet()

  return useExecute({
    onSubmit: async () => {
      if (!address) return Promise.reject('No address found')
      const signingClient = await getSigningCosmWasmClient()
      const client = getSigningStabiityPoolClient(signingClient, address)
      return client.withdraw({ amount })
    },
  })
}

export default useWithdrawStabilityPool
