import contracts from '@/config/contracts.json'
import { Addr } from '@/contracts/generated/positions/Positions.types'
import getCosmWasmClient from '@/helpers/comswasmClient'
import { StakingClient, StakingQueryClient } from '@/contracts/generated/staking/Staking.client'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import { coin } from '@cosmjs/amino'

export const stakingClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new StakingQueryClient(cosmWasmClient, contracts.staking)
}

export const getSigningStakingClient = (signingClient: SigningCosmWasmClient, address: Addr) => {
  return new StakingClient(signingClient, address, contracts.staking)
}

export type StakingParams = {
  signingClient: SigningCosmWasmClient
  address: Addr
  denom: string
  amount: string
}

export const stake = async ({ signingClient, address, denom, amount }: StakingParams) => {
  const client = getSigningStakingClient(signingClient, address)
  const funds = [coin(amount, denom)]

  return client.stake({}, 'auto', undefined, funds)
}

export const getStaked = async (address: Addr) => {
  const client = await stakingClient()
  return client.userStake({
    staker: address,
  })
}
export const getRewards = async (address: Addr) => {
  const client = await stakingClient()
  return client.userRewards({
    user: address,
  })
}
