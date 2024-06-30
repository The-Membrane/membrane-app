import { Action } from '@/types/tx'
import { Button, ButtonProps, Modal, ModalOverlay, useDisclosure } from '@chakra-ui/react'
import { PropsWithChildren } from 'react'
import ConfrimDetails from './ConfrimDetails'
import { LoadingContent } from './LoadingContent'
import { TxDetails } from './TxDetails'
import { queryClient } from '@/pages/_app'

type Props = PropsWithChildren & {
  label: string
  action?: Action
  isDisabled?: boolean
  buttonProps?: ButtonProps
}

const ConfirmModal = ({
  children,
  label = 'Open',
  action,
  isDisabled = false,
  buttonProps,
}: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()

  const onModalOpen = () => {
    onOpen()
    action?.simulate.refetch()
  }

  const onModalClose = () => {
    onClose()
    action?.tx.reset()
  }
  return (
    <>
      <Button
        // isLoading={action?.simulate.isLoading || action?.tx.isPending}
        // isDisabled={isDisabled || action?.simulate.isError || !action?.simulate.data}
        isDisabled={isDisabled}
        onClick={() => {
          //Invalidate Basket query to get the latest positionID for new deposits...
          // in preparation for a deposit mint combo piece
          if (label === 'Deposit Assets') queryClient.invalidateQueries({ queryKey: ['basket'] })

          onModalOpen()
        }}
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
        <ConfrimDetails action={action}>{children}</ConfrimDetails>
        <TxDetails action={action} onClose={onModalClose} />
      </Modal>
    </>
  )
}

export default ConfirmModal
