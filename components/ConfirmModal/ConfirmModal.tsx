import { Action } from '@/types/tx'
import { Button, ButtonProps, Modal, ModalOverlay, useDisclosure } from '@chakra-ui/react'
import { PropsWithChildren, Ref } from 'react'
import ConfrimDetails from './ConfrimDetails'
import { LoadingContent } from './LoadingContent'
import { TxDetails } from './TxDetails'
import { queryClient } from '@/pages/_app'

type Props = PropsWithChildren & {
  label: string
  action?: Action
  isDisabled?: boolean
  isLoading?: boolean
  buttonProps?: ButtonProps
  buttonRef?: Ref<HTMLButtonElement>
  onClick?: () => void
  // When true, bypass modal and execute the transaction immediately on click
  executeDirectly?: boolean
}

const ConfirmModal = ({
  children,
  label = 'Open',
  action,
  isDisabled = false,
  isLoading = true,
  buttonProps,
  buttonRef,
  onClick,
  executeDirectly = false,
}: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()

  const onModalOpen = () => {
    onOpen()
    setTimeout(() => action?.simulate.refetch(), 0)
  }

  const onModalClose = () => {
    onClose()
    action?.tx.reset()
  }
  return (
    <>
      <Button
        ref={buttonRef}
        isLoading={isLoading && (action?.simulate.isLoading || action?.tx.isPending)}
        // isDisabled={isDisabled || action?.simulate.isError || !action?.simulate.data}
        isDisabled={isDisabled}
        onClick={() => {
          onClick?.()
          if (executeDirectly) {
            if (!action?.simulate.data || action?.simulate.isLoading) {
              onModalOpen()
            }
            action?.tx.mutate()
          } else {
            onModalOpen()
          }
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
