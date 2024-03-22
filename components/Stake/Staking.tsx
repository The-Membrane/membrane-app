import TxError from '@/components/TxError'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { Button, HStack, Stack, Text } from '@chakra-ui/react'
import { useEffect, useMemo, useState } from 'react'
import ConfirmModal from '../ConfirmModal'
import { SliderWithState } from '../Mint/SliderWithState'
import { Summary } from './Summary'
import useStakeing from './hooks/useStake'
import useStakeState from './hooks/useStakeState'
import useStaked from './hooks/useStaked'
import { GrPowerReset } from 'react-icons/gr'

const Stakeing = () => {
  const mbrnAsset = useAssetBySymbol('MBRN')
  const mbrnBalance = useBalanceByAsset(mbrnAsset)
  const [stakeAmount, setStakeAmount] = useState(0)
  const stake = useStakeing({ amount: stakeAmount.toString() })
  const { data } = useStaked()
  const { staked } = data || {}
  const { stakeState, setStakeState } = useStakeState()

  const stakedBalance = useMemo(() => {
    if (!staked || !mbrnAsset) return 0

    return shiftDigits(staked?.staked, -mbrnAsset?.decimal).toNumber()
  }, [staked, mbrnAsset])

  console.log({ stakedBalance, staked })

  useEffect(() => {
    if (staked) {
      setStakeAmount(stakedBalance)
    }
  }, [stakedBalance])

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
    setStakeState({})
  }

  return (
    <Stack gap="10" pt="5">
      <Stack>
        <HStack justifyContent="space-between">
          <Text>Stake</Text>
          <Text>{stakeAmount} MBRN</Text>
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
        <ConfirmModal label={stakeState.txType || 'Stake'} action={stake}>
          <Summary />
          <TxError action={stake} />
        </ConfirmModal>
      </HStack>
      <TxError action={stake} />
    </Stack>
  )
}

export default Stakeing
