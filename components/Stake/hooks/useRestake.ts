import { useChainRoute } from '@/hooks/useChainRoute'
import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { getSigningStakingClient } from '@/services/staking'

const useRestake = (mbrnAmount?: string) => {
  const { chainName } = useChainRoute()
  const { address, getSigningCosmWasmClient } = useWallet(chainName)

  return useExecute({
    onSubmit: async () => {
      if (!address) return Promise.reject('No address found')

      if (!mbrnAmount || Number(mbrnAmount) <= 0) return Promise.reject('No amount found')

      const signingClient = await getSigningCosmWasmClient()
      const client = getSigningStakingClient(signingClient, address)
      return client.restake({ mbrnAmount })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staked'] })
    },
  })
}

export default useRestake
