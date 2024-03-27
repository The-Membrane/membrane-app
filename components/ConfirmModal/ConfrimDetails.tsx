import {
  ModalHeader,
  ModalCloseButton,
  ModalBody,
  ModalFooter,
  Text,
  ModalContent,
} from '@chakra-ui/react'
import React, { Fragment, PropsWithChildren } from 'react'
import { TxButton } from '../TxButton'
import { Action } from '@/types/tx'

type Props = PropsWithChildren & {
  action?: Action
}

const ConfrimDetails = ({ children, action }: Props) => {
  if (action?.tx?.isPending) return null

  return (
    <ModalContent>
      <ModalHeader>
        <Text variant="title" fontSize="24px">
          Confirm transaction
        </Text>
        <Text color="white" fontSize="xs" fontWeight="normal">
          Please review your transaction.
        </Text>
      </ModalHeader>
      <ModalCloseButton />

      <ModalBody>{children}</ModalBody>

      <ModalFooter justifyContent="center">
        <TxButton
          isLoading={action?.simulate.isLoading || action?.tx.isPending}
          isDisabled={action?.simulate.isError || !action?.simulate.data}
          onClick={() => action?.tx.mutate()}
        >
          Confirm
        </TxButton>
      </ModalFooter>
    </ModalContent>
  )
}

export default ConfrimDetails
