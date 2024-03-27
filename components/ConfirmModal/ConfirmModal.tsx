import { Action } from '@/types/tx'
import { Button, Modal, ModalOverlay, useDisclosure } from '@chakra-ui/react'
import { PropsWithChildren } from 'react'
import ConfrimDetails from './ConfrimDetails'
import { LoadingContent } from './LoadingContent'
import { TxDetails } from './TxDetails'

type Props = PropsWithChildren & {
  label: string
  action?: Action
  isDisabled?: boolean
}

// const mockSuccess = {
//   tx: {
//     isSuccess: true,
//     data: {
//       code: 0,
//       gasUsed: 900909,
//       transactionHash: '7D8DBC214C1888267A48EEE325EADC6F58D765C3D03D0868D82A3650F3AECB9E',
//     },
//   },
// }

// const mockLoading = {
//   tx: {
//     isSuccess: true,
//     data: {
//       code: 0,
//       gasUsed: 900909,
//       transactionHash: '7D8DBC214C1888267A48EEE325EADC6F58D765C3D03D0868D82A3650F3AECB9E',
//     },
//   },
// }

const ConfirmModal = ({ children, label = 'Open', action, isDisabled = false }: Props) => {
  const { isOpen, onOpen, onClose } = useDisclosure()
  return (
    <>
      <Button
        isLoading={action?.simulate.isLoading || action?.tx.isPending}
        isDisabled={isDisabled || action?.simulate.isError || !action?.simulate.data}
        onClick={onOpen}
      >
        {label}
      </Button>

      <Modal isOpen={isOpen} onClose={onClose} closeOnOverlayClick={false} isCentered size="xl">
        <ModalOverlay />
        <LoadingContent action={action} />
        <ConfrimDetails action={action}>{children}</ConfrimDetails>
        <TxDetails action={action} onClose={onClose} />
      </Modal>
    </>
  )
}

export default ConfirmModal
