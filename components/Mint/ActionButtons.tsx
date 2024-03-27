import ConfirmModal from '@/components/ConfirmModal'
import TxError from '@/components/TxError'
import { Button, HStack } from '@chakra-ui/react'
import { GrPowerReset } from 'react-icons/gr'
import { Summary } from './Summary'
import useMint from './hooks/useMint'
import useMintState from './hooks/useMintState'

type Props = {
  onRest: () => void
}

const ActionButtons = ({ onRest }: Props) => {
  const mint = useMint()
  const { mintState } = useMintState()

  return (
    <HStack mt="5" gap="4">
      <ConfirmModal label="Open" action={mint} isDisabled={mintState?.overdraft}>
        <Summary />
        <TxError action={mint} />
      </ConfirmModal>
      <Button variant="ghost" leftIcon={<GrPowerReset />} onClick={onRest}>
        Reset
      </Button>
    </HStack>
  )
}

export default ActionButtons
