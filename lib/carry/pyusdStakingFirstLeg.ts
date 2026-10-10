import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { isEoaTransactionOriginCode } from './holderOriginCode'
import { HASTRA_STAKING_VAULT } from './pyusdStakingRouteIdentity'

const abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function maxRedeem(address) view returns (uint256)',
  'function paused() view returns (bool)',
  'function frozen(address) view returns (bool)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function redeem(uint256,address,address) returns (uint256)',
])

type Client = Pick<PublicClient, 'request' | 'readContract' | 'call'>

function isEvmRevert(error: unknown): boolean {
  const value = error as {
    name?: unknown
    shortMessage?: unknown
    message?: unknown
    details?: unknown
    cause?: unknown
  } | null
  if (!value || typeof value !== 'object') return false
  const detail = [value.shortMessage, value.message, value.details]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .toLowerCase()
  if (/out of gas|gas required exceeds allowance|gas limit|intrinsic gas/.test(detail)) return false
  if (value.cause && value.cause !== error && !isEvmRevert(value.cause)) return false
  return (
    value.name === 'ContractFunctionRevertedError' ||
    /execution reverted|reverted with/.test(detail)
  )
}

/** One provider, one verified finalized block. The API compares two independent results. */
export async function readPyusdStakingFirstLeg(
  client: Client,
  holder: Address,
  qRaw: string,
  blockHash: `0x${string}`,
) {
  const q = BigInt(qRaw)
  const pinned = { blockHash, requireCanonical: true as const }
  const [code, shares, maxRedeem, paused, frozen] = await Promise.all([
    client.request({ method: 'eth_getCode', params: [holder, pinned] }),
    client.readContract({
      address: HASTRA_STAKING_VAULT,
      abi,
      functionName: 'balanceOf',
      args: [holder],
      ...pinned,
    }),
    client.readContract({
      address: HASTRA_STAKING_VAULT,
      abi,
      functionName: 'maxRedeem',
      args: [holder],
      ...pinned,
    }),
    client.readContract({ address: HASTRA_STAKING_VAULT, abi, functionName: 'paused', ...pinned }),
    client.readContract({
      address: HASTRA_STAKING_VAULT,
      abi,
      functionName: 'frozen',
      args: [holder],
      ...pinned,
    }),
  ])
  if (!isEoaTransactionOriginCode(code)) throw new Error('holder_exit_eoa_unverified')

  let previewWyldsRaw: string | null = null
  try {
    previewWyldsRaw = (
      await client.readContract({
        address: HASTRA_STAKING_VAULT,
        abi,
        functionName: 'previewRedeem',
        args: [q],
        ...pinned,
      })
    ).toString()
  } catch (error) {
    if (!isEvmRevert(error)) throw error
  }

  let simulatedWyldsRaw: string | null = null
  let reverted = false
  try {
    const simulation = await client.call({
      to: HASTRA_STAKING_VAULT,
      account: holder,
      data: encodeFunctionData({ abi, functionName: 'redeem', args: [q, holder, holder] }),
      ...pinned,
    })
    if (!simulation.data) throw new Error('pyusd_staking_simulation_empty')
    simulatedWyldsRaw = decodeFunctionResult({
      abi,
      functionName: 'redeem',
      data: simulation.data,
    }).toString()
  } catch (error) {
    if (!isEvmRevert(error)) throw error
    reverted = true
  }
  const reason:
    | 'insufficient_prime_shares'
    | 'staking_paused'
    | 'holder_frozen'
    | 'below_max_redeem'
    | 'redeem_reverted'
    | 'zero_wylds_out'
    | 'prime_to_wylds_callable' =
    shares < q
      ? 'insufficient_prime_shares'
      : paused
        ? 'staking_paused'
        : frozen
          ? 'holder_frozen'
          : maxRedeem < q
            ? 'below_max_redeem'
            : reverted
              ? 'redeem_reverted'
              : simulatedWyldsRaw === null || BigInt(simulatedWyldsRaw) === 0n
                ? 'zero_wylds_out'
                : 'prime_to_wylds_callable'
  return {
    requestedPrimeSharesRaw: qRaw,
    holderPrimeSharesRaw: shares.toString(),
    maxRedeemRaw: maxRedeem.toString(),
    previewWyldsRaw,
    simulatedWyldsRaw,
    stakingPaused: paused,
    holderFrozen: frozen,
    reason,
  }
}
