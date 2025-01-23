import { Text, Stack, HStack, Slider, Card, SliderFilledTrack, SliderTrack } from '@chakra-ui/react'

import React, { useMemo } from "react"
import { useBasket } from '@/hooks/useCDP'
import { num, shiftDigits } from '@/helpers/num'
import { useRBLPCDTBalance } from '../Earn/hooks/useEarnQueries'
import { useOraclePrice } from '@/hooks/useOracle'
import { getProjectTVL } from '@/services/cdp'
import Divider from '../Divider'
import { Formatter } from '@/helpers/formatter'
import { TxButton } from '../TxButton'
import useBoundedManage from '../Home/hooks/useRangeBoundLPManage'
import useFulfillIntents from '../Home/hooks/useFulfillIntents'

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
const StatsTitle = React.memo(({ basket }: { basket: any }) => {
    const { data: prices } = useOraclePrice()

    const tvl = useMemo(() =>
        getProjectTVL({ basket, prices })
        , [basket, prices])

    const mintedAmount = useMemo(() => {
        const cdtAmount = basket?.credit_asset?.amount || 0
        return num(shiftDigits(cdtAmount, -6)).dp(0).toNumber()
    }, [basket])

    return (
        <HStack gap={16} >
            <Stats label="TVL" value={Formatter.currency(tvl, 0)} />
            <Stats label="Total Minted" value={`${Formatter.tvl(mintedAmount)} CDT`} />
        </HStack>
    )
})
const ManagementCard = React.memo(({ basket }: { basket: any }) => {
    const { action: manage } = useBoundedManage()
    const { action: fulfill } = useFulfillIntents(true)
    const { data: amountToManage } = useRBLPCDTBalance()

    const revenueDistributionThreshold = 50000000
    const percentToDistribution = useMemo(() => {
        if (!basket) return 0
        return num(basket?.pending_revenue).dividedBy(revenueDistributionThreshold).toNumber()

    }, [basket])
    const isManageDisabled = useMemo(() => { return manage?.simulate.isError || !manage?.simulate.data || num(amountToManage).isZero() }, [manage?.simulate.isError, manage?.simulate.data])
    const isFulfillDisabled = useMemo(() => { return fulfill?.simulate.isError || !fulfill?.simulate.data }, [fulfill?.simulate.isError, fulfill?.simulate.data])
    if (isFulfillDisabled) console.log("isFulfillDisabled", fulfill?.simulate.errorMessage, !fulfill?.simulate)
    return (
        <Card gap={16} >
            <TxButton
                maxW="100%"
                isLoading={fulfill?.simulate.isLoading || fulfill?.tx.isPending}
                isDisabled={isFulfillDisabled}
                onClick={() => fulfill?.tx.mutate()}
                toggleConnectLabel={false}
                style={{ alignSelf: "center" }}
            >
                Fulfill Intents
            </TxButton>
            <Slider
                defaultValue={percentToDistribution}
                isReadOnly
                cursor="default"
                min={0}
                max={1}
                value={percentToDistribution}
            >
                <SliderTrack h="1.5">
                    <SliderFilledTrack bg={'#20d6ff'} />
                </SliderTrack>
            </Slider>
            <TxButton
                maxW="100%"
                isLoading={manage?.simulate.isLoading || manage?.tx.isPending}
                isDisabled={isManageDisabled}
                onClick={() => manage?.tx.mutate()}
                toggleConnectLabel={false}
                style={{ alignSelf: "center" }}
            >
                {isManageDisabled && percentToDistribution >= 1 ? "Next Repayment Pays to LPs" : "Manage Vault"}
            </TxButton>
        </Card>
    )
})

const Dashboard = () => {
    const { data: basket } = useBasket()

    // Memoize the entire content to prevent unnecessary re-renders
    return (
        <Stack>
            <StatsTitle basket={basket} />
            <Divider mx="0" mb="5" />
            <ManagementCard basket={basket} />
        </Stack>
    );

};

// Only use memo if this component's parent might cause unnecessary re-renders
export default Dashboard;