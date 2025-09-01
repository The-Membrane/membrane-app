import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useMemo } from 'react'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { toUtf8 } from '@cosmjs/encoding'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { getOwnedCars } from '@/services/q-racing'

export interface CarAttribute {
  trait_type: string
  value: string
}

export interface CarMetadata {
  name: string
  description?: string | null
  image_uri?: string | null
  attributes?: CarAttribute[] | null
  car_id?: string | null
}

export type UseMintCarParams = {
  owner?: string
  tokenUri?: string | null
  extension?: CarMetadata | null
  contractAddress?: string
  paymentOption?: { denom: string; amount: string } | null
}

const useMintCar = (params: UseMintCarParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()

  const msgs: MsgExecuteContractEncodeObject[] = useMemo(() => {
    if (!address) return []
    const constructedMsgs: MsgExecuteContractEncodeObject[] = []
    const mintCarMsg = {
      typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
      value: MsgExecuteContract.fromPartial({
        sender: address,
        contract: params.contractAddress ?? contracts.car,
        msg: toUtf8(JSON.stringify({
          create_car: {
            owner: address,
            token_uri: null,
            extension: params.extension ?? null,
          }
        })),
        funds: params.paymentOption ? [{
          denom: params.paymentOption.denom,
          amount: params.paymentOption.amount
        }] : []
      })
    } as MsgExecuteContractEncodeObject
    constructedMsgs.push(mintCarMsg)
    return constructedMsgs
  }, [address, params.contractAddress, params.extension, params.paymentOption])

  const onInitialSuccess = async () => {
    queryClient.invalidateQueries({ queryKey: ['neutron balances'] })
    queryClient.invalidateQueries({ queryKey: ['q-racing', 'owned_cars'] })
  }

  // console.log("here to return action ")

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['mint_car_sim', address ?? '', appState.rpcUrl, params?.extension?.name ?? ''],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    })
  }
}

export default useMintCar