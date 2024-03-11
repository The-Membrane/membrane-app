import { MsgExecuteContractEncodeObject } from "@cosmjs/cosmwasm-stargate"
import useWallet from "../useWallet"
import { useQuery } from "@tanstack/react-query"
import { joinGAMMPools, exitGAMMPools, joinCLPools, exitCLPools, lockGAMMPool, unlockGAMMPool } from "@/helpers/osmosis"
import useSimulateAndBroadcast from "../useSimulateAndBroadcast"
import useLPState from "./useLPState"
import { EncodeObject, coin } from "@cosmjs/proto-signing"

const useLP = () => {
    const { LPState } = useLPState()
    const { address } = useWallet()

    // Build msgs using the state
    const { data: msgs } = useQuery<MsgExecuteContractEncodeObject[] | undefined>({
        queryKey: [
            'swap',
            address,
            LPState.pool ?? undefined,
            LPState.join,
        ],
        queryFn: () => {
            //return if no address or no pool
            if (!address || !LPState.pool) return

            var msgs = [] as EncodeObject[]

            //LP into GAMM
            if ('shareInAmount' in LPState.pool!) {
                //Build GAMM LP msgs
                if (LPState.join) {
                    msgs = msgs.concat(joinGAMMPools(LPState.pool!.token1, parseInt(LPState.pool!.id), LPState.pool!.token2))
                } //Exit GAMM LP
                else {
                    msgs = msgs.concat(exitGAMMPools(parseInt(LPState.pool!.id), LPState.pool!.shareInAmount ?? '0'))
                }
                //Lock GAMM LP
                if (LPState.pool!.lock !== undefined) {
                    msgs = msgs.concat(lockGAMMPool(coin(LPState.pool!.shareInAmount ?? '0', "gamm/pool/" + LPState.pool!.id)))
                } else
                    //Unlock GAMM LP
                    if (LPState.pool!.unlock !== undefined) {
                        msgs = msgs.concat(unlockGAMMPool(LPState.pool!.id, coin(LPState.pool!.shareInAmount ?? '0', "gamm/pool/" + LPState.pool!.id)))
                    }
            } //LP into CL
            else if (LPState.pool!.token2 !== undefined) {
                //Build CL LP msgs
                if (LPState.join) {
                    msgs = msgs.concat(joinCLPools(LPState.pool!.token1, parseInt(LPState.pool!.id), LPState.pool!.token2))
                } //Exit CL LP
                else {
                    msgs = msgs.concat(exitCLPools(parseInt(LPState.pool!.id)))
                }

            }

            return msgs as MsgExecuteContractEncodeObject[]
        },
        enabled: !!address && !!LPState.pool,
    })

    return useSimulateAndBroadcast({
        msgs,
        queryKey: [
            LPState.pool?.id ?? '0',
            String(LPState.join),
            LPState.pool?.token1.amount ?? '',
            LPState.pool?.token2?.amount ?? '',
        ],
        amount: '1', //hardcoded for now
    })
}


export default useLP