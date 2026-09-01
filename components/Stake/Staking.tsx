import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { Button, HStack, Link, Stack, Text, Box, VStack } from '@chakra-ui/react'
import { useEffect, useMemo, useState } from 'react'
import { GrPowerReset } from 'react-icons/gr'
import ConfirmModal from '../ConfirmModal'
import { SliderWithState } from '../Mint/SliderWithState'
import { Summary } from './Summary'
import useStakeing from './hooks/useStake'
import useStakeState from './hooks/useStakeState'
import useStaked from './hooks/useStaked'
import { useChainRoute } from '@/hooks/useChainRoute'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions'

const Stakeing = () => {
  const [stakeAmount, setStakeAmount] = useState(0)
  const { chainName } = useChainRoute()
  const mbrnAsset = useAssetBySymbol('MBRN', chainName)
  const mbrnBalance = useBalanceByAsset(mbrnAsset)
  const { action: stake } = useStakeing({})
  const { data } = useStaked(true)
  console.log("staked in component", data)
  const { staked } = data || {}
  console.log("staked in component", data, staked)
  const { stakeState, setStakeState } = useStakeState()
  console.log("STAKE", stake)

  const stakedBalance = useMemo(() => {
    if (!staked || !mbrnAsset) return 0

    return shiftDigits(staked, -mbrnAsset?.decimal).toNumber()
  }, [staked, mbrnAsset])

  useEffect(() => {
    if (staked) {
      setStakeAmount(stakedBalance)
    }
  }, [stakedBalance, staked])

  const onInputChange = (value: number) => {
    setStakeAmount(value)

    const diff = num(value).minus(stakedBalance).toString()

    setStakeState({
      // TODO(evm-migration): stakeState.asset is the legacy @chain-registry Asset; mbrnAsset is the EVM helpers/chain Asset.
      asset: mbrnAsset as any,
      amount: num(diff).abs().toString(),
      txType: num(diff).isGreaterThanOrEqualTo(0) ? 'Stake' : 'Unstake',
    })
  }

  const totalBalance = useMemo(() => {
    return num(mbrnBalance).plus(stakedBalance).toString()
  }, [mbrnBalance, stakedBalance])

  const onRest = () => {
    setStakeAmount(stakedBalance)
    setStakeState({
      amount: '0',
      txType: undefined,
    })
  }

  const isDisabled = num(stakeState.amount).isLessThanOrEqualTo(0)

  if (num(totalBalance).isLessThanOrEqualTo(0)) {
    return (
      <Box bg={SEMANTIC_COLORS.bgSecondary} borderRadius={0} p={SPACING.lg} w="full" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
        <VStack gap={SPACING.sm}>
          <Text fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textSecondary}>
            You currently don&apos;t have any MBRN in your account. You can acquire MBRN tokens through Osmosis DEX.
          </Text>
          <Link
            alignSelf="flex-end"
            color={SEMANTIC_COLORS.info}
            href="https://app.osmosis.zone/?from=OSMO&to=MBRN"
            isExternal
            fontWeight={TYPOGRAPHY.bold}
            transition={TRANSITIONS.colors}
            _hover={HOVER_EFFECTS.brighten}
            _focus={FOCUS_STYLES.ring}
          >
            Buy MBRN
          </Link>
        </VStack>
      </Box>
    )
  }

  return (
    <Box bg={SEMANTIC_COLORS.bgSecondary} borderRadius={0} p={SPACING.lg} w="full" border="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle}>
      <VStack gap={SPACING.xl} align="stretch">
        <Box>
          <HStack justifyContent="space-between" mb={SPACING.sm}>
            <Text fontWeight={TYPOGRAPHY.bold} color={SEMANTIC_COLORS.textPrimary}>Your Stake</Text>
            <Text color={SEMANTIC_COLORS.textSecondary}>
              {stakeAmount} MBRN {parseInt(stakeState.amount) > 0 ? <>{stakeState?.txType === 'Stake' ? ' (+' : ' (-'}{stakeState.amount} MBRN{')'}</> : null}
            </Text>
          </HStack>
          <SliderWithState
            value={Number(stakeAmount)}
            onChange={onInputChange}
            max={Number(totalBalance)}
          />
        </Box>
        <HStack justifyContent="flex-end" gap={SPACING.base}>
          <Button
            variant="outline"
            leftIcon={<GrPowerReset />}
            onClick={onRest}
            transition={TRANSITIONS.colors}
            _hover={HOVER_EFFECTS.borderHighlight}
            _active={ACTIVE_EFFECTS.dim}
            _focus={FOCUS_STYLES.ring}
          >
            Reset
          </Button>
          <ConfirmModal label={stakeState.txType || 'Stake'} action={stake} isDisabled={isDisabled}>
            <Summary />
          </ConfirmModal>
        </HStack>
      </VStack>
    </Box>
  )
}

export default Stakeing
