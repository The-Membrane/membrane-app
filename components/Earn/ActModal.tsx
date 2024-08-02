import { Action } from '@/types/tx'
import { Button, ButtonProps, Modal, ModalOverlay, useDisclosure, 
    ModalHeader,
    ModalCloseButton,
    ModalBody,
    ModalFooter,
    Text, Stack,
    ModalContent } from '@chakra-ui/react'
import { PropsWithChildren } from 'react'
import { LoadingContent } from '../ConfirmModal/LoadingContent'
import { TxDetails } from '../ConfirmModal/TxDetails'
import { TxButton } from '../TxButton'
import TxError from '../TxError'

type Props = PropsWithChildren & {
  label: string
  action?: Action
  isDisabled?: boolean
  isLoading?: boolean
  buttonProps?: ButtonProps
}


type ConfirmProps = PropsWithChildren & {
    action?: Action
  }
  
  const ConfirmDetails = ({ children, action }: ConfirmProps) => {
    // if (action?.tx?.isPending) return null
  
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
            onClick={() => action?.simulate.refetch().then( () => action?.tx.mutate())}
          >
            Confirm
          </TxButton>
          <TxError action={action!} />
        </ModalFooter>
      </ModalContent>
    )
  }

const ActModal = ({
  children,
  label = 'Open',
  action,
  isDisabled = false,
  isLoading = true,
  buttonProps,
}: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()

  const onModalOpen = () => {
    onOpen()
    // action?.simulate.refetch()
  }

  const onModalClose = () => {
    onClose()
    action?.tx.reset()
  }
  return (
    <>
      <Button
        isLoading={isLoading && (action?.simulate.isLoading || action?.tx.isPending)}
        // isDisabled={isDisabled || action?.simulate.isError || !action?.simulate.data}
        isDisabled={isDisabled}
        onClick={onModalOpen}
        width={"30%"}
        // opacity={label === "Withdraw" ? 0.5 : 1}
        {...buttonProps}
      >
        {label}
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={onModalClose}
        closeOnOverlayClick={false}
        isCentered
        size="xl"
      >
        <ModalOverlay />
        <LoadingContent action={action} />
        <ConfirmDetails action={action}>{children}</ConfirmDetails>
        <TxDetails action={action} onClose={onModalClose} />
      </Modal>
    </>
  )
}

export default ActModal
