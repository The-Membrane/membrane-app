import { Action } from '@/types/tx'
import { Button, ButtonProps, Modal, ModalOverlay, useDisclosure } from '@chakra-ui/react'
import { PropsWithChildren, Ref, useCallback } from 'react'
import ConfrimDetails from './ConfrimDetails'
import { LoadingContent } from './LoadingContent'
import { TxDetails } from './TxDetails'
import { queryClient } from '@/pages/_app'
import { useDittoConfirmation } from '@/components/DittoSpeechBox/hooks/useDittoConfirmation'
import { useChainRoute } from '@/hooks/useChainRoute'

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
  // When true, use the legacy modal instead of Ditto
  useLegacyModal?: boolean
  // Action type for acknowledgement messages (e.g., 'deposit', 'withdraw', 'loop')
  actionType?: string
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
  useLegacyModal = false,
  actionType = 'action',
}: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  const { openConfirmation } = useDittoConfirmation()
  const { chainName } = useChainRoute()
  
  // Use Ditto for neutron chain, legacy modal for others
  const shouldUseDitto = chainName === 'neutron' && !useLegacyModal

  const onModalOpen = () => {
    onOpen()
    setTimeout(() => action?.simulate.refetch(), 0)
  }

  const onModalClose = () => {
    onClose()
    action?.tx.reset()
  }

  const handleClick = useCallback(() => {
    onClick?.()
    
    if (executeDirectly) {
      if (!action?.simulate.data || action?.simulate.isLoading) {
        if (shouldUseDitto && action) {
          openConfirmation(action, children, { label, actionType })
        } else {
          onModalOpen()
        }
      } else {
        action?.tx.mutate()
      }
    } else {
      if (shouldUseDitto && action) {
        openConfirmation(action, children, { label, actionType })
      } else {
        onModalOpen()
      }
    }
  }, [onClick, executeDirectly, action, shouldUseDitto, openConfirmation, children, label, actionType])

  return (
    <>
      <Button
        ref={buttonRef}
        isLoading={isLoading && (action?.simulate.isLoading || action?.tx.isPending)}
        isDisabled={isDisabled}
        onClick={handleClick}
        {...buttonProps}
      >
        {label}
      </Button>

      {/* Legacy modal for non-neutron chains or when explicitly requested */}
      {!shouldUseDitto && (
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
      )}
    </>
  )
}

export default ConfirmModal
