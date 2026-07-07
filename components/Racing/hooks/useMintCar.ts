import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import type { EvmCall } from '@/services/chain/types'

export interface CarAttribute {
  trait_type: string
  value: string
}

export interface CarMetadata {
  name: string
  image_uri?: string | null
  attributes?: CarAttribute[] | null
  car_id?: string | null
}

export type TrainingPaymentOption = {
  denom: string
  amount: string
}

export type UseMintCarParams = {
  owner?: string
  tokenUri?: string | null
  name?: string | null
  contractAddress?: string
  paymentOption?: TrainingPaymentOption | null
  onSuccess?: () => void
}

/**
 * TODO(evm-migration): the Racing mini-game car NFT contract has NO equivalent in
 * the Solidity port. This CTA hook returns no msgs so the "mint car" action stays
 * inert until/if racing contracts are ported. Return shape preserved for consumers.
 */
const useMintCar = (params: UseMintCarParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: [
      'mint_car_msgs_creation',
      address ?? null,
      appState.rpcUrl,
      params.name ?? null,
      params.paymentOption?.denom ?? null,
      params.paymentOption?.amount ?? null,
      params.contractAddress ?? (contracts as any).car ?? null,
    ],
    queryFn: () => [] as EvmCall[],
    enabled: !!address,
  })

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['neutron balances'] })
    queryClient.invalidateQueries({ queryKey: ['q-racing', 'owned_cars'] })
    // Call the custom onSuccess callback if provided
    params.onSuccess?.()
  }
  console.log('mint car msgs', msgs)
  // Build stable signature from relevant inputs so sim reruns when contents change
  const simulationSignature = [
    params.name ?? '',
    params.paymentOption?.denom ?? '',
    params.paymentOption?.amount ?? '',
    (params.contractAddress ?? (contracts as any).car ?? '').toString(),
  ].join('|')

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['mint_car_sim', simulationSignature],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
}

export default useMintCar