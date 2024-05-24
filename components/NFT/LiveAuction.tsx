import { Card, HStack, Image, Stack, Text } from "@chakra-ui/react"
import { SliderWithState } from "../Mint/SliderWithState";
import useNFTState from "../NFT/hooks/useNFTState";
import { useAssetBySymbol } from "@/hooks/useAssets";
import { useBalanceByAsset } from "@/hooks/useBalance";
import { TxButton } from "../TxButton";
import { isGreaterThanZero } from "@/helpers/num";
import useLiveNFTBid from "./hooks/useLiveNFTBid";
import { useLiveNFTAuction } from "./hooks/useBraneAuction";

//ipfs://bafybeibyujxdq5bzf7m5fadbn3vysh3b32fvontswmxqj6rxj5o6mi3wvy/0.png
//ipfs://bafybeid2chlkhoknrlwjycpzkiipqypo3x4awnuttdx6sex3kisr3rgfsm
//ipfs://bafkreiglpln4i7lm5lbh4b6tqo5auvmh7iboleqnadzynfdokmizvlzvu4

function removeSegmentAndBefore(input: string, segment: string): string {
  // Find the position of the segment in the input string
  const segmentIndex = input.indexOf(segment);

  // If the segment is not found, return the original string
  if (segmentIndex === -1) {
    return input;
  }

  // Calculate the position right after the segment
  const afterSegmentIndex = segmentIndex + segment.length;

  // Return the part of the string starting after the segment
  return input.substring(afterSegmentIndex);
}

//todo: 
{/* Curation pagination in v2*/}

const LiveAuction = () => {
    const { data: liveNFTAuction } = useLiveNFTAuction()  
    const currentNFTIPFS = liveNFTAuction?.submission_info.submission.token_uri??"ipfs://bafybeidx45olni2oa4lq53s77vvvuuzsaalo3tlfsw7lsysvvpjl3ancfm/brane_wave.png"
    
    const { NFTState, setNFTState } = useNFTState()
    const cdt = useAssetBySymbol('CDT')
    const bid = useLiveNFTBid()
    //Comment this until we add MBRN & CDT to SG registry
    //Then change the useBalanceByAsset to use the correct Asset
    // const stargazeCDT = useAssetBySymbol('CDT', 'stargaze')
    const stargazeCDTBalance = useBalanceByAsset(cdt, 'stargaze')
    const osmosisCDTBalance = useBalanceByAsset(cdt, 'osmosis')

    //Remove ipfs portion of link
    const ipfsString = removeSegmentAndBefore(currentNFTIPFS, "ipfs://")

    const onBidChange = (value: number) => {
        setNFTState({ nftBidAmount: value })
    }
    
    return (
        <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
            {/* Need to add pagination for submissions so we can curate */}
            <Image
                // src="https://ipfs-gw.stargaze-apis.com/ipfs/bafybeib4p32yqheuhnounizgizaho66g2ypk6gocg7xzxais5tuyz42gym/1.png"
                src={"https://ipfs-gw.stargaze-apis.com/ipfs/" + ipfsString}
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
            <SliderWithState
                value={NFTState.nftBidAmount}
                onChange={onBidChange}
                min={0}
                max={Number(stargazeCDTBalance + osmosisCDTBalance)}
            />
            <div>
            <TxButton
                w="150px"
                px="10"
                isDisabled={!isGreaterThanZero(NFTState.nftBidAmount) || bid?.simulate.isError || !bid?.simulate.data}
                isLoading={bid.simulate.isPending && !bid.simulate.isError && bid.simulate.data}
                onClick={() => bid.tx.mutate()}
                >
                Bid
            </TxButton>
            </div>
            </Stack>
        </Card>
    )
}

export default LiveAuction