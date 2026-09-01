import { shiftDigits } from '@/helpers/math'
import {
  Box,
  Button,
  HStack,
  Image,
  Input,
  InputGroup,
  InputLeftElement,
  Stack,
  Text,
} from '@chakra-ui/react'
import { Card } from '@/components/ui/Card'
import { TxButton } from '@/components/TxButton'
import { Deposit } from '@/contracts/codegen/stability_pool/StabilityPool.types'
import { isGreaterThanZero, num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useCountdown from '@/hooks/useCountdown'
import { ChangeEvent, useState } from 'react'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWithdrawStabilityPool from './hooks/useWithdrawStabilityPool'
import useBidState from './hooks/useBidState'
import { getSPTimeLeft } from './StabilityPoolUtils'
import { useStabilityAssetPool } from '@/hooks/useLiquidations'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'


const UnstakeButton = ({ amount }: { amount: string }) => {
  const withdraw = useWithdrawStabilityPool(amount)
  return (
    <TxButton
      w="150px"
      px={SPACING.xl}
      isDisabled={!isGreaterThanZero(amount)}
      isLoading={withdraw.action.simulate.isLoading || withdraw.action.tx.isPending}
      onClick={() => withdraw.action.tx.mutate()}
    >
      Unstake
    </TxButton>
  )
}

const WithdrawButton = ({ amount }: { amount: string }) => {
  const withdraw = useWithdrawStabilityPool(amount)
  return (
    <TxButton
      w="150px"
      px={SPACING.xl}
      isDisabled={!isGreaterThanZero(amount)}
      isLoading={withdraw.action.simulate.isLoading || withdraw.action.tx.isPending}
      onClick={() => withdraw.action.tx.mutate()}
    >
      Withdraw
    </TxButton>
  )
}

const CountDown = ({ timeString, amount }: { timeString: string; amount: string }) => {
  return (
    <HStack
      alignItems="center"
      gap={SPACING.none}
      bg="blackAlpha.500"
      py={SPACING.sm}
      px={SPACING.base}
      w="full"
      borderRadius="md"
    >
      <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
        Unstaking {amount} CDT in {timeString}
      </Text>
    </HStack>
  )
}

const Action = ({ deposit, amount }: { deposit: Deposit; amount: string }) => {
  if (!deposit.unstake_time || getSPTimeLeft(deposit.unstake_time).minutesLeft > 0) {
    return <UnstakeButton amount={amount} />
  }

  return <WithdrawButton amount={amount} />
}

const DepositAsset = ({ deposit, index }: { deposit: Deposit; index: number }) => {
  const amount = shiftDigits(deposit.amount, -6).toString()
  const { isEnded, timeString } = useCountdown(deposit.unstake_time ? (deposit.unstake_time + 86400) : undefined)
  const { chainName } = useChainRoute()
  const cdt = useAssetBySymbol('CDT', chainName)
  const [inputAmount, setInputAmount] = useState('')

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newAmount = e.target.value
    if (num(newAmount).isGreaterThan(amount)) setInputAmount(amount)
    else setInputAmount(e.target.value)
  }

  const onMax = () => {
    setInputAmount(amount)
  }

  if (deposit.unstake_time && getSPTimeLeft(deposit.unstake_time).minutesLeft > 0) {
    return (
      <HStack alignItems="flex-start" gap={SPACING.lg}>
        <Box bg="blackAlpha.500" borderRadius="md" px={SPACING.base} py={SPACING.xs} h="full">
          <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>{index}</Text>
        </Box>
        <CountDown timeString={timeString} amount={amount} />
      </HStack>
    )
  }

  return (
    <HStack alignItems="flex-start" gap={SPACING.lg}>
      <Box bg="blackAlpha.500" borderRadius="md" px={SPACING.base} py={SPACING.xs} h="full">
        <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary}>{index}</Text>
      </Box>
      <Stack alignItems="flex-end" gap={SPACING.none}>
        <InputGroup alignItems="center">
          <InputLeftElement pointerEvents="none">
            <Image src={cdt?.logo} boxSize="5" />
          </InputLeftElement>
          <Input
            placeholder="0.0"
            value={inputAmount}
            onChange={handleInputChange}
            transition={TRANSITIONS.all}
            _focus={FOCUS_STYLES.ring}
          />
        </InputGroup>
        <HStack justifyContent="space-between" w="full">
          <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary} ml={SPACING.sm}>
            Available: {amount} CDT
          </Text>
          <Button
            size="xs"
            variant="link"
            mr={SPACING.sm}
            onClick={onMax}
            _focus={FOCUS_STYLES.ring}
          >
            MAX
          </Button>
        </HStack>
      </Stack>
      <Action deposit={deposit} amount={shiftDigits(inputAmount, 6).toString()} />
    </HStack>
  )
}

type Props = {
  setActiveTabIndex: React.Dispatch<React.SetStateAction<number>>
}

const StabilityPool = ({ setActiveTabIndex }: Props) => {
  const { data: stabilityPoolAssets } = useStabilityAssetPool(true)
  const { deposits = [] } = stabilityPoolAssets || {}

  const { bidState, setBidState } = useBidState()

  const changeTab = () => {
    setBidState({ placeBid: { ...bidState?.placeBid, premium: 10 } })
    setActiveTabIndex(0)
  };

  if (deposits.length === 0) {
    return (
      <Card variant="default" display="flex" flexDirection="column" alignItems="center" gap={SPACING.lg} w="full">
        <Text fontSize={TYPOGRAPHY.h2} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
          My Omni-Bids
        </Text>
        <Text color={SEMANTIC_COLORS.textTertiary}>You don&apos;t have any deposits in the omni-asset pool.</Text>
        <Button
          onClick={changeTab}
          variant="solid"
          transition={TRANSITIONS.transformAndShadow}
          _hover={HOVER_EFFECTS.lift}
          _active={ACTIVE_EFFECTS.press}
          _focus={FOCUS_STYLES.ring}
        >
          Bid in Omni-Pool - Set Premium to 10%
        </Button>
      </Card>
    )
  }

  return (
    <Card variant="default" display="flex" flexDirection="column" alignItems="center" gap={SPACING.lg} w="full">
      <Text fontSize={TYPOGRAPHY.h2} fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>
        My Omni-Bids
      </Text>
      <Stack py={SPACING.lg} w="full" gap={SPACING.lg}>
        {deposits.map((deposit: Deposit, index: number) => (
          <DepositAsset key={deposit.deposit_time} deposit={deposit} index={index + 1} />
        ))}
      </Stack>
    </Card>
  )
}

export default StabilityPool
