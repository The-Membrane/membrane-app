import { Card, Image } from "@chakra-ui/react"
import { MediaRenderer } from "@thirdweb-dev/react"
import useIPFS from "./hooks/useLiveNFTAuction";


const LiveAuction = () => {
    // useIPFS()
    return (
        <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
            <MediaRenderer
                src="ipfs://QmV4HC9fNrPJQeYpbW55NLLuSBMyzE11zS1L4HmL6Lbk7X"
                alt="Current Auctioned NFT Image"
            // width="80%"
            // height="80%"
            />
        </Card>
    )
}

export default LiveAuction