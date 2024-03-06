import { TxButton } from '@/components/TxButton'
import TxError from '@/components/TxError'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { Stack, Text, Card } from '@chakra-ui/react'
import React, { ChangeEvent, useState } from 'react'
import Balance from './Balance'
import useStake from './hooks/useStake'
import { StakeInput } from './StakeInput'

const Stake = () => {
  const mbrnAsset = useAssetBySymbol('MBRN')
  const mbrnBalance = useBalanceByAsset(mbrnAsset)
  const [stakeAmount, setStakeAmount] = useState('')
  const stake = useStake({ amount: stakeAmount })

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setStakeAmount(e.target.value)
  }

  return (
    <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
      <Text variant="title" fontSize="24px">
        Stake
      </Text>

      <Stack>
        <StakeInput label="MBRN" value={stakeAmount} onChange={onInputChange} />
        <Balance
          label="In wallet"
          value={mbrnBalance}
          onMaxClick={() => setStakeAmount(mbrnBalance)}
        />
      </Stack>

      <TxButton
        maxW="200px"
        isLoading={stake.simulate.isLoading || stake.tx.isPending}
        isDisabled={stake.simulate.isError || Number(stakeAmount) <= 0}
        onClick={() => stake.tx.mutate()}
      >
        Stake
      </TxButton>
      <TxError action={stake} />
    </Card>
  )
}

export default Stake
