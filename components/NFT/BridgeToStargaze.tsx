import { Card, HStack, Text, Stack } from "@chakra-ui/react"
import { SliderWithState } from "../Mint/SliderWithState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { useBalanceByAsset } from "@/hooks/useBalance"
import useNFTState from "./hooks/useNFTState"
import { isGreaterThanZero } from "@/helpers/num"
import { TxButton } from "../TxButton"
import useIBCToStargaze from "./hooks/useIBCToStargaze"

const BridgeToStargaze = () => {
    const { NFTState, setNFTState } = useNFTState()
    const ibc = useIBCToStargaze()

    const mbrn = useAssetBySymbol('MBRN')
    const osmosisMBRNBalance = useBalanceByAsset(mbrn)    
    const cdt = useAssetBySymbol('CDT')
    const osmosisCDTBalance = useBalanceByAsset(cdt, 'osmosis')
    
    const onCDTChange = (value: number) => {
        setNFTState({ cdtBridgeAmount: value })
    }
    const onMBRNChange = (value: number) => {
        setNFTState({ mbrnBridgeAmount: value })
    }

    return (
        <Stack w="full" gap="5">
        <Text variant="title">Bridge From Osmosis To Stargaze</Text>
        <Card w="full" p="8" marginTop={"5.1%"} alignItems="center" gap={5} h="28%" justifyContent="space-between">            
            <Stack w="full" gap="1">
                <HStack justifyContent="space-between">
                    <Text fontSize="16px" fontWeight="700">
                    CDT
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                    {NFTState.cdtBridgeAmount}
                    </Text>
                </HStack>
                <SliderWithState
                    value={NFTState.cdtBridgeAmount}
                    onChange={onCDTChange}
                    min={0}
                    max={Number(osmosisCDTBalance)}
                />
                <HStack justifyContent="space-between">
                    <Text fontSize="16px" fontWeight="700">
                    MBRN
                    </Text>
                    <Text fontSize="16px" fontWeight="700">
                    {NFTState.mbrnBridgeAmount}
                    </Text>
                </HStack>
                <SliderWithState
                    value={NFTState.mbrnBridgeAmount}
                    onChange={onMBRNChange}
                    min={0}
                    max={Number(osmosisMBRNBalance)}
                />
                <TxButton
                    marginTop={"3%"}
                    w="100%"
                    px="10"
                    isDisabled={!isGreaterThanZero(NFTState.nftBidAmount) || ibc?.simulate.isError || !ibc?.simulate.data}
                    isLoading={ibc.simulate.isPending && !ibc.simulate.isError && ibc.simulate.data}
                    onClick={() => ibc.tx.mutate()}
                    >
                    Bridge to Stargaze
                </TxButton>
            </Stack>
        </Card>
        </Stack>
    )
}

export default BridgeToStargaze