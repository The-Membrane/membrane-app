import { Card, HStack, Text, Stack } from "@chakra-ui/react"
import { useLiveNFTAuction } from "./hooks/useBraneAuction"
import useCountdown from "@/hooks/useCountdown"

const NFTBid = () => {
    const { data: liveNFTAuction } = useLiveNFTAuction()
    const currentBid = liveNFTAuction?.highest_bid    
    const timeLeft = useCountdown(liveNFTAuction?.auction_end_time).timeString

    return (
        <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
            
            <HStack justifyContent="space-between" gap="24">
                <Stack w="full" gap="1">
                    <Text fontSize="16px" fontWeight="700">
                    Current Bid
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                    {currentBid?.amount??0}
                    </Text>
                </Stack>                
                <Stack w="full" gap="1">
                    <Text fontSize="16px" fontWeight="700" width="118%">
                    Time Remaining
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                    {timeLeft}
                    </Text>
                </Stack>
            </HStack>
        </Card>
    )
}

export default NFTBid