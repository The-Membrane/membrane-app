import { HStack, Stack, Text } from '@chakra-ui/react'
import LiveAuction from './LiveAuction'
import NFTBid from './NFTBid'
import AssetAuction from './AssetAuction'
import { useLiveNFTAuction } from './hooks/useBraneAuction'
import useCountdown from '@/hooks/useCountdown'

const NFT = () => {    
    const { data: liveNFTAuction } = useLiveNFTAuction()
    const currentBid = liveNFTAuction?.highest_bid    
    const timeLeft = useCountdown(liveNFTAuction?.auction_end_time).timeString
    const currentNFTIPFS = liveNFTAuction?.submission_info.submission.token_uri

    return (
        <HStack gap="5" w="full" alignItems="flex-start">
            <Stack w="full" gap="5">
                <Text variant="title">NFT AUCTION</Text>
                <LiveAuction liveAuctionIPFS={currentNFTIPFS}/>
                <NFTBid currentBid={currentBid} timeLeft={timeLeft} />
            </Stack>
            <AssetAuction />
            {/* Claim button for either the NFT or the Asset */}
        </HStack>
    )
}

export default NFT
