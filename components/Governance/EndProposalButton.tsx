import { CheckIcon } from '@chakra-ui/icons'
import React from 'react'
import { TxButton } from '@/components/TxButton'
import useEndProposal from './hooks/useEndProposal'

type Props = {
  show: boolean
  proposalId: string
}

const EndProposalButton = ({ show, proposalId }: Props) => {
  const endProposal = useEndProposal({
    proposalId: Number(proposalId),
  })

  if (!show) return null

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
