import { Stack, Text } from '@chakra-ui/react'
import React, { useMemo } from 'react'
import Divider from './Divider'
import { useBasket } from '@/hooks/useCDP'
import { shiftDigits } from '@/helpers/math'
import { Formatter } from '@/helpers/formatter'
import { getProjectTVL } from '@/services/cdp'
import { useOraclePrice } from '@/hooks/useOracle'

export const Stats = ({ label, value }) => (
  <Stack gap="1">
    <Text
      variant="title"
      letterSpacing="unset"
      textTransform="none"
      textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)"
      fontSize="lg"
    >
      {label}
    </Text>
    <Text variant="title" letterSpacing="unset" textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)">
      {value}
    </Text>
  </Stack>
)

export const StatsCard = () => {
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  const cdtAmount = basket?.credit_asset?.amount || 0
  const mintedAmount = shiftDigits(cdtAmount, -6).dp(0).toNumber()

  const tvl = useMemo(() => {
    return getProjectTVL({ basket, prices })
  }, [basket, prices])

  return (
    <Stack mt="auto" gap="3">
      <Divider mx="0" mb="5" />
      <Stats label="TVL" value={Formatter.currency(tvl, 0)} />
      <Stats label="Total Minted" value={`${Formatter.tvl(mintedAmount)} CDT`} />
    </Stack>
  )
}
