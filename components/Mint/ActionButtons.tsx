import ConfirmModal from '@/components/ConfirmModal'
import TxError from '@/components/TxError'
import { Button, HStack } from '@chakra-ui/react'
import { GrPowerReset } from 'react-icons/gr'
import { Summary } from './Summary'
import useMint from './hooks/useMint'
import useMintState from './hooks/useMintState'
import { useUserPositions } from '@/hooks/useCDP'

type Props = {
  onRest: () => void
}

const ActionButtons = () => {
  const mint = useMint()
  const { mintState } = useMintState()
  const { summary } = mintState
  const { data: basketPositions } = useUserPositions()

  const isDisabled = mintState?.overdraft || mintState?.belowMinDebt || (!summary?.length && (!mintState?.mint && !mintState?.repay))

  return (
    <HStack mt="0" gap="0">
      <ConfirmModal
        label={
          mintState.repay ?? 0 > 0.1 ? 'Repay' : mintState.mint ?? 0 > 0.1 ? 'Borrow' : basketPositions === undefined ? 'Deposit Collateral' : 'Update Collateral'
        }
        action={mint}
        isDisabled={isDisabled}
      >
        <Summary />
      </ConfirmModal>
    </HStack>
  )
}

export default ActionButtons
