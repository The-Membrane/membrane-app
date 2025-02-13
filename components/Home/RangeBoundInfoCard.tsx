import { Text, Stack, Card, ListItem, List, Button } from "@chakra-ui/react"
import { colors } from "@/config/defaults"
import React from "react"
import { num } from "@/helpers/num"
import { shiftDigits } from "@/helpers/math"
import { useCDTDailyVolume } from "@/hooks/useNumia"



const RangeBoundInfoCard = ({ RBYield, TVL, scrollFn }: { RBYield: string, TVL: string, scrollFn: () => void }) => {

    const { data: data } = useCDTDailyVolume()
    // console.log("assetData", assetData, assetData?.volume_24h)
    const fixedArray = Array.isArray(data) ? data : Object.values(data ?? {});
    // console.log("fixedArray", fixedArray, fixedArray[0]?.volume_24h)
    const priceDelta = fixedArray[0]?.price_7d_change ?? 0

    return (
        <Card gap={0} width={"100%"} borderWidth={3} maxWidth="352px" height={"44%"} alignSelf="start" paddingTop={"4"} paddingBottom={0}>
            <Stack height="100%" gap={0}>
                <Text fontWeight="bold" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={colors.earnText}>Range Bound Info</Text>
                <List mt="4%" spacing={3} styleType="disc" padding="6" paddingTop="0">
                    <ListItem fontFamily="Inter" fontSize="md" fontWeight={"bold"}>TVL: ${shiftDigits(TVL, -6).toFixed(2)}</ListItem>
                    <ListItem fontFamily="Inter" fontSize="md" fontWeight={"bold"}>APR: {num(RBYield).times(100).toFixed(1)}%</ListItem>
                    <ListItem fontFamily="Inter" fontSize="md" fontWeight={"bold"}>7d Peg Change: {num(priceDelta).absoluteValue().toFixed(3)}%</ListItem>
                </List>

                <Button onClick={scrollFn} className="flex items-center gap-2" mb={"2%"}>
                    Go to Yield
                </Button>
                <Text alignSelf={"center"} marginTop={"auto"} mb={"2%"} fontFamily="Inter" fontSize="12px">see underlying Osmosis <a href="https://app.osmosis.zone/pool/1268" style={{ textDecoration: "underline", fontWeight: "bold" }}> CDT/USDC LP</a></Text>
            </Stack>
        </Card>
    )
}

export default RangeBoundInfoCard