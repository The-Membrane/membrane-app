import { Card, HStack, Text, Stack } from "@chakra-ui/react"
import { SliderWithState } from "../Mint/SliderWithState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { useBalanceByAsset } from "@/hooks/useBalance"
import useNFTState from "./hooks/useNFTState"
import { isGreaterThanZero } from "@/helpers/num"
import { TxButton } from "../TxButton"

const AssetAuction = () => {
    const { NFTState, setNFTState } = useNFTState()
    // const { bid } = useAssetAuctionBid()
    // const {auctionAmount, currentBid, timeLeft } = useAssetAuction()
    const mbrn = useAssetBySymbol('MBRN')
    const mbrnBalance = useBalanceByAsset(mbrn)
    // const osmosisMBRNBalance = useIBCBalanceByAsset('osmosis', mbrn)
    
    const onBidChange = (value: number) => {
        setNFTState({ assetBidAmount: value })
    }

    return (
        <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">            
            <Stack w="full" gap="1">
                <Text fontSize="16px" fontWeight="700">
                Auction for {auctionAmount} CDT
                </Text>
                <Text fontSize="16px" fontWeight="700">
                Current Bid: {currentBid} MBRN
                </Text>                
                <HStack justifyContent="space-between">
                    <Text fontSize="16px" fontWeight="700">
                    MBRN
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                    {NFTState.assetBidAmount}
                    </Text>
                </HStack>
                <HStack justifyContent="space-between">
                    <SliderWithState
                        value={NFTState.assetBidAmount}
                        onChange={onBidChange}
                        min={0}
                        max={Number(mbrnBalance + osmosisMBRNBalance)}
                    />
                    <TxButton
                        w="150px"
                        px="10"
                        isDisabled={!isGreaterThanZero(NFTState.assetBidAmount)}
                        isLoading={bid.isPending}
                        onClick={() => bid.mutate()}
                        >
                        Bid
                    </TxButton>
                </HStack>
            </Stack>
        </Card>
    )
}

export default AssetAuction