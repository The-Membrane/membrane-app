import { HStack, Stack, Text } from '@chakra-ui/react'
import React, { useMemo } from 'react'
import Divider from './Divider'
import { useBasket } from '@/hooks/useCDP'
import { shiftDigits } from '@/helpers/math'
import { Formatter } from '@/helpers/formatter'
import { getProjectTVL } from '@/services/cdp'
import { useOraclePrice } from '@/hooks/useOracle'
import { useBalanceByAsset } from '@/hooks/useBalance'
import { useAssetBySymbol } from '@/hooks/useAssets'

export const Stats = ({ label, value }) => (
  <Stack gap="1">

    {label != "" ? <Text
      variant="title"
      letterSpacing="unset"
      textTransform="none"
      textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)"
      fontSize="lg"
    >
      {label}
    </Text> : null}
    <Text variant="title" letterSpacing="unset" textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)">
      {value}
    </Text>
  </Stack>
)

export const BalanceCard = () => {
  const cdt = useAssetBySymbol('CDT')
  const cdtBalance = useBalanceByAsset(cdt)
  const mbrn = useAssetBySymbol('MBRN')
  const mbrnBalance = useBalanceByAsset(mbrn)

  return (
    <Stack gap="3">
      <Divider mx="0" mb="5" />
      <Stats label="Wallet Balances" value={`${Formatter.tvl(mbrnBalance)} MBRN`} />
      <Stats label="" value={`${Formatter.tvl(cdtBalance)} CDT`} />
    </Stack>
  )
}
