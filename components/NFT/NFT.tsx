import Governance from '@/components/Governance'
import { HStack, Stack, Text } from '@chakra-ui/react'
import Delegate from '@/components/Governance/Delegate'
import LiveAuction from './LiveAuction'
import NFTBid from './NFTBid'

const NFT = () => {
    return (
        <HStack gap="5" w="full" alignItems="flex-start">
            <Stack w="full" gap="5">
                <Text variant="title">NFT AUCTION</Text>
                <LiveAuction />
                <NFTBid />
            </Stack>
            <Governance />
        </HStack>
    )
}

export default NFT
