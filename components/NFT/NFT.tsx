import { HStack, Stack, Text } from '@chakra-ui/react'
import LiveAuction from './LiveAuction'
import NFTBid from './NFTBid'
import AssetAuction from './AssetAuction'
import BridgeTo from './BridgeTo'
import { useLiveAssetAuction, useLiveNFTAuction } from './hooks/useBraneAuction'
import React from "react"
import useNFTState from './hooks/useNFTState'

const NFT = React.memo(() => {
    const { data: liveNFTAuction } = useLiveNFTAuction()
    const { data: liveAssetAuction } = useLiveAssetAuction()
    const { NFTState } = useNFTState()

    console.log("Full page rerender")
    return (
        <HStack gap="5" w="full" alignItems="flex-start">
            <Stack w="full" gap="5">
                <Text variant="title">NFT AUCTION</Text>
                <LiveAuction tokenURI={liveNFTAuction?.submission_info.submission.token_uri} nftBidAmount={NFTState.nftBidAmount} />
                <NFTBid currentBid={liveNFTAuction?.highest_bid} auctionEndTime={liveNFTAuction?.auction_end_time??0}/>
            </Stack>
            <Stack w="full" gap="5">
                <BridgeTo />
                <AssetAuction currentBid={liveAssetAuction?.highest_bid.amount} auctionAmount={liveAssetAuction?.auctioned_asset.amount} assetBidAmount={NFTState.assetBidAmount} auctionEndTime={liveNFTAuction?.auction_end_time??0}/>
            </Stack>
            {/* Claim button for either the NFT or the Asset */}
        </HStack>
    )
})

export default NFT
