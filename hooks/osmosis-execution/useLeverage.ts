import { MsgExecuteContractEncodeObject } from "@cosmjs/cosmwasm-stargate"
import useWallet from "../useWallet"
import useLeverageState from "./useLeverageState"
import { useQuery } from "@tanstack/react-query"
import { loopPosition, unloopPosition } from "@/helpers/osmosis"
import useSimulateAndBroadcast from "../useSimulateAndBroadcast"

const useLeverage = () => {
    const { leverageState } = useLeverageState()
    const { address } = useWallet()

    // Build msgs using the state
    const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
        queryKey: [
            'swap',
            address,
            leverageState.LTV,
            leverageState.iterations,
            leverageState.positionID,
        ],
        queryFn: () => {
            //return if no address or 0 tokenInAmount
            if (!address) return

            //Loop Position
            if (leverageState.iterations === undefined) {
                //Build swap msgs
                let msg = loopPosition(leverageState.LTV, leverageState.positionID, 5)
                return msg as MsgExecuteContractEncodeObject[]
            } //Unloop Position
            else {
                //Build swap msgs
                let msg = unloopPosition(leverageState.positionID, leverageState.iterations)
                return msg as MsgExecuteContractEncodeObject[]
            }
        },
        enabled: !!address,
    })

    return useSimulateAndBroadcast({
        msgs,
        queryKey: [
            String(leverageState.LTV),
            String(leverageState.iterations),
            String(leverageState.positionID),
        ],
        amount: '1', //hardcoded for now
    })
}


export default useLeverage