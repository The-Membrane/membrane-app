import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { Button, HStack, Link, Stack, Text, Box, VStack, useColorModeValue } from '@chakra-ui/react'
import { useEffect, useMemo, useState } from 'react'
import { GrPowerReset } from 'react-icons/gr'
import ConfirmModal from '../ConfirmModal'
import { SliderWithState } from '../Mint/SliderWithState'
import { Summary } from './Summary'
import useStakeing from './hooks/useStake'
import useStakeState from './hooks/useStakeState'
import useStaked from './hooks/useStaked'
import { colors } from '@/config/defaults'

const Stakeing = () => {
  const [stakeAmount, setStakeAmount] = useState(0)
  const mbrnAsset = useAssetBySymbol('MBRN')
  const mbrnBalance = useBalanceByAsset(mbrnAsset)
  const { action: stake } = useStakeing({})
  const { data } = useStaked(true)
  const { staked } = data || {}
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
      asset: mbrnAsset,
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

  const cardBg = useColorModeValue('#181F2A', '#232B3E')
  const borderColor = useColorModeValue('whiteAlpha.200', 'whiteAlpha.200')

  if (num(totalBalance).isLessThanOrEqualTo(0)) {
    return (
      <Box bg={cardBg} borderRadius="xl" p={6} w="full" border="1px solid" borderColor={borderColor}>
        <VStack gap={2}>
          <Text fontSize="sm" color={colors.noState}>
            You currently don't have any MBRN in your account. You can acquire MBRN tokens through Osmosis DEX.
          </Text>
          <Link
            alignSelf="flex-end"
            color={colors.link}
            href="https://app.osmosis.zone/?from=OSMO&to=MBRN"
            isExternal
            fontWeight="bold"
          >
            Buy MBRN
          </Link>
        </VStack>
      </Box>
    )
  }

  return (
    <Box bg={cardBg} borderRadius="xl" p={6} w="full" border="1px solid" borderColor={borderColor}>
      <VStack gap={8} align="stretch">
        <Box>
          <HStack justifyContent="space-between" mb={2}>
            <Text fontWeight="bold" color="whiteAlpha.900">Your Stake</Text>
            <Text color="whiteAlpha.800">
              {stakeAmount} MBRN {parseInt(stakeState.amount) > 0 ? <>{stakeState?.txType === 'Stake' ? ' (+' : ' (-'}{stakeState.amount} MBRN{')'}</> : null}
            </Text>
          </HStack>
          <SliderWithState
            value={Number(stakeAmount)}
            onChange={onInputChange}
            max={Number(totalBalance)}
          />
        </Box>
        <HStack justifyContent="flex-end" gap={4}>
          <Button variant="outline" leftIcon={<GrPowerReset />} onClick={onRest} colorScheme="gray">
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
