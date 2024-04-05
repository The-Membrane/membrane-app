import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { getSigningVestingClient } from '@/services/vesting'

const useClaimFees = () => {
  const { address, getSigningCosmWasmClient } = useWallet()

  return useExecute({
    onSubmit: async () => {
      if (!address) return Promise.reject('No address found')
      const signingClient = await getSigningCosmWasmClient()
      const client = getSigningVestingClient(signingClient, address)
      return client.claimFeesforRecipient()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['allocatiions'] })
    },
  })
}

export default useClaimFees
