
import { useOraclePrice } from '@/hooks/useOracle'
import { getDebt, getProjectTVL } from '@/services/cdp'
import React, { useMemo } from 'react'
import { HStack, Stack, Text } from '@chakra-ui/react'
import { useCDTDailyVolume } from '@/hooks/useNumia'
import { Formatter } from '@/helpers/formatter'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useBasket, useBasketPositions } from '@/hooks/useCDP'
import useGlobalState from './Nav/hooks/useGlobalState'

export const Stats = React.memo(({ label, value }) => (
    <Stack gap="1">
        <Text variant="title" fontSize="15px" letterSpacing="unset" textTransform="none"
        >
            {label}
        </Text>
        <Text variant="title" letterSpacing="unset" fontSize="4xl">
            {value}
        </Text>
    </Stack>
))

// Memoize child components
export const StatsTitle = React.memo(() => {

    const { setGlobalState } = useGlobalState()
    const { data: basketPositions } = useBasketPositions()
    const { data: basket } = useBasket()
    const { data: data } = useCDTDailyVolume()
    // console.log("assetData", assetData, assetData?.volume_24h)
    const fixedArray = Array.isArray(data) ? data : Object.values(data ?? {});
    // console.log("fixedArray", fixedArray, fixedArray[0]?.volume_24h)
    const volume = fixedArray[0]?.volume_24h ?? 0


    const { data: prices } = useOraclePrice()

    const tvl = useMemo(() =>
        getProjectTVL({ basket, prices })
        , [basket, prices])

    const totalDebt = useMemo(() => {

        let totalDebt = 0;

        basketPositions?.forEach((basketPosition) => {
            if (!basketPosition || basketPosition.positions.length === 0) return;

            basketPosition.positions.forEach((position, posIndex) => {
                const debt = getDebt([basketPosition], posIndex);
                totalDebt += debt;

            });
        });

        setGlobalState({ totalDebt: totalDebt });
        return totalDebt;
    }, [basketPositions])

    const mintedAmount = useMemo(() => {
        const cdtAmount = basket?.credit_asset?.amount || 0
        return num(shiftDigits(cdtAmount, -6)).dp(0).toNumber()
    }, [basket])

    return (
        <HStack gap={36} justifyContent={"center"} mb={"3%"}>
            <Stats label="TVL" value={Formatter.currency(tvl, 0)} />
            <Stats label="Total Minted" value={`${Formatter.tvl(mintedAmount)} CDT`} />
            <Stats label="24h Volume" value={Formatter.currency(volume, 0)} />
        </HStack>
    )
})
