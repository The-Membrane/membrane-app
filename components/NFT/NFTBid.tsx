import { Card, HStack, Text, Stack } from "@chakra-ui/react"
import { useLiveNFTAuction } from "./hooks/useBraneAuction"
import { shiftDigits } from "@/helpers/math"
import { TxButton } from "../TxButton"
import useConcludeAuction from "./hooks/useConcludeAuction"
import Countdown from "../Countdown"
import dayjs from "dayjs"
import { useEffect, useState } from "react"

const NFTBid = () => {
    const { data: liveNFTAuction } = useLiveNFTAuction()
    const conclude = useConcludeAuction()
    const currentBid = liveNFTAuction?.highest_bid    

    const currentTime = dayjs()
    const [remainingTime, setremainingTime] = useState(0)
    useEffect(() => {
        const endTime = dayjs.unix(liveNFTAuction?.auction_end_time??0)
        setremainingTime(endTime.diff(currentTime, 'second'))

    }, [liveNFTAuction])


    return (
        <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
            
            <HStack justifyContent="space-between" gap="24">
                <Stack w="full" gap="1">
                    <Text fontSize="16px" fontWeight="700">
                    Current Bid
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                    {shiftDigits(currentBid?.amount??0, -6).toString()} CDT
                    </Text>
                </Stack>                
                {remainingTime > 0 ? <Stack w="full" gap="1">
                    <Text fontSize="16px" fontWeight="700" width="118%">
                    Time Remaining
                    </Text>
                    <Countdown timestamp={liveNFTAuction?.auction_end_time}/>
                </Stack> : 
                <TxButton
                    marginTop={"3%"}
                    w="100%"
                    px="10"
                    isDisabled={conclude?.action.simulate.isError || !conclude?.action.simulate.data}
                    isLoading={conclude.action.simulate.isPending && !conclude.action.simulate.isError && conclude.action.simulate.data}
                    onClick={() => conclude.action.tx.mutate()}
                    chain_name="stargaze"
                    >
                    Conclude Auction
                </TxButton>}
            </HStack>
        </Card>
    )
}

export default NFTBid