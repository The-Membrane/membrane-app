import { MsgExecuteContractEncodeObject } from "@cosmjs/cosmwasm-stargate"
import useWallet from "../useWallet"
import useSwapState from "./useSwapState"
import { useQuery } from "@tanstack/react-query"
import { handleCDTswaps, handleCollateralswaps } from "@/helpers/osmosis"
import useSimulateAndBroadcast from "../useSimulateAndBroadcast"

const useSwap = () => {
    const { swapState } = useSwapState()
    const { address } = useWallet()

    // Build msgs using the state
    const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
        queryKey: [
            'swap',
            address,
            swapState.nonCDTasset,
            swapState.tokenInAmount,
            swapState.toCDT,
        ],
        queryFn: () => {
            //return if no address or 0 tokenInAmount
            if (!address || swapState.tokenInAmount === 0) return

            //Swap nonCDTasset to CDT
            if (swapState.toCDT) {
                //Build swap msgs
                let msg = handleCDTswaps(swapState.nonCDTasset, swapState.tokenInAmount)
                return [msg] as MsgExecuteContractEncodeObject[]
            } //Swap CDT to nonCDTasset
            else {
                //Build swap msgs
                let msg = handleCollateralswaps(swapState.nonCDTasset, swapState.tokenInAmount)
                return [msg] as MsgExecuteContractEncodeObject[]
            }
        },
        enabled: !!address,
    })

    return useSimulateAndBroadcast({
        msgs,
        queryKey: [
            swapState.nonCDTasset,
            String(swapState.tokenInAmount),
            String(swapState.toCDT),
        ],
        amount: '1', //hardcoded for now
    })
}


export default useSwap