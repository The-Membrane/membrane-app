import { Text, Stack, Card, ListItem, List } from "@chakra-ui/react"
import { colors } from "@/config/defaults"
import React from "react"
import { num } from "@/helpers/num"



const RangeBoundInfoCard = ({ RBYield, TVL }: { RBYield: string, TVL: string }) => {

    return (
        <Card gap={0} width={"32%"} borderWidth={3} maxWidth="352px" height={"69%"} alignSelf="start">
            <Stack height="100%">
                <Text fontWeight="bold" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={colors.earnText}>Info</Text>
                <List spacing={3} styleType="disc" padding="6" paddingTop="0">
                    <ListItem fontFamily="Inter" fontSize="md">TVL: {num(TVL).toFixed(2)}</ListItem>
                    <ListItem fontFamily="Inter" fontSize="md" fontWeight={"bold"}>APR: {num(RBYield).times(100).toFixed(1)}%</ListItem>
                    <ListItem fontFamily="Inter" fontSize="md">This vault is 2 concentrated liquidity positions in Osmosis' <a href="https://app.osmosis.zone/pool/1268" style={{ textDecoration: "underline", fontWeight: "bold" }}> CDT/USDC LP</a></ListItem>
                </List>
            </Stack>
        </Card>
    )
}

export default RangeBoundInfoCard