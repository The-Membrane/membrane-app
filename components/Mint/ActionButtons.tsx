import ConfirmModal from '@/components/ConfirmModal'
import TxError from '@/components/TxError'
import { Button, HStack } from '@chakra-ui/react'
import { GrPowerReset } from 'react-icons/gr'
import { Summary } from './Summary'
import useMint from './hooks/useMint'
import useMintState from './hooks/useMintState'
import { useUserPositions } from '@/hooks/useCDP'
import { num } from '@/helpers/num'

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
        label={(function () {
          const isRepay = (mintState.repay ?? 0) > 0.1;
          const isBorrow = (mintState.mint ?? 0) > 0.1;
          const isDeposit = summary?.some(s => num(s.amount).isGreaterThan(0));
          const isWithdraw = summary?.some(s => !num(s.amount).isGreaterThan(0));

          if (isWithdraw && isDeposit) return isRepay ? 'Update Collateral & Repay' : isBorrow ? 'Update Collateral & Borrow' : 'Update Collateral';
          if (isWithdraw) return isRepay ? 'Withdraw & Repay' : isBorrow ? 'Withdraw & Borrow' : 'Withdraw';
          if (isDeposit) return isRepay ? 'Deposit & Repay' : isBorrow ? 'Deposit & Borrow' : 'Deposit';
          if (isRepay) return 'Repay';
          if (isBorrow) return 'Borrow';
          return 'Manage';
        })()}
        action={mint}
        isDisabled={isDisabled}
      >
        <Summary />
      </ConfirmModal>
    </HStack>
  )
}

export default ActionButtons
