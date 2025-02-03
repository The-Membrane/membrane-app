import { Text, Stack, HStack, Slider, Card, SliderFilledTrack, SliderTrack } from '@chakra-ui/react'

import React, { useMemo, useState } from "react"
import { useBasket } from '@/hooks/useCDP'
import { num, shiftDigits } from '@/helpers/num'
import { useRBLPCDTBalance } from '../Earn/hooks/useEarnQueries'
import Divider from '../Divider'
import { Formatter } from '@/helpers/formatter'
import { TxButton } from '../TxButton'
import useBoundedManage from '../Home/hooks/useRangeBoundLPManage'
import useFulfillIntents from '../Home/hooks/useFulfillIntents'
import { StatsTitle } from '../StatsTitle'

const ManagementCard = React.memo(({ basket }: { basket: any }) => {
    const [idSkips, setSkips] = useState([] as string[])

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
            if (positionID && !idSkips.includes(positionID)) {
                // idSkips.push(positionID)
                setSkips([...idSkips, positionID])
            }
        }
        return fulfill?.simulate.isError || !fulfill?.simulate.data
    }, [fulfill?.simulate.isError, fulfill?.simulate.data])
    if (isFulfillDisabled) console.log("isFulfillDisabled", fulfill?.simulate, fulfill?.simulate.isError, !fulfill?.simulate)
    return (
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
    )
})

const Dashboard = () => {
    const { data: basket } = useBasket()

    // Memoize the entire content to prevent unnecessary re-renders
    return (
        <Stack>
            <StatsTitle />
            <Divider mx="0" mb="5" />
            <ManagementCard basket={basket} />
        </Stack>
    );

};

// Only use memo if this component's parent might cause unnecessary re-renders
export default Dashboard;