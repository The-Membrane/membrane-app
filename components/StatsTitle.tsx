
import { useOraclePrice } from '@/hooks/useOracle'
import { getDebt, getProjectTVL } from '@/services/cdp'
import React, { useMemo } from 'react'
import { HStack, Stack, Text } from '@chakra-ui/react'
import { useCDTDailyVolume } from '@/hooks/useNumia'
import { Formatter } from '@/helpers/formatter'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { useBasket, useBasketPositions } from '@/hooks/useCDP'
import { useChainRoute } from '@/hooks/useChainRoute'
import useAppState from '@/persisted-state/useAppState'

export const Stats = React.memo(({ label, value }: { label: string; value: string }) => (
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
    const { chainName } = useChainRoute()
    const { appState } = useAppState()
    const { data: basket } = useBasket(appState.rpcUrl)
    const { data: data } = useCDTDailyVolume()
    // console.log("assetData", assetData, assetData?.volume_24h)
    const fixedArray = Array.isArray(data) ? data : Object.values(data ?? {});
    // console.log("fixedArray", fixedArray, fixedArray[0]?.volume_24h)
    const volume = fixedArray[0]?.volume_24h ?? 0


    const { data: prices } = useOraclePrice()

    const tvl = useMemo(() =>
        // TODO(evm-migration): getProjectTVL is a legacy CosmWasm-shape transform; useBasket is
        // null-stubbed and useOraclePrice returns the EVM denom-price shape, so cast through.
        getProjectTVL({ basket, prices, chainName } as any)
        , [basket, prices, chainName])

    const mintedAmount = useMemo(() => {
        // TODO(evm-migration): basket is null-stubbed (no aggregate basket view in Cdp.sol);
        // credit_asset.amount has no EVM equivalent here yet.
        const b = basket as any
        if (!b || !b.credit_asset || !b.credit_asset.amount) return 0
        return shiftDigits(num(b?.credit_asset.amount).toString(), -6).dp(0).toNumber()
    }, [basket])

    return (
        <HStack gap={36} justifyContent={"center"} mb={"3%"}>
            <Stats label="TVL" value={Formatter.currency(tvl, 0)} />
            <Stats label="Total Minted" value={`${Formatter.tvl(mintedAmount)} CDT`} />
            <Stats label="24h Volume" value={Formatter.currency(volume, 0)} />
        </HStack>
    )
})
