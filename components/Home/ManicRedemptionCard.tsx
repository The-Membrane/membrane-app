import { Card, Text } from '@chakra-ui/react'
import { Basket } from '@/contracts/codegen/positions/Positions.types'
import React from 'react'
import { useVaultInfo } from '../Earn/hooks/useEarnQueries'
import { RedeemButton } from '../Earn/RedeemButton'
import { colors } from '@/config/defaults'
import { HomeRedeemButton } from './HomeRedemptionButton'
import { num } from '@/helpers/num'



export const ManicRedemptionCard = React.memo(({ basket, cdtMarketPrice }: { basket: Basket | undefined, cdtMarketPrice: number }) => {

    const { data: vaultInfo } = useVaultInfo()

    //Set max slippage to the difference between market prie & 0.985 
    const maxSlippage = 0.985 - cdtMarketPrice
    //We don't render this if price is higher so this should be safe logic

    var minimumSwapCapacity = num(cdtMarketPrice * (1 - maxSlippage)).times(vaultInfo?.debtAmount || 0).toFixed(0)

    if (Number(minimumSwapCapacity) < 22) minimumSwapCapacity = "0"

    return (
        <Card gap={0} width={"100%"} borderWidth={3} maxWidth="352px" height={"41%"} alignSelf="start" paddingTop={"4"} paddingBottom={0}>
            <Text fontWeight="500" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={"white"} >Earn USDC</Text>
            <Text mb="4%" fontFamily="Inter" fontSize="md" fontWeight={"bold"}>Remaining Capacity: {minimumSwapCapacity} USDC</Text>

            <HomeRedeemButton basket={basket} cdtMarketPrice={cdtMarketPrice} />

            {/* <a href="https://app.osmosis.zone/transactions" style={{ marginTop: "auto", marginBottom: "2%", textAlign: "center", justifyContent: "center", fontSize: "12px", display: "flex" }}>
                Go to Osmosis to check swap history -&gt;
            </a> */}
        </Card>
    )
})