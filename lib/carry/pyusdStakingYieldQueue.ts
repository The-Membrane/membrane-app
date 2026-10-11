import { parseAbi, type Address, type PublicClient } from 'viem'

import { HASTRA_YIELD_VAULT } from './pyusdStakingRouteIdentity'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function pendingRedemptions(address) view returns (uint256 shares,uint256 assets,uint256 timestamp)',
  'function paused() view returns (bool)',
  'function frozen(address) view returns (bool)',
  'function redeemVault() view returns (address)',
])

export type PyusdStakingYieldQueue = {
  holder: Address
  existingWyldsSharesRaw: string
  pendingSharesRaw: string
  pendingUsdcRaw: string
  pendingSinceUnix: string
  yieldPaused: boolean
  yieldFrozen: boolean
  redeemVault: Address
  requestAssessed: false
  completion: 'admin_gated_unassessed'
  usdcPayout: 'not_attested'
}

/** Reads pre-existing holder state only; a separate PRIME simulation does not mutate this state. */
export async function readPyusdStakingYieldQueue(
  client: Pick<PublicClient, 'readContract'>,
  holder: Address,
  blockHash: `0x${string}`,
): Promise<PyusdStakingYieldQueue> {
  if (!ADDRESS.test(holder) || !HASH.test(blockHash))
    throw new Error('pyusd_staking_yield_queue_input_invalid')
  const pin = { blockHash, requireCanonical: true as const }
  const [shares, pending, yieldPaused, yieldFrozen, redeemVault] = await Promise.all([
    client.readContract({
      address: HASTRA_YIELD_VAULT,
      abi,
      functionName: 'balanceOf',
      args: [holder],
      ...pin,
    }),
    client.readContract({
      address: HASTRA_YIELD_VAULT,
      abi,
      functionName: 'pendingRedemptions',
      args: [holder],
      ...pin,
    }),
    client.readContract({ address: HASTRA_YIELD_VAULT, abi, functionName: 'paused', ...pin }),
    client.readContract({
      address: HASTRA_YIELD_VAULT,
      abi,
      functionName: 'frozen',
      args: [holder],
      ...pin,
    }),
    client.readContract({ address: HASTRA_YIELD_VAULT, abi, functionName: 'redeemVault', ...pin }),
  ])
  if (!ADDRESS.test(redeemVault)) throw new Error('pyusd_staking_yield_queue_vault_invalid')
  return {
    holder,
    existingWyldsSharesRaw: shares.toString(),
    pendingSharesRaw: pending[0].toString(),
    pendingUsdcRaw: pending[1].toString(),
    pendingSinceUnix: pending[2].toString(),
    yieldPaused,
    yieldFrozen,
    redeemVault,
    requestAssessed: false,
    completion: 'admin_gated_unassessed',
    usdcPayout: 'not_attested',
  }
}
