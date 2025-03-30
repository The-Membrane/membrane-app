import contracts from '@/config/contracts.json'
import { Addr } from '@/contracts/generated/positions/Positions.types'
import { getCosmWasmClient, useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { StakingClient, StakingQueryClient } from '@/contracts/generated/staking/Staking.client'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import { coin } from '@cosmjs/amino'
import { LiqAsset } from '@/contracts/codegen/staking/Staking.types'
import { getAssetByDenom, getAssetBySymbol } from '@/helpers/chain'
import delegates from '@/config/delegates.json'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'
import { useQuery } from '@tanstack/react-query'

export const useStakingClient = () => {
  const { data: cosmWasmClient } = useCosmWasmClient()

  return useQuery({
    queryKey: ['staking_client', cosmWasmClient],
    queryFn: async () => {
      if (!cosmWasmClient) return null
      return new StakingQueryClient(cosmWasmClient, contracts.staking)
    },
    // enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}

export const stakingClient = async (rpcUrl: string) => {
  console.log("staking CW client")
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
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

export const getConfig = async (client: any) => {
  return client.config()
}

export const getStaked = async (address: Addr, client: any) => {
  return client.userStake({
    staker: address,
  })
}

const parseClaimable = (claimable: LiqAsset[]) => {
  return claimable?.map((c) => {
    const denom = c.info.native_token?.denom
    const asset = getAssetByDenom(denom)
    return {
      amount: c.amount,
      asset,
    }
  })
}
export const getRewards = async (address: Addr, client: any) => {
  let rewards;
  try {
    rewards = await client.userRewards({
      user: address,
    });
  } catch (error) {
    console.error("Error fetching user rewards:", error);
    rewards = { claimables: [], accrued_interest: '0' };
  }
  const mbrn = getAssetBySymbol('MBRN')
  const claimable = parseClaimable(rewards.claimables)
  return [
    {
      amount: rewards.accrued_interest,
      asset: mbrn,
    },
    ...claimable,
  ]
}

export const getUserDelegations = async (address: Addr, client: any) => {
  // 'osmo1d9ryqp7yfmr92vkk2yal96824pewf2g5wx0h2r'
  const config = await getConfig(client)
  try {
    const [userDelegation, ...other] = await client.delegations({
      user: address,
    })
    const { delegation_info } = userDelegation

    const delegations = delegates
      .map((delegator) => {
        const delegation = delegation_info?.delegated_to?.find(
          (d) => d.delegate === delegator.address,
        )
        const amount = shiftDigits(delegation?.amount || '0', -6)
          .dp(0)
          .toString()
        const commission = delegation_info?.commission
        return {
          ...delegator,
          ...delegation,
          commission,
          maxCommission: config.max_commission_rate,
          amount,
        }
      })
      .sort((a, b) => Number(b.amount) - Number(a.amount))

    return delegations
  } catch (error) {
    return delegates.map((delegate) => {
      const amount = '0'
      return {
        ...delegate,
        amount,
      }
    })
  }
}

export const buildUpdateDelegationMsg = async (address: Addr, delegations: any[]) => {
  const messageComposer = new StakingMsgComposer(address, contracts.staking)
  const msgs = delegations.map((d) => {
    return messageComposer.updateDelegations({
      delegate: num(d.newAmount).isGreaterThan(0) ? true : false,
      fluid: d?.fluidity,
      governatorAddr: d?.address,
      mbrnAmount: shiftDigits(Math.abs(d.newAmount), 6).toString(),
      votingPowerDelegation: d?.voting_power_delegation,
      commission: d?.newCommission?.toString(),
    })
  })
  return msgs
}

export const getDelegatorInfo = async (address: Addr, client: any) => {
  const [userDelegation] = await client.delegations({
    user: address,
  })

  const { delegation_info } = userDelegation
  const commission = delegation_info?.commission || '0'
  const totalDelegation = delegation_info?.delegated?.reduce((acc, d) => {
    return acc.plus(d.amount)
  }, num(0))

  return {
    totalDelegation: shiftDigits(totalDelegation, -6).toString(),
    commission,
  }
}
