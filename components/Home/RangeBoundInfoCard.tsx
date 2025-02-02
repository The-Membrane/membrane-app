import { Text, Stack, Card, ListItem, List } from "@chakra-ui/react"
import { colors } from "@/config/defaults"
import React from "react"
import { num } from "@/helpers/num"
import { shiftDigits } from "@/helpers/math"
import { useCDTDailyVolume } from "@/hooks/useNumia"



const RangeBoundInfoCard = ({ RBYield, TVL }: { RBYield: string, TVL: string }) => {
    const { data: log } = useCDTDailyVolume()
    console.log("numia info log", log)

    return (
        <Card gap={0} width={"32%"} borderWidth={3} maxWidth="352px" height={"40%"} alignSelf="start" paddingTop={"4"}>
            <Stack height="100%">
                <Text fontWeight="bold" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={colors.earnText}>Info</Text>
                <List spacing={3} styleType="disc" padding="6" paddingTop="0">
                    <ListItem fontFamily="Inter" fontSize="md" fontWeight={"bold"}>TVL: ${shiftDigits(TVL, -6).toFixed(2)}</ListItem>
                    <ListItem fontFamily="Inter" fontSize="md" fontWeight={"bold"}>APR: {num(RBYield).times(100).toFixed(1)}%</ListItem>
                </List>
                <Text alignSelf={"center"} marginTop={"auto"} fontFamily="Inter" fontSize="12px">see underlying Osmosis' <a href="https://app.osmosis.zone/pool/1268" style={{ textDecoration: "underline", fontWeight: "bold" }}> CDT/USDC LP</a></Text>
            </Stack>
        </Card>
    )
}

export default RangeBoundInfoCard