import contracts from '@/config/contracts.json'
import { VestingQueryClient, VestingClient } from '@/contracts/codegen/vesting/Vesting.client'
import { Addr } from '@/contracts/generated/positions/Positions.types'
import getCosmWasmClient from '@/helpers/comswasmClient'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'

export const vestingClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new VestingQueryClient(cosmWasmClient, contracts.vesting)
}

export const getSigningVestingClient = (signingClient: SigningCosmWasmClient, address: Addr) => {
  return new VestingClient(signingClient, address, contracts.vesting)
}

export const getAllocation = async (address: Addr) => {
  const client = await vestingClient()
  return client.recipient({
    recipient: address,
  })
}

export const getUnlocked = async (address: Addr) => {
  const client = await vestingClient()
  return client.unlockedTokens({
    recipient: address,
  })
}
