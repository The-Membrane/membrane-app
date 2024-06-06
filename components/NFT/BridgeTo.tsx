import { Text, Stack } from "@chakra-ui/react"
import useIBC from "./hooks/useIBC"
import QuickActionWidget from "../Home/QuickActionWidget"

const BridgeTo = () => {
    const ibc = useIBC()

    // const mbrn = useAssetBySymbol('MBRN')
    // const osmosisMBRNBalance = useBalanceByAsset(mbrn)

    // const cdt = useAssetBySymbol('CDT')
    // const osmosisCDTBalance = useBalanceByAsset(cdt, 'osmosis')
    
    // const onCDTChange = (value: number) => {
    //     setNFTState({ cdtBridgeAmount: value })
    // }
    // const onMBRNChange = (value: number) => {
    //     setNFTState({ mbrnBridgeAmount: value })
    // }

    return (
        <Stack w="full" gap="5">
            <Text variant="title">Bridge</Text>
            <QuickActionWidget action={ibc} actionMenuOptions={[{ value: "Bridge to Stargaze", label: "Bridge to Stargaze" }, { value: "Bridge to Osmosis", label: "Bridge to Osmosis"}]} bridgeCardToggle={true}/>
        </Stack>
    )
}

export default BridgeTo