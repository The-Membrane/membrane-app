import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Action } from '@/types/tx'
import {
  Button,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  Stack,
  VStack,
  Text,
} from '@chakra-ui/react'
import { ExplorerLink } from './ExplorerLink'
import { LineItem } from './LineItem'

type Props = {
  action?: Action
  onClose: () => void
}

export const TxDetails = ({ action, onClose }: Props) => {
  const osmo = useAssetBySymbol('OSMO')

  if (!action?.tx?.isSuccess) return null

  const { gasUsed, transactionHash, code } = action.tx.data

  return (
    <ModalContent>
      <ModalHeader>
        <Text variant="title" fontSize="24px">
          Transaction details
        </Text>
        <Text color="white" fontSize="xs" fontWeight="normal">
          Transaction succesful
        </Text>
      </ModalHeader>
      <ModalCloseButton />
      <ModalBody as={VStack} py="5" justifyContent="center" h="full" w="full">
        <Stack gap="2" w="full">
          <LineItem label="Status" value={code === 0 ? 'Success' : 'Failed'} />
          <ExplorerLink txHash={transactionHash} />
          <LineItem
            label="Gas used"
            value={shiftDigits(gasUsed.toString(), -(osmo?.decimal || 6)).toString()}
          />
        </Stack>

        <Button onClick={onClose} minW="200" my="5">
          Close
        </Button>
      </ModalBody>
    </ModalContent>
  )
}
