import contracts from '@/config/contracts.json'
import { VestingQueryClient, VestingClient } from '@/contracts/codegen/vesting/Vesting.client'
import { Addr } from '@/contracts/generated/positions/Positions.types'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'

export const vestingClient = async (rpcUrl: string) => {
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  return new VestingQueryClient(cosmWasmClient, contracts.vesting)
}

export const getSigningVestingClient = (signingClient: SigningCosmWasmClient, address: Addr) => {
  return new VestingClient(signingClient, address, contracts.vesting)
}

export const getAllocation = async (address: Addr, rpcUrl: string) => {
  const client = await vestingClient(rpcUrl)
  return client.recipient({
    recipient: address,
  })
}

export const getUnlocked = async (address: Addr, rpcUrl: string) => {
  const client = await vestingClient(rpcUrl)
  return client.unlockedTokens({
    recipient: address,
  })
}
