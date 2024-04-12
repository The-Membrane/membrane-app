import { Card, Image } from "@chakra-ui/react"
import useIPFS from "./hooks/useLiveNFTAuction";


const LiveAuction = () => {
    useIPFS()
    return (
        <Card w="full" p="8" alignItems="center" gap={5} h="full" justifyContent="space-between">
            <Image
                src="ipfs://bafybeid2chlkhoknrlwjycpzkiipqypo3x4awnuttdx6sex3kisr3rgfsm"
                alt="Current Auctioned NFT Image"
                w="80%"
                h="80%"
            />
        </Card>
    )
}

export default LiveAuction