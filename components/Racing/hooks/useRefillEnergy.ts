import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import type { EvmCall } from '@/services/chain/types'

export type TrainingPaymentOption = {
    denom: string
    amount: string
}

export type UseRefillEnergyParams = {
    tokenId?: string | null
    paymentOption?: TrainingPaymentOption | null
    contractAddress?: string
}

/**
 * TODO(evm-migration): the Racing mini-game car NFT / pay-for-training contract has
 * NO equivalent in the Solidity port. This CTA hook returns no msgs so the "refill
 * energy" action stays inert until/if racing contracts are ported. Return shape preserved.
 */
const useRefillEnergy = (params: UseRefillEnergyParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
        queryKey: [
            'refill_energy_msgs_creation',
            address ?? null,
            appState.rpcUrl,
            params.tokenId ?? null,
            params.paymentOption?.denom ?? null,
            params.paymentOption?.amount ?? null,
            params.contractAddress ?? (contracts as any).car ?? null,
        ],
        queryFn: () => [] as EvmCall[],
        enabled: !!address,
    })

    const onInitialSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['car_energy'] })
        queryClient.invalidateQueries({ queryKey: ['neutron balances'] })
    }
    console.log('energy msgs', msgs)
    // Stable signature based on tokenId, payment, and contract
    const simulationSignature = [
        params.tokenId ?? '',
        params.paymentOption?.denom ?? '',
        params.paymentOption?.amount ?? '',
        (params.contractAddress ?? (contracts as any).car ?? '').toString(),
    ].join('|')

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['refill_energy_sim', simulationSignature],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
        }),
    }
}

export default useRefillEnergy


