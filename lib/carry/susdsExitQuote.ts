import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { isEoaTransactionOriginCode } from './holderOriginCode'

export const SUSDS_ROUTE_KEY = 'USDS → SUsds [USDS]'
export const SUSDS_VAULT = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd' as Address
export const USDS_ASSET = '0xdc035d45d973e3ec169d2276ddab16f1e407384f' as Address

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_SOURCE_AGE_MS = 60 * 60 * 1000
const MAX_CALL_GAS = 20_000_000n
const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewWithdraw(uint256) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const tokenAbi = parseAbi(['function decimals() view returns (uint8)'])

export type SusdsExitRequest = {
  routeKey: string
  destinationAddress: Address
  owner: Address
  assetsRaw: string
}
/** Internal scorer input; deliberately absent from SusdsExitRequest/API. */
export type SusdsHistoricalFinalizedBlock = {
  mode: 'internal_historical_finalized_block'
  blockNumber: bigint
  blockHash: `0x${string}`
}
export type SusdsExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getCode' | 'readContract' | 'call' | 'request'
>

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const isUint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n
export function resolveSusdsExitTarget(routeKey: string, destinationAddress: Address) {
  if (routeKey !== SUSDS_ROUTE_KEY || !same(destinationAddress, SUSDS_VAULT)) {
    throw new Error('susds_exit_target_unknown')
  }
  return { routeKey: SUSDS_ROUTE_KEY, vault: SUSDS_VAULT, asset: USDS_ASSET, decimals: 18 }
}

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
  if (
    /gas required exceeds allowance|out of gas|exceeds block gas|intrinsic gas|gas limit/.test(
      detail,
    )
  ) {
    return false
  }
  if (value.cause && value.cause !== error && !isEvmRevert(value.cause)) return false
  return (
    value.name === 'ContractFunctionRevertedError' ||
    /execution reverted|reverted with/.test(detail)
  )
}

/** Read-only direct USDS withdrawal check for one holder, amount, and finalized block. */
export async function readSusdsExitQuote(
  client: SusdsExitClient,
  request: SusdsExitRequest,
  now: number | (() => number) = () => Date.now(),
  historicalBlock?: SusdsHistoricalFinalizedBlock,
  capacityOptions?: { includeCapacityFacts: true },
) {
  if (
    !request ||
    typeof request.routeKey !== 'string' ||
    !ADDRESS.test(request.destinationAddress) ||
    !ADDRESS.test(request.owner) ||
    typeof request.assetsRaw !== 'string' ||
    !RAW_AMOUNT.test(request.assetsRaw)
  ) {
    throw new Error('susds_exit_request_invalid')
  }
  const amount = BigInt(request.assetsRaw)
  if (amount > MAX_UINT256) throw new Error('susds_exit_request_invalid')
  const target = resolveSusdsExitTarget(request.routeKey, request.destinationAddress)
  if ((await client.getChainId()) !== 1) throw new Error('susds_exit_chain_mismatch')

  const readNow = typeof now === 'function' ? now : () => now
  const startedAt = readNow()
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const finalizedMs = Number(finalized?.timestamp) * 1000
  if (
    typeof finalized?.number !== 'bigint' ||
    finalized.number < 0n ||
    !HASH.test(finalized.hash ?? '') ||
    !Number.isSafeInteger(finalizedMs) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt - finalizedMs < -120_000 ||
    startedAt - finalizedMs > MAX_SOURCE_AGE_MS
  )
    throw new Error('susds_exit_finalized_block_unavailable')
  if (
    historicalBlock &&
    (historicalBlock.mode !== 'internal_historical_finalized_block' ||
      typeof historicalBlock.blockNumber !== 'bigint' ||
      historicalBlock.blockNumber < 0n ||
      historicalBlock.blockNumber > finalized.number ||
      typeof historicalBlock.blockHash !== 'string' ||
      !HASH.test(historicalBlock.blockHash))
  )
    throw new Error('susds_exit_historical_block_invalid')
  const block = historicalBlock
    ? await client.getBlock({ blockNumber: historicalBlock.blockNumber })
    : finalized
  if (
    historicalBlock &&
    (block?.number !== historicalBlock.blockNumber ||
      !block?.hash ||
      !same(block.hash, historicalBlock.blockHash) ||
      typeof block?.timestamp !== 'bigint' ||
      block.timestamp > finalized.timestamp)
  )
    throw new Error('susds_exit_block_hash_changed')
  const blockNumber = block?.number
  const blockHash = block?.hash
  const blockMs = Number(block?.timestamp) * 1000
  if (
    typeof blockNumber !== 'bigint' ||
    blockNumber < 0n ||
    blockNumber > BigInt(Number.MAX_SAFE_INTEGER) ||
    !HASH.test(blockHash ?? '') ||
    !Number.isSafeInteger(blockMs) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt - blockMs < -120_000 ||
    (!historicalBlock && startedAt - blockMs > MAX_SOURCE_AGE_MS)
  ) {
    throw new Error('susds_exit_finalized_block_unavailable')
  }
  const pinnedHash = blockHash as `0x${string}`
  const confirmBlock = async () => {
    const header = await client.getBlock({ blockNumber })
    if (
      header?.number !== blockNumber ||
      header.timestamp !== block.timestamp ||
      !header.hash ||
      !same(header.hash, pinnedHash)
    ) {
      throw new Error('susds_exit_block_hash_changed')
    }
  }
  await confirmBlock()

  const pinned = { blockHash: pinnedHash, requireCanonical: true as const }
  const [vaultCode, holderCode] = await Promise.all([
    client.getCode({ address: target.vault, ...pinned }),
    client.request({ method: 'eth_getCode', params: [request.owner, pinned] }),
  ])
  if (!vaultCode || vaultCode === '0x') throw new Error('susds_exit_vault_unavailable')
  if (!isEoaTransactionOriginCode(holderCode)) {
    throw new Error('susds_exit_contract_holder_unavailable')
  }

  const [liveAsset, assetDecimals, vaultDecimals, balanceShares, maxWithdrawAssets, previewShares] =
    await Promise.all([
      client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'asset',
        ...pinned,
      }),
      client.readContract({
        address: target.asset,
        abi: tokenAbi,
        functionName: 'decimals',
        ...pinned,
      }),
      client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'decimals',
        ...pinned,
      }),
      client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [request.owner],
        ...pinned,
      }),
      client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'maxWithdraw',
        args: [request.owner],
        ...pinned,
      }),
      client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'previewWithdraw',
        args: [amount],
        ...pinned,
      }),
    ])
  if (
    typeof liveAsset !== 'string' ||
    !same(liveAsset, target.asset) ||
    Number(assetDecimals) !== target.decimals ||
    Number(vaultDecimals) !== target.decimals ||
    !isUint(balanceShares) ||
    !isUint(maxWithdrawAssets) ||
    !isUint(previewShares) ||
    previewShares === 0n
  ) {
    throw new Error('susds_exit_identity_or_position_invalid')
  }

  let entitlementAssetsRaw: string | null = null
  if (capacityOptions?.includeCapacityFacts === true) {
    try {
      const entitlement = await client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'previewRedeem',
        args: [balanceShares],
        ...pinned,
      })
      if (isUint(entitlement)) entitlementAssetsRaw = entitlement.toString()
    } catch {
      /* Optional capacity quote does not invalidate the independent withdrawal assay. */
    }
  }
  let simulation:
    | { status: 'success'; sharesBurnedRaw: string }
    | { status: 'evm_revert'; reason: string }
  try {
    const data = encodeFunctionData({
      abi: vaultAbi,
      functionName: 'withdraw',
      args: [amount, request.owner, request.owner],
    })
    const result = await client.call({
      account: request.owner,
      to: target.vault,
      data,
      gas: MAX_CALL_GAS,
      ...pinned,
    })
    if (!result.data) throw new Error('susds_exit_result_invalid')
    const burned = decodeFunctionResult({
      abi: vaultAbi,
      functionName: 'withdraw',
      data: result.data,
    })
    if (typeof burned !== 'bigint' || burned <= 0n || burned > balanceShares) {
      throw new Error('susds_exit_result_invalid')
    }
    simulation = { status: 'success', sharesBurnedRaw: burned.toString() }
  } catch (error) {
    if (!isEvmRevert(error)) throw error
    simulation = { status: 'evm_revert', reason: 'unknown_execution_constraint' }
  }

  await confirmBlock()
  const completedAt = readNow()
  if (
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt ||
    completedAt - blockMs < -120_000 ||
    (!historicalBlock && completedAt - blockMs > MAX_SOURCE_AGE_MS)
  ) {
    throw new Error('susds_exit_finalized_block_unavailable')
  }

  const enoughShares = balanceShares >= previewShares
  return {
    status: 'checked_at_finalized_block' as const,
    source: {
      chainId: 1 as const,
      blockNumber: Number(blockNumber),
      blockHash: pinnedHash,
      blockTime: new Date(blockMs).toISOString(),
      observedAt: new Date(completedAt).toISOString(),
      ageSeconds: Math.max(0, Math.floor((completedAt - blockMs) / 1000)),
      method: 'eth_call_withdraw_at_finalized_block' as const,
    },
    routeKey: target.routeKey,
    vault: {
      address: target.vault,
      assetAddress: target.asset,
      assetDecimals: target.decimals,
      identity: 'pinned_vault_and_live_asset' as const,
    },
    position: {
      ...(capacityOptions?.includeCapacityFacts === true ? { entitlementAssetsRaw } : {}),
      balanceSharesRaw: balanceShares.toString(),
      maxWithdrawAssetsRaw: maxWithdrawAssets.toString(),
      previewSharesRaw: previewShares.toString(),
    },
    request: { assetsRaw: amount.toString(), assets: formatUnits(amount, target.decimals) },
    simulation:
      !enoughShares && simulation.status !== 'success'
        ? {
            status: 'position_insufficient' as const,
            reason: 'requested_amount_exceeds_holder_shares' as const,
          }
        : simulation,
    forecast: {
      futureExit: 'unavailable' as const,
      exitDuration: 'unavailable' as const,
      prospectiveValidated: false as const,
    },
    caveat:
      'Read-only same-holder direct USDS withdrawal check at one finalized block. Wallet gas funding and state at transaction time are unassessed. This does not check a USDS-to-USDC conversion or future exit.',
  }
}
