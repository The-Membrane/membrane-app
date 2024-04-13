import contracts from '@/config/contracts.json'
import { Addr } from '@/contracts/codegen/positions/Positions.types'
import {
  StabilityPoolClient,
  StabilityPoolQueryClient,
} from '@/contracts/codegen/stability_pool/StabilityPool.client'
import getCosmWasmClient from '@/helpers/comswasmClient'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'

export const stabiityPoolClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new StabilityPoolQueryClient(cosmWasmClient, contracts.stabilityPool)
}

export const getSigningStabiityPoolClient = (
  signingClient: SigningCosmWasmClient,
  address: Addr,
) => {
  return new StabilityPoolClient(signingClient, address, contracts.stabilityPool)
}

export const getAssetPool = async (address: Addr) => {
  const stabilityPool = await stabiityPoolClient()
  return stabilityPool.assetPool({ user: address })
}
export const getCapitalAheadOfDeposit = async (address: Addr) => {
  const stabilityPool = await stabiityPoolClient()
  return stabilityPool
    .capitalAheadOfDeposit({ user: address })
    .then((res) => {
      return res?.capital_ahead
    })
    .catch(() => {
      return '0'
    })
}
