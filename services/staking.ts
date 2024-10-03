import contracts from '@/config/contracts.json'
import { Addr } from '@/contracts/generated/positions/Positions.types'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'
import { StakingClient, StakingQueryClient } from '@/contracts/generated/staking/Staking.client'
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import { coin } from '@cosmjs/amino'
import { LiqAsset } from '@/contracts/codegen/staking/Staking.types'
import { getAssetByDenom, getAssetBySymbol } from '@/helpers/chain'
import delegates from '@/config/delegates.json'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { StakingMsgComposer } from '@/contracts/codegen/staking/Staking.message-composer'

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

export const getConfig = async () => {
  const client = await stakingClient()
  return client.config()
}

export const getStaked = async (address: Addr) => {
  const client = await stakingClient()
  const response = await client.userStake({
    staker: address,
  })

  const staking = response?.deposit_list?.filter((s) => !s.unstake_start_time)
  const unstaking = response?.deposit_list?.filter((s) => s.unstake_start_time)

  const staked = staking?.reduce((acc, s) => {
    return acc.plus(s.amount)
  }, num(0))

  console.log("unstaking in fn", unstaking)
  return {
    staked: staked.toNumber(),
    unstaking,
  }
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
export const getRewards = async (address: Addr) => {
  const client = await stakingClient()
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

export const getUserDelegations = async (address: Addr) => {
  // 'osmo1d9ryqp7yfmr92vkk2yal96824pewf2g5wx0h2r'
  const client = await stakingClient()
  const config = await getConfig()
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

export const getDelegatorInfo = async (address: Addr) => {
  const client = await stakingClient()
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
