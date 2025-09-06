import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { toUtf8 } from '@cosmjs/encoding'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'

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
  extension?: CarMetadata | null
  contractAddress?: string
  paymentOption?: TrainingPaymentOption | null
  onSuccess?: () => void
}

const useMintCar = (params: UseMintCarParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'mint_car_msgs_creation',
      address ?? null,
      appState.rpcUrl,
      params.extension?.name ?? null,
      params.paymentOption?.denom ?? null,
      params.paymentOption?.amount ?? null,
      params.contractAddress ?? (contracts as any).car ?? null,
    ],
    queryFn: () => {
      if (!address) return { msgs: [] }

      const msg = {
        create_car: {
          owner: address,
          token_uri: null,
          extension: params.extension ?? null,
        }
      }

      const funds = params.paymentOption
        ? [{ denom: params.paymentOption.denom, amount: params.paymentOption.amount }]
        : []

      const exec = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: (params.contractAddress ?? (contracts as any).car) as string,
          msg: toUtf8(JSON.stringify(msg)),
          funds,
        }),
      } as MsgExecuteContractEncodeObject

      return { msgs: [exec] }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs ?? []

  console.log('mint car msgs', msgs)

  const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['neutron balances'] })
    queryClient.invalidateQueries({ queryKey: ['q-racing', 'owned_cars'] })
    // Call the custom onSuccess callback if provided
    params.onSuccess?.()
  }
  console.log('mint car msgs', msgs)
  // Build stable signature from relevant inputs so sim reruns when contents change
  const simulationSignature = [
    params.extension?.name ?? '',
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