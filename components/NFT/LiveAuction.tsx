import { Card, HStack, Image, Stack, Text } from "@chakra-ui/react"
import { SliderWithState } from "../Mint/SliderWithState";
import useNFTState from "../NFT/hooks/useNFTState";
import { useAssetBySymbol } from "@/hooks/useAssets";
import { useBalanceByAsset } from "@/hooks/useBalance";
import { TxButton } from "../TxButton";
import { isGreaterThanZero } from "@/helpers/num";

//ipfs://bafybeibyujxdq5bzf7m5fadbn3vysh3b32fvontswmxqj6rxj5o6mi3wvy/0.png
//ipfs://bafybeid2chlkhoknrlwjycpzkiipqypo3x4awnuttdx6sex3kisr3rgfsm


//I have to remove anything before the hash (find // and remove starting infront) & then add "https://ipfs-gw.stargaze-apis.com/ipfs/" to the link
const LiveAuction = () => {
    const { NFTState, setNFTState } = useNFTState()
    // const { bid } = useLiveNFTBid()
    const cdt = useAssetBySymbol('CDT')
    const cdtBalance = useBalanceByAsset(cdt)
    // const osmosisCDTBalance = useIBCBalanceByAsset('osmosis', cdt)

    const onBidChange = (value: number) => {
        setNFTState({ nftBidAmount: value })
    }
    
    return (
        <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
            <Image
                // src="https://ipfs-gw.stargaze-apis.com/ipfs/bafybeib4p32yqheuhnounizgizaho66g2ypk6gocg7xzxais5tuyz42gym/1.png"
                src="https://ipfs-gw.stargaze-apis.com/ipfs/bafybeid2chlkhoknrlwjycpzkiipqypo3x4awnuttdx6sex3kisr3rgfsm"
                alt="Current Auctioned NFT Image"
            // width="80%"
            // height="80%"
            />
            <Stack w="full" gap="1">
            <HStack justifyContent="space-between">
                <Text fontSize="16px" fontWeight="700">
                CDT
                </Text>
                <Text fontSize="16px" fontWeight="700">
                {NFTState.nftBidAmount}
                </Text>
            </HStack>
            <HStack justifyContent="space-between">
                <SliderWithState
                    value={NFTState.nftBidAmount}
                    onChange={onBidChange}
                    min={0}
                    max={Number(cdtBalance + osmosisCDTBalance)}
                />
                <TxButton
                    w="150px"
                    px="10"
                    isDisabled={!isGreaterThanZero(NFTState.nftBidAmount)}
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

export default LiveAuction