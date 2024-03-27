import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { getSigningLockdropClient } from '@/services/lockdrop'

const useClaim = () => {
  const { address, getSigningCosmWasmClient } = useWallet()

  return useExecute({
    onSubmit: async () => {
      if (!address) return Promise.reject('No address found')
      const signingClient = await getSigningCosmWasmClient()
      const client = getSigningLockdropClient(signingClient, address)
      return client.claim()
    },
  })
}

export default useClaim
