import { HStack, Stack, Text } from '@chakra-ui/react'
import LiveAuction from './LiveAuction'
import NFTBid from './NFTBid'
import AssetAuction from './AssetAuction'

const NFT = () => {    
    return (
        <HStack gap="5" w="full" alignItems="flex-start">
            <Stack w="full" gap="5">
                <Text variant="title">NFT AUCTION</Text>
                <LiveAuction/>
                <NFTBid />
            </Stack>
            <AssetAuction />
            {/* Claim button for either the NFT or the Asset */}
        </HStack>
    )
}

export default NFT
