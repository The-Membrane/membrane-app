import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { governanceAbi } from '@/contracts/abis/governance'
import { getContractAddress } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'

type Props = {
  values: any
  enabled: boolean
}

/** EVM-native proposal message payload: (address target, bytes data). */
type ProposalMessage = { target: `0x${string}`; data: `0x${string}` }

const useSubmitProposal = ({ values, enabled }: Props) => {
  const { address, chain } = useWallet()

  const { title, description, link } = values || {}

  const { data: msgs = [] } = useQuery<EvmCall[]>({
    queryKey: ['msg', 'submit proposal', address, chain.id, title, description, link],
    queryFn: () => {
      const govAddress = getContractAddress(chain.id, 'governance')
      if (!address || !govAddress) return []

      // Governance.sol uses EVM-native (target,data) call payloads, not Cosmos
      // messages. The uploaded JSON must already be in that shape.
      const messages: ProposalMessage[] = Array.isArray(values?.msgs) ? values.msgs : []

      // submitter_voting_power / total_system_stake are caller-supplied (Staking-
      // organ figures — Governance has no view for them).
      // TODO(evm-migration): source these from the Staking read service; default
      // 0 keeps the call well-typed but it will revert until wired.
      const submitterVotingPower = BigInt(values?.submitterVotingPower ?? 0)
      const totalSystemStake = BigInt(values?.totalSystemStake ?? 0)

      return [
        {
          address: govAddress,
          abi: governanceAbi,
          functionName: 'submitProposal',
          args: [
            {
              title: title ?? '',
              description: description ?? '',
              link: link ?? '',
              messages,
              submitter_voting_power: submitterVotingPower,
              total_system_stake: totalSystemStake,
              expedited: false,
            },
          ],
        },
      ]
    },
    enabled: enabled && !!address,
  })

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['proposals'] })
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['submit proposal sim', title, msgs?.length ? '1' : '0'],
    onSuccess,
  })
}

export default useSubmitProposal
