import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { Button, HStack, Link, Stack, Text } from '@chakra-ui/react'
import { useEffect, useMemo, useState } from 'react'
import { GrPowerReset } from 'react-icons/gr'
import ConfirmModal from '../ConfirmModal'
import { SliderWithState } from '../Mint/SliderWithState'
import { Summary } from './Summary'
import useStakeing from './hooks/useStake'
import useStakeState from './hooks/useStakeState'
import useStaked from './hooks/useStaked'

const Stakeing = () => {
  const [stakeAmount, setStakeAmount] = useState(0)
  const mbrnAsset = useAssetBySymbol('MBRN')
  const mbrnBalance = useBalanceByAsset(mbrnAsset)
  const { action: stake } = useStakeing({})
  const { data } = useStaked()
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

  if (num(totalBalance).isLessThanOrEqualTo(0)) {
    return (
      <Stack gap="2" mt="5">
        <Text fontSize="sm" color="gray">
          You currently don't have any MBRN in your account. You can acquire MBRN tokens through
          Osmosis DEX.
        </Text>
        <Link
          alignSelf="flex-end"
          color="primary.200"
          href="https://app.osmosis.zone/?from=OSMO&to=MBRN"
          isExternal
        >
          Buy MBRN
        </Link>
      </Stack>
    )
  }

  return (
    <Stack gap="10" pt="5">
      <Stack>
        <HStack justifyContent="space-between">
          <Text>Your Stake</Text>
          <Text>{stakeAmount} MBRN {parseInt(stakeState.amount) > 0 ? <>{stakeState?.txType === 'Stake' ? " (+" : " (-"}{stakeState.amount} MBRN{")"}</> : null}</Text>
        </HStack>

        <SliderWithState
          value={Number(stakeAmount)}
          onChange={onInputChange}
          max={Number(totalBalance)}
        />
      </Stack>

      <HStack>
        <Button variant="outline" leftIcon={<GrPowerReset />} onClick={onRest}>
          Reset
        </Button>

        <ConfirmModal label={stakeState.txType || 'Stake'} action={stake} isDisabled={isDisabled}>
          <Summary />
        </ConfirmModal>
      </HStack>
    </Stack>
  )
}

export default Stakeing
