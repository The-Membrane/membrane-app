import { Card, Text } from '@chakra-ui/react'
import { Basket } from '@/contracts/codegen/positions/Positions.types'
import React from 'react'
import { useVaultInfo } from './hooks/useEarnQueries'
import { RedeemButton } from './RedeemButton'
import { colors } from '@/config/defaults'



export const ManicRedemptionCard = React.memo(({ basket }: { basket: Basket | undefined }) => {

    const { data: vaultInfo } = useVaultInfo()

    return (
        <Card gap={0} width={"100%"} borderWidth={3} maxWidth="352px" height={"44%"} alignSelf="start" paddingTop={"4"} paddingBottom={0}>
            <Text fontWeight="bold" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={colors.earnText}>Redeem</Text>

            <Text fontFamily="Inter" fontSize="md" fontWeight={"bold"}>Redemption Capacity: {vaultInfo?.debtAmount} CDT</Text>
            <RedeemButton basket={basket} />

            <a href="https://app.osmosis.zone/transactions" style={{ marginTop: "auto", marginBottom: "2%", textAlign: "center", justifyContent: "center", fontSize: "12px", display: "flex" }}>
                Go to Osmosis to check swap history -&gt;
            </a>
        </Card>
    )
})