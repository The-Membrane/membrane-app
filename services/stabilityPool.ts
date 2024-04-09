import contracts from '@/config/contracts.json'
import { PositionsQueryClient } from '@/contracts/codegen/positions/Positions.client'
import {
  Addr,
  Basket,
  BasketPositionsResponse,
  CollateralInterestResponse,
} from '@/contracts/codegen/positions/Positions.types'
import { Asset, getAssetByDenom, getChainAssets } from '@/helpers/chain'
import getCosmWasmClient from '@/helpers/comswasmClient'
import { shiftDigits } from '@/helpers/math'
import { Price } from './oracle'
import { num } from '@/helpers/num'
import {
  StabilityPoolClient,
  StabilityPoolQueryClient,
} from '@/contracts/codegen/stability_pool/StabilityPool.client'
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
