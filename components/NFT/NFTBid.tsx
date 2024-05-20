import { Card, HStack, Text, Stack } from "@chakra-ui/react"

const NFTBid = () => {
    // const {currentBid, timeLeft } = useLiveAuction()

    return (
        <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
            
            <HStack justifyContent="space-between">
                <Stack w="full" gap="1">
                    <Text fontSize="16px" fontWeight="700">
                    Current Bid
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                    {currentBid}
                    </Text>
                </Stack>                
                <Stack w="full" gap="1">
                    <Text fontSize="16px" fontWeight="700">
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