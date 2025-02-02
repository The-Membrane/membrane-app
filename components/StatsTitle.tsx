
import { useOraclePrice } from '@/hooks/useOracle'
import { getProjectTVL } from '@/services/cdp'
import React, { useMemo } from 'react'
import { HStack, Stack, Text } from '@chakra-ui/react'
import { useCDTDailyVolume } from '@/hooks/useNumia'
import { Formatter } from '@/helpers/formatter'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useBasket } from '@/hooks/useCDP'

export const Stats = React.memo(({ label, value }) => (
    <Stack gap="1">
        <Text variant="title" letterSpacing="unset" textTransform="none"
            textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)" fontSize="4xl">
            {label}
        </Text>
        <Text variant="title" letterSpacing="unset"
            textShadow="0px 0px 8px rgba(223, 140, 252, 0.80)" fontSize="4xl">
            {value}
        </Text>
    </Stack>
))

// Memoize child components
export const StatsTitle = React.memo(() => {

    const { data: basket } = useBasket()
    const { data: assetData } = useCDTDailyVolume()
    console.log("assetData", assetData, assetData?.[0].volume_24h, assetData[0].volume_24h, assetData.volume_24h)
    const volume = assetData?.[0].volume_24h || 0
    const { data: prices } = useOraclePrice()

    const tvl = useMemo(() =>
        getProjectTVL({ basket, prices })
        , [basket, prices])

    const mintedAmount = useMemo(() => {
        const cdtAmount = basket?.credit_asset?.amount || 0
        return num(shiftDigits(cdtAmount, -6)).dp(0).toNumber()
    }, [basket])

    return (
        <HStack gap={16} justifyContent={"center"}>
            <Stats label="TVL" value={Formatter.currency(tvl, 0)} />
            <Stats label="Total Minted" value={`${Formatter.tvl(mintedAmount)} CDT`} />
            <Stats label="24h Volume" value={Formatter.currency(volume, 0)} />
        </HStack>
    )
})
