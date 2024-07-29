import { CheckIcon, DeleteIcon } from '@chakra-ui/icons'
import { Button } from '@chakra-ui/react'
import React from 'react'
import useRemoveProposal from './hooks/useRemoveProposal'
import { TxButton } from '../TxButton'

type Props = {
  show: boolean
  proposalId: string
}

const RemoveButton = ({ show, proposalId }: Props) => {
  const removeProposal = useRemoveProposal({
    proposalId: Number(proposalId),
  })

  if (!show) return null

  return (
    <TxButton
      leftIcon={<DeleteIcon />}
      px="5"
      w="fit-content"
      fontSize="sm"
      colorScheme="red"
      color="black"
      isLoading={removeProposal.isPending}
      onClick={() => removeProposal.mutate()}
      toggleConnectLabel={false}
    >
      Remove
    </TxButton>
  )
}

export default RemoveButton
