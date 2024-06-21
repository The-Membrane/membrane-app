import { HStack, Stack, Text } from '@chakra-ui/react'
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
      fontSize="4xl"
    >
      {label}
    </Text>
    <Text variant="title" letterSpacing="unset" textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)" fontSize="4xl">
      {value}
    </Text>
  </Stack>
)

export const StatsCard = React.memo(() => {
  const { data: basket } = useBasket()
  const { data: prices } = useOraclePrice()
  const cdtAmount = basket?.credit_asset?.amount || 0
  const mintedAmount = shiftDigits(cdtAmount, -6).dp(0).toNumber()

  const tvl = useMemo(() => {
    return getProjectTVL({ basket, prices })
  }, [basket, prices])

  const [titleToggle, setTitleToggle] = React.useState(true)

  return (    
    <Stack gap={3}>
      <HStack mt="auto" gap="24" justifyContent={"center"} onClick={()=>setTitleToggle(!titleToggle)}>
      {titleToggle ?
      
      <Stack gap={3}>
        <Text fontWeight="bold" fontSize="33px" fontFamily="monospace" justifyContent="center" display="flex">
        80/20 Bundle. Let the 20% Bolster Your Foundation.
        </Text>
      </Stack>
           :
        <><Stats label="TVL" value={Formatter.currency(tvl, 0)} />
        <Stats label="Total Minted" value={`${Formatter.tvl(mintedAmount)} CDT`} /></>}
      </HStack>
      <Divider mx="0" mb="5" />
    </Stack>
  )
})
