import { Card, HStack, Text, Stack, Checkbox } from "@chakra-ui/react"
import { SliderWithState } from "../Mint/SliderWithState"
import { useAssetBySymbol } from "@/hooks/useAssets"
import { useBalanceByAsset } from "@/hooks/useBalance"
import useNFTState from "./hooks/useNFTState"
import { isGreaterThanZero } from "@/helpers/num"
import { TxButton } from "../TxButton"
import useIBC from "./hooks/useIBC"
import QuickActionWidget from "../Home/QuickActionWidget"
import useQuickActionState from "../Home/hooks/useQuickActionState"

const BridgeTo = () => {
    const { NFTState, setNFTState } = useNFTState()
    const { quickActionState } = useQuickActionState()
    const ibc = useIBC()

    const mbrn = useAssetBySymbol('MBRN')
    const osmosisMBRNBalance = useBalanceByAsset(mbrn)
    console.log(mbrn, osmosisMBRNBalance)
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
        <Text variant="title">Bridge</Text>
        <QuickActionWidget actionMenuOptions={[{ value: "Bridge to Stargaze", label: "Bridge to Stargaze" }, { value: "Bridge to Osmosis", label: "Bridge to Osmosis"}]} bridgeCardToggle={true}/>
        {/**/}
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
                    isDisabled={(!isGreaterThanZero(NFTState.mbrnBridgeAmount) && !isGreaterThanZero(NFTState.cdtBridgeAmount)) || ibc?.simulate.isError || !ibc?.simulate.data}
                    isLoading={ibc.simulate.isPending && !ibc.simulate.isError && ibc.simulate.data}
                    onClick={() => ibc.tx.mutate()}
                    chain_name={quickActionState.action.value === "Bridge to Stargaze" ? "stargaze" : "osmosis"}
                    >
                    {quickActionState.action.value}
                </TxButton>
            </Stack>
        </Card>
        </Stack>
    )
}

export default BridgeTo