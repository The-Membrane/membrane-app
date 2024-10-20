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

const ActionButtons = ({ onRest }: Props) => {
  const mint = useMint()
  const { mintState } = useMintState()
  const { summary } = mintState
  const { data: basketPositions } = useUserPositions()

  return (
    <HStack mt="5" gap="0">
      <Button variant="ghost" width={"10"} padding={0} leftIcon={<GrPowerReset />} onClick={onRest}/>
      <ConfirmModal
        label={
          mintState.repay ?? 0 > 0.1 ? 'Repay' : mintState.mint ?? 0 > 0.1 ? 'Mint' : basketPositions === undefined ? 'Deposit Assets' : 'Update Assets'
        }
        action={mint}
        isDisabled={mintState?.overdraft || mintState?.belowMinDebt || (!summary?.length && (!mintState?.mint && !mintState?.repay))}
      >
        <Summary />
      </ConfirmModal>
    </HStack>
  )
}

export default ActionButtons
