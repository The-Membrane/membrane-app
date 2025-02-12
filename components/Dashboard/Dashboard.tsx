import { Text, Stack, HStack, Slider, Card, SliderFilledTrack, SliderTrack } from '@chakra-ui/react'

import React, { useMemo, useState } from "react"
import { useBasket } from '@/hooks/useCDP'
import { shiftDigits } from '@/helpers/math'
import { useRBLPCDTBalance } from '../Earn/hooks/useEarnQueries'
import Divider from '../Divider'
import { Formatter } from '@/helpers/formatter'
import { TxButton } from '../TxButton'
import useBoundedManage from '../Home/hooks/useRangeBoundLPManage'
import useFulfillIntents from '../Home/hooks/useFulfillIntents'
import { StatsTitle } from '../StatsTitle'
import { getAssetByDenom } from '@/helpers/chain'
import { Basket } from '@/contracts/codegen/positions/Positions.types'
import { Price } from '@/services/oracle'
import { num } from '@/helpers/num'
import { useOraclePrice } from '@/hooks/useOracle'
import AssetPieChart from './PieChart'
import { colors } from '@/config/defaults'

const ManagementCard = React.memo(({ basket }: { basket: any }) => {
    const [idSkips, setSkips] = useState([] as number[])

    const { action: manage } = useBoundedManage()
    const { action: fulfill } = useFulfillIntents({ run: true, skipIDs: idSkips })
    const { data: amountToManage } = useRBLPCDTBalance()

    const revenueDistributionThreshold = 50000000
    const percentToDistribution = useMemo(() => {
        if (!basket) return 0
        return num(basket?.pending_revenue).dividedBy(revenueDistributionThreshold).toNumber()

    }, [basket])
    const isManageDisabled = useMemo(() => { return manage?.simulate.isError || !manage?.simulate.data || num(amountToManage).isZero() }, [manage?.simulate.isError, manage?.simulate.data])
    const isFulfillDisabled = useMemo(() => {
        if (fulfill?.simulate.isError) {
            //Find the position ID string in the error, it'll look like Position doesn't exist: 1
            const positionID = fulfill?.simulate.error?.message?.match(/Position doesn't exist: (\d+)/)?.[1];
            if (positionID && !idSkips.includes(Number(positionID))) {
                // idSkips.push(positionID)
                setSkips([...idSkips, Number(positionID)])
            }
        }
        return fulfill?.simulate.isError || !fulfill?.simulate.data
    }, [fulfill?.simulate.isError, fulfill?.simulate.data])
    if (isFulfillDisabled) console.log("isFulfillDisabled", fulfill?.simulate, fulfill?.simulate.isError, !fulfill?.simulate)
    return (
        <Stack>
            <Text fontWeight="bold" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={colors.earnText}>Product Management</Text>
            <Card gap={16} width={"33%"}>
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
        </Stack>
    )
})

const getProjectTVL = ({ basket, prices }: { basket?: Basket; prices?: Price[] }) => {
    if (!basket || !prices) return { TVL: 0, positions: [] }
    const positions = basket?.collateral_types.map((asset) => {
        //@ts-ignore
        const denom = asset.asset?.info.native_token?.denom
        const assetInfo = getAssetByDenom(denom)
        // console.log(assetInfo, denom, asset.asset)
        const amount = shiftDigits(asset.asset.amount, -(assetInfo?.decimal ?? 6)).toNumber()
        const assetPrice = prices?.find((price) => price.denom === denom)?.price || 0

        const usdValue = Number(num(amount).times(assetPrice).toFixed(1))
        // console.log(assetInfo?.symbol, usdValue, amount, assetPrice)
        return { name: assetInfo?.symbol, value: usdValue, totalValue: 0 }
    })

    return {
        TVL: positions.reduce((acc, position) => {
            if (!position) return acc
            return acc + position.value
        }, 0), positions
    }
}

const Dashboard = () => {
    const { data: basket } = useBasket()
    const { data: prices } = useOraclePrice()
    const assetData = useMemo(() => {
        const { TVL, positions } = getProjectTVL({ basket, prices })
        //Set TVL in each position object to the outputted TVL
        positions.forEach((position) => {
            position.totalValue = TVL
        })
        return positions

    }, [basket, prices])

    // Memoize the entire content to prevent unnecessary re-renders
    return (
        <Stack>
            <StatsTitle />
            <Divider mx="0" mb="5" />
            {/* <HStack> */}
            <AssetPieChart data={assetData} />

            {/* </HStack> */}
            <ManagementCard basket={basket} />
        </Stack>
    );

};

// Only use memo if this component's parent might cause unnecessary re-renders
export default Dashboard;