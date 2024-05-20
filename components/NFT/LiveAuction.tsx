import { Card, HStack, Image, Stack, Text } from "@chakra-ui/react"
import { SliderWithState } from "../Mint/SliderWithState";
import useNFTState from "../NFT/hooks/useNFTState";
import { useAssetBySymbol } from "@/hooks/useAssets";
import { useBalanceByAsset } from "@/hooks/useBalance";

//ipfs://bafybeibyujxdq5bzf7m5fadbn3vysh3b32fvontswmxqj6rxj5o6mi3wvy/0.png
//ipfs://bafybeid2chlkhoknrlwjycpzkiipqypo3x4awnuttdx6sex3kisr3rgfsm


//I have to remove anything before the hash (find // and remove starting infront) & then add "https://ipfs-gw.stargaze-apis.com/ipfs/" to the link
const LiveAuction = () => {
    const { NFTState, setNFTState } = useNFTState()
    const cdt = useAssetBySymbol('CDT')
    const cdtBalance = useBalanceByAsset(cdt)

    const onBidChange = (value: number) => {
        setNFTState({ bidAmount: value })
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
                {NFTState.bidAmount}
                </Text>
            </HStack>
            <SliderWithState
                value={NFTState.bidAmount}
                onChange={onBidChange}
                min={0}
                max={Number(cdtBalance)}
            />
            </Stack>
        </Card>
    )
}

export default LiveAuction