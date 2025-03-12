import { Text, Stack, Card, ListItem, List, Button } from "@chakra-ui/react"
import { colors } from "@/config/defaults"
import React from "react"
import { num } from "@/helpers/num"
import { shiftDigits } from "@/helpers/math"
import { useCDTDailyVolume } from "@/hooks/useNumia"
import { useBoundedCDTRealizedAPR } from "../../hooks/useEarnQueries"



const RangeBoundInfoCard = ({ RBYield, TVL, scrollFn }: { RBYield: string, TVL: string, scrollFn: () => void }) => {

    const { data: realizedAPR } = useBoundedCDTRealizedAPR()

    return (
        <Card gap={0} width={"100%"} borderWidth={3} maxWidth="352px" height={"50%"} alignSelf="start" paddingTop={"4"} paddingBottom={0}>
            <Stack height="100%" gap={0}>
                <Text fontWeight="500" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={"white"}>Range Bound Info</Text>
                <List mt="4%" spacing={3} styleType="disc" padding="6" paddingTop="0">
                    <ListItem fontFamily="Inter" fontSize="md" fontWeight={"bold"}>TVL: ${shiftDigits(TVL, -6).toFixed(2)}</ListItem>
                    <ListItem fontFamily="Inter" fontSize="md" fontWeight={"bold"}><a style={{ fontWeight: "bold", color: colors.earnText }}>{realizedAPR ? `${realizedAPR?.runningDuration.toString()}D` : "Real"} APY: &nbsp;</a> <a className="textShadow">{realizedAPR?.negative ? "-" : ""}{(realizedAPR && realizedAPR.apr) ? num(realizedAPR?.apr).times(100).toFixed(1) + "%" : "loading..."}</a></ListItem>
                    <ListItem fontFamily="Inter" fontSize="md" fontWeight={"bold"}>Estimated APR: {num(RBYield).times(100).toFixed(1)}%</ListItem>
                </List>

                <Text alignSelf={"center"} marginTop={"auto"} mb={"2%"} fontFamily="Inter" fontSize="12px">see underlying Osmosis <a href="https://app.osmosis.zone/pool/1268" style={{ textDecoration: "underline", fontWeight: "bold" }}> CDT/USDC LP</a></Text>
            </Stack>
        </Card>
    )
}

export default RangeBoundInfoCard