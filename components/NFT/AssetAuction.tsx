import { Card, HStack, Text, Stack } from "@chakra-ui/react"
import { SliderWithState } from "../Mint/SliderWithState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { useBalanceByAsset } from "@/hooks/useBalance"
import useNFTState from "./hooks/useNFTState"
import { isGreaterThanZero } from "@/helpers/num"
import { TxButton } from "../TxButton"
import { useLiveAssetAuction, useLiveNFTAuction } from "./hooks/useBraneAuction"
import useCountdown from "@/hooks/useCountdown"
import useLiveAssetBid from "./hooks/useLiveAssetBid"

const AssetAuction = () => {
    const { NFTState, setNFTState } = useNFTState()
    const bid = useLiveAssetBid()
    const { data: liveAssetAuction } = useLiveAssetAuction()
    const auctionAmount = liveAssetAuction?.auctioned_asset.amount
    const currentBid = liveAssetAuction?.highest_bid.amount
    const { data: liveNFTAuction } = useLiveNFTAuction()
    //Bid Auctions end when the current NFT auction does
    const timeLeft = useCountdown(liveNFTAuction?.auction_end_time).timeString

    const mbrn = useAssetBySymbol('MBRN')
    //Comment this until we add MBRN & CDT to SG registry
    //Then change the useBalanceByAsset to use the correct Asset
    // const stargazeMBRN = useAssetBySymbol('MBRN', 'stargaze')
    const stargazeMBRNBalance = useBalanceByAsset(mbrn, 'stargaze')
    const osmosisMBRNBalance = useBalanceByAsset(mbrn)
    
    const onBidChange = (value: number) => {
        setNFTState({ assetBidAmount: value })
    }

    return (
        <Card w="full" p="8" marginTop={"5.1%"} alignItems="center" gap={5} h="50%" justifyContent="space-between">            
            <Stack w="full" gap="1">
                <Text fontSize="16px" fontWeight="700">
                Auction for {auctionAmount??0} CDT
                </Text>
                <Text fontSize="16px" fontWeight="700">
                Current Bid: {currentBid??0} MBRN
                </Text>
                <Text fontSize="16px" fontWeight="700">
                Time Left: {timeLeft}
                </Text>
                <HStack justifyContent="space-between">
                    <Text fontSize="16px" fontWeight="700">
                    MBRN
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                    {NFTState.assetBidAmount}
                    </Text>
                </HStack>
                <SliderWithState
                    value={NFTState.assetBidAmount}
                    onChange={onBidChange}
                    min={0}
                    max={Number(stargazeMBRNBalance + osmosisMBRNBalance)}
                />
                <TxButton
                    w="150px"
                    px="10"
                    isDisabled={!isGreaterThanZero(NFTState.nftBidAmount) || bid?.simulate.isError || !bid?.simulate.data}
                    isLoading={bid.simulate.isPending && !bid.simulate.isError && bid.simulate.data}
                    onClick={() => bid.tx.mutate()}
                    >
                    Bid
                </TxButton>
            </Stack>
        </Card>
    )
}

export default AssetAuction