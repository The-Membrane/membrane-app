import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Card, Stack, Text } from '@chakra-ui/react'
import React, { useMemo, useState } from 'react'
import { TxButton } from '../TxButton'
import TxError from '../TxError'
import Balance from './Balance'
import { StakeInput } from './StakeInput'
import useStaked from './hooks/useStaked'
import useUnstake from './hooks/useUnstake'

const Unstake = () => {
  const { data: staked } = useStaked()
  const mbrnAsset = useAssetBySymbol('MBRN')
  const [unstakeAmount, setUnstakeAmount] = useState('0')
  const unstake = useUnstake({ amount: unstakeAmount })

  const stakedBalance = useMemo(() => {
    if (!staked || !mbrnAsset) return '0'

    return shiftDigits(staked?.staked.total_staked, -mbrnAsset?.decimal).toString()
  }, [staked, mbrnAsset])

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUnstakeAmount(e.target.value)
  }

  return (
    <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
      <Text variant="title" fontSize="24px">
        Unstake
      </Text>

      <Stack>
        <StakeInput label="MBRN" value={unstakeAmount} onChange={onInputChange} />
        <Balance
          label="Staked"
          value={stakedBalance}
          onMaxClick={() => setUnstakeAmount(stakedBalance)}
        />
      </Stack>

      <TxButton
        maxW="200px"
        isLoading={unstake.simulate.isLoading || unstake.tx.isPending}
        isDisabled={unstake.simulate.isError || Number(unstakeAmount) <= 0}
        onClick={() => unstake.tx.mutate()}
      >
        Unstake
      </TxButton>
      <TxError action={unstake} />
    </Card>
  )
}

export default Unstake
