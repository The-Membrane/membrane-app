import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { Box, Stack, Text } from '@chakra-ui/react'
import React, { useMemo, useState } from 'react'
import { TxButton } from '../TxButton'
import TxError from '../TxError'
import Balance from './Balance'
import { StakeInput } from './StakeInput'
import useStaked from './hooks/useStaked'
import useUnstake from './hooks/useUnstake'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'

const Unstake = () => {
  const { data: staked } = useStaked(true)
  const mbrnAsset = useAssetBySymbol('MBRN')
  const [unstakeAmount, setUnstakeAmount] = useState('0')
  const unstake = useUnstake({ amount: unstakeAmount })

  const stakedBalance = useMemo(() => {
    if (!staked || !mbrnAsset) return '0'

    return shiftDigits(staked?.staked, -mbrnAsset?.decimal).toString()
  }, [staked, mbrnAsset])

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUnstakeAmount(e.target.value)
  }

  return (
    <Box
      w="full"
      p={SPACING.xl}
      display="flex"
      flexDirection="column"
      alignItems="center"
      gap={SPACING.lg}
      h="full"
      justifyContent="space-between"
      bg={SEMANTIC_COLORS.bgSecondary}
      borderRadius={0}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
    >
      <Text fontFamily="heading" fontSize={TYPOGRAPHY.h2} color={SEMANTIC_COLORS.textPrimary}>
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
        _focus={FOCUS_STYLES.ring}
        isLoading={unstake.simulate.isLoading || unstake.tx.isPending}
        isDisabled={unstake.simulate.isError || Number(unstakeAmount) <= 0}
        onClick={() => unstake.tx.mutate()}
      >
        Unstake
      </TxButton>
      <TxError action={unstake} />
    </Box>
  )
}

export default Unstake
