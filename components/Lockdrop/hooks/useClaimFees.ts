import { VestingMsgComposer } from '@/contracts/codegen/vesting/Vesting.message-composer'
import useExecute from '@/hooks/useExecute'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { getSigningVestingClient } from '@/services/vesting'
import contracts from '@/config/contracts.json'

const useClaimFees = () => {
  const { address, getSigningCosmWasmClient } = useWallet()

  return useExecute({
    onSubmit: async () => {
      if (!address) return Promise.reject('No address found')
      const signingClient = await getSigningCosmWasmClient()
      const client = getSigningVestingClient(signingClient, address)
      return client.claimFeesforRecipient()

      // const messageComposer = new VestingMsgComposer(address, contracts.vesting)

      // const claimFeeMsg = messageComposer.claimFeesforContract()
      // const claimReceipientMsg = messageComposer.claimFeesforRecipient()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['allocatiions'] })
    },
  })
}

export default useClaimFees
