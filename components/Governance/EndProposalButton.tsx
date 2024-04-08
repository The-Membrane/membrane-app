import { CheckIcon } from '@chakra-ui/icons'
import React from 'react'
import { TxButton } from '@/components/TxButton'
import useEndProposal from './hooks/useEndProposal'

type Props = {
  proposalId: string
}

const EndProposalButton = ({ proposalId }: Props) => {
  const endProposal = useEndProposal({
    proposalId: Number(proposalId),
  })

  return (
    <TxButton
      leftIcon={<CheckIcon />}
      px="5"
      w="fit-content"
      fontSize="sm"
      isLoading={endProposal.isPending}
      onClick={() => endProposal.mutate()}
    >
      End Proposal
    </TxButton>
  )
}

export default EndProposalButton
