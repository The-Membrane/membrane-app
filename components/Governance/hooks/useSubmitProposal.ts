import contracts from '@/config/contracts.json'
import { GovernanceMsgComposer } from '@/contracts/codegen/governance/Governance.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'

type Props = {
  values: any
  enabled: boolean
}

const useSubmitProposal = ({ values, enabled }: Props) => {
  const { address } = useWallet()

  const { title, description, link } = values || {}

  const { data: updateDelegationMsgs = [] } = useQuery<MsgExecuteContractEncodeObject[]>({
    queryKey: ['msg', 'submit proposal', address, title, description, link],
    queryFn: async () => {
      if (!address) return [] as MsgExecuteContractEncodeObject[]

      const messageComposer = new GovernanceMsgComposer(address, contracts.governance)

      const msg = messageComposer.submitProposal({
        title,
        description,
        link,
        messages: values.msgs,
        recipient: address,
        expedited: false,
      })

      return [msg] as MsgExecuteContractEncodeObject[]
    },
    enabled: enabled && !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['proposals'] })
  }

  return useSimulateAndBroadcast({
    msgs: updateDelegationMsgs,
    queryKey: [],
    onSuccess,
  })
}

export default useSubmitProposal
