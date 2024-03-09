import TxError from '@/components/TxError'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { HStack, Stack, Text } from '@chakra-ui/react'
import { useEffect, useMemo, useState } from 'react'
import ConfirmModal from '../ConfirmModal'
import { SliderWithState } from '../Mint/SliderWithState'
import { Summary } from './Summary'
import useStakeing from './hooks/useStake'
import useStakeState from './hooks/useStakeState'
import useStaked from './hooks/useStaked'

const Stakeing = () => {
  const mbrnAsset = useAssetBySymbol('MBRN')
  const mbrnBalance = useBalanceByAsset(mbrnAsset)
  const [stakeAmount, setStakeAmount] = useState(0)
  const stake = useStakeing({ amount: stakeAmount.toString() })
  const { data: staked } = useStaked()
  const { stakeState, setStakeState } = useStakeState()

  const stakedBalance = useMemo(() => {
    if (!staked || !mbrnAsset) return 0

    return shiftDigits(staked?.staked.total_staked, -mbrnAsset?.decimal).toNumber()
  }, [staked, mbrnAsset])

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
      <ConfirmModal label={stakeState.txType || 'Stake'} action={stake}>
        <Summary />
        <TxError action={stake} />
      </ConfirmModal>
      <TxError action={stake} />
    </Stack>
  )
}

export default Stakeing
