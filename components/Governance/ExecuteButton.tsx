import { CheckIcon } from '@chakra-ui/icons'
import React from 'react'
import useExecuteProposal from './hooks/useExecuteProposal'
import { TxButton } from '@/components/TxButton'

type Props = {
  show: boolean
  proposalId: string
}

const ExecuteButton = ({ show, proposalId }: Props) => {
  const executeProposal = useExecuteProposal({
    proposalId: Number(proposalId),
  })

  if (!show) return null
  return (
    <TxButton
      leftIcon={<CheckIcon />}
      px="5"
      w="fit-content"
      fontSize="sm"
      isLoading={executeProposal.isPending}
      onClick={() => executeProposal.mutate()}
    >
      Execute
    </TxButton>
  )
}

export default ExecuteButton
