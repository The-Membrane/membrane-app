import { Card, Image } from "@chakra-ui/react"
import { MediaRenderer } from "@thirdweb-dev/react"
import useIPFS from "./hooks/useLiveNFTAuction";

//ipfs://bafybeibyujxdq5bzf7m5fadbn3vysh3b32fvontswmxqj6rxj5o6mi3wvy/0.png
//ipfs://bafybeid2chlkhoknrlwjycpzkiipqypo3x4awnuttdx6sex3kisr3rgfsm
const LiveAuction = () => {
    // useIPFS()
    return (
        <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
            <Image
                // src="https://ipfs-gw.stargaze-apis.com/ipfs/bafybeib4p32yqheuhnounizgizaho66g2ypk6gocg7xzxais5tuyz42gym/1.png"
                src="https://ipfs-gw.stargaze-apis.com/ipfs/bafybeid2chlkhoknrlwjycpzkiipqypo3x4awnuttdx6sex3kisr3rgfsm"
                alt="Current Auctioned NFT Image"
            // width="80%"
            // height="80%"
            />
        </Card>
    )
}

export default LiveAuction