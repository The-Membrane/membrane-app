import {
  ModalHeader,
  ModalCloseButton,
  ModalBody,
  ModalFooter,
  Text,
  ModalContent,
  Stack,
} from '@chakra-ui/react'
import React, { Fragment, PropsWithChildren } from 'react'
import { TxButton } from '../TxButton'
import { Action } from '@/types/tx'
import TxError from '@/components/TxError'

type Props = PropsWithChildren & {
  action?: Action
}

const ConfrimDetails = ({ children, action }: Props) => {
  if (action?.tx?.isPending) return null

  return (
    <ModalContent display={action?.tx?.isSuccess ? 'none' : 'flex'}>
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

      <ModalFooter justifyContent="center" as={Stack}>
        <TxButton
          maxW="200px"
          isLoading={action?.simulate.isLoading || action?.tx.isPending}
          isDisabled={action?.simulate.isError || !action?.simulate.data}
          onClick={() => action?.tx.mutate()}
        >
          Confirm
        </TxButton>
        <TxError action={action!} />
      </ModalFooter>
    </ModalContent>
  )
}

export default ConfrimDetails
