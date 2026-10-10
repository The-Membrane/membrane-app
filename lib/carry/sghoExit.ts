import type { DirectSupplyHistoricalFinalizedBlock } from './directSupplyExitQuote'
import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { isEoaTransactionOriginCode } from './holderOriginCode'

import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'

const VAULT = GHO_SGHO.destination as Address
const GHO = GHO_SGHO.borrowAsset as Address
const EXPECTED_DECIMALS = 18
const MAX_FINALIZED_AGE_MS = 2 * 60 * 60 * 1000
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_CALL_GAS = 20_000_000n

const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
  'function maxRedeem(address owner) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
  'function previewWithdraw(uint256 assets) view returns (uint256)',
  'function withdraw(uint256 assets,address receiver,address owner) returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function paused() view returns (bool)',
])
const ghoAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function balanceOf(address owner) view returns (uint256)',
])

const isUint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function isEvmRevert(error: unknown): boolean {
  const parts: string[] = []
  let current = error as {
    name?: string
    shortMessage?: string
    details?: string
    message?: string
    cause?: unknown
  } | null
  for (let i = 0; current && i < 5; i++) {
    parts.push(
      `${current.name ?? ''} ${current.shortMessage ?? ''} ${current.details ?? ''} ${current.message ?? ''}`,
    )
    current = current.cause as typeof current
  }
  const message = parts.join(' ').toLowerCase()
  if (/out of gas|gas limit|exceeds block gas|intrinsic gas/.test(message)) return false
  return /execution reverted|reverted with|contractfunctionrevertederror/.test(message)
}

/** One finalized block, one RPC host, no cached or inferred wallet values. */
export async function readSghoExit(
  client: Pick<
    PublicClient,
    'getChainId' | 'getBlock' | 'getCode' | 'readContract' | 'call' | 'request'
  >,
  owner: Address,
  assetsRaw: string,
  now: number | (() => number) = () => Date.now(),
  historicalBlock?: DirectSupplyHistoricalFinalizedBlock,
  options: { includeCapacityFacts?: boolean } = {},
) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error('sgho_owner_invalid')
  if (
    typeof assetsRaw !== 'string' ||
    !RAW_AMOUNT.test(assetsRaw) ||
    BigInt(assetsRaw) > MAX_UINT256
  )
    throw new Error('sgho_amount_invalid')
  const amount = BigInt(assetsRaw)
  if ((await client.getChainId()) !== GHO_SGHO.chainId) throw new Error('sgho_chain_mismatch')

  const readNow = typeof now === 'function' ? now : () => now
  const startedAt = readNow()
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const finalizedMs = Number(finalized?.timestamp) * 1000
  if (
    typeof finalized?.number !== 'bigint' ||
    finalized.number < 0n ||
    typeof finalized.hash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(finalized.hash) ||
    !Number.isSafeInteger(finalizedMs) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt - finalizedMs < -120_000 ||
    startedAt - finalizedMs > MAX_FINALIZED_AGE_MS
  )
    throw new Error('sgho_finalized_block_unavailable')
  if (
    historicalBlock &&
    (historicalBlock.mode !== 'internal_historical_finalized_block' ||
      typeof historicalBlock.blockNumber !== 'bigint' ||
      historicalBlock.blockNumber < 0n ||
      historicalBlock.blockNumber > finalized.number ||
      typeof historicalBlock.blockHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(historicalBlock.blockHash))
  )
    throw new Error('sgho_historical_block_invalid')
  const block = historicalBlock
    ? await client.getBlock({ blockNumber: historicalBlock.blockNumber })
    : finalized
  if (
    historicalBlock &&
    (block?.number !== historicalBlock.blockNumber ||
      typeof block.hash !== 'string' ||
      block.hash.toLowerCase() !== historicalBlock.blockHash.toLowerCase() ||
      typeof block.timestamp !== 'bigint' ||
      block.timestamp > finalized.timestamp)
  )
    throw new Error('sgho_block_hash_changed')
  const blockNumber = block?.number
  const blockHash = block?.hash
  const blockMs = Number(block?.timestamp) * 1000
  if (
    typeof blockNumber !== 'bigint' ||
    blockNumber < 0n ||
    blockNumber > BigInt(Number.MAX_SAFE_INTEGER) ||
    !/^0x[0-9a-fA-F]{64}$/.test(blockHash ?? '') ||
    !Number.isFinite(blockMs) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt - blockMs < -120_000 ||
    (!historicalBlock && startedAt - blockMs > MAX_FINALIZED_AGE_MS)
  ) {
    throw new Error('sgho_finalized_block_unavailable')
  }
  const before = await client.getBlock({ blockNumber })
  if (
    before?.number !== blockNumber ||
    before.timestamp !== block.timestamp ||
    before.hash?.toLowerCase() !== blockHash.toLowerCase()
  ) {
    throw new Error('sgho_block_hash_changed')
  }
  const pinned = { blockHash: blockHash as `0x${string}`, requireCanonical: true as const }
  const [vaultCode, ownerCode] = await Promise.all([
    client.getCode({ address: VAULT, ...pinned }),
    client.request({ method: 'eth_getCode', params: [owner, pinned] }),
  ])
  if (!vaultCode || vaultCode === '0x') throw new Error('sgho_vault_unavailable')
  if (!isEoaTransactionOriginCode(ownerCode)) throw new Error('sgho_contract_holder_unavailable')

  const [
    asset,
    shareDecimals,
    assetDecimals,
    shares,
    maxRedeem,
    maxWithdraw,
    totalAssets,
    cash,
    paused,
  ] = await Promise.all([
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'asset', ...pinned }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'decimals', ...pinned }),
    client.readContract({ address: GHO, abi: ghoAbi, functionName: 'decimals', ...pinned }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'balanceOf',
      args: [owner],
      ...pinned,
    }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'maxRedeem',
      args: [owner],
      ...pinned,
    }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'maxWithdraw',
      args: [owner],
      ...pinned,
    }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'totalAssets',
      ...pinned,
    }),
    client.readContract({
      address: GHO,
      abi: ghoAbi,
      functionName: 'balanceOf',
      args: [VAULT],
      ...pinned,
    }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'paused', ...pinned }),
  ])
  if (
    !sameAddress(asset, GHO) ||
    Number(shareDecimals) !== EXPECTED_DECIMALS ||
    Number(assetDecimals) !== EXPECTED_DECIMALS ||
    !isUint(shares) ||
    !isUint(maxRedeem) ||
    !isUint(maxWithdraw) ||
    !isUint(totalAssets) ||
    !isUint(cash) ||
    typeof paused !== 'boolean'
  ) {
    throw new Error('sgho_exit_read_invalid')
  }

  const redeemableShares = shares < maxRedeem ? shares : maxRedeem
  const [previewRedeem, previewWithdraw] = await Promise.all([
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'previewRedeem',
      args: [redeemableShares],
      ...pinned,
    }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'previewWithdraw',
      args: [amount],
      ...pinned,
    }),
  ])
  if (!isUint(previewRedeem) || !isUint(previewWithdraw) || previewWithdraw <= 0n)
    throw new Error('sgho_exit_preview_invalid')
  let fullPositionEntitlementGhoRaw: string | null = null
  if (options.includeCapacityFacts === true) {
    try {
      const full =
        shares === redeemableShares
          ? previewRedeem
          : await client.readContract({
              address: VAULT,
              abi: vaultAbi,
              functionName: 'previewRedeem',
              args: [shares],
              ...pinned,
            })
      if (isUint(full) && full <= MAX_UINT256 && full >= previewRedeem)
        fullPositionEntitlementGhoRaw = full.toString()
    } catch {
      /* Optional full-position evidence cannot invalidate the current exit reading. */
    }
  }
  // A preview does not enforce withdrawal limits. A contradictory or paused
  // vault must never produce a positive wallet-side availability estimate.
  const effectiveExit = paused ? 0n : maxWithdraw < previewRedeem ? maxWithdraw : previewRedeem
  let simulation:
    | { status: 'success'; sharesBurnedRaw: string }
    | { status: 'evm_revert'; reason: 'unknown_execution_constraint' }
  try {
    const data = encodeFunctionData({
      abi: vaultAbi,
      functionName: 'withdraw',
      args: [amount, owner, owner],
    })
    const result = await client.call({
      account: owner,
      to: VAULT,
      data,
      gas: MAX_CALL_GAS,
      ...pinned,
    })
    if (!result.data) throw new Error('sgho_exit_result_invalid')
    const burned = decodeFunctionResult({
      abi: vaultAbi,
      functionName: 'withdraw',
      data: result.data,
    })
    if (typeof burned !== 'bigint' || burned <= 0n || burned > shares)
      throw new Error('sgho_exit_result_invalid')
    simulation = { status: 'success', sharesBurnedRaw: burned.toString() }
  } catch (error) {
    if (!isEvmRevert(error)) throw error
    simulation = { status: 'evm_revert', reason: 'unknown_execution_constraint' }
  }
  const after = await client.getBlock({ blockNumber })
  if (
    after?.number !== blockNumber ||
    after.timestamp !== block.timestamp ||
    after.hash?.toLowerCase() !== blockHash.toLowerCase()
  ) {
    throw new Error('sgho_block_hash_changed')
  }
  const completedAt = readNow()
  if (
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt ||
    completedAt - blockMs < -120_000 ||
    (!historicalBlock && completedAt - blockMs > MAX_FINALIZED_AGE_MS)
  ) {
    throw new Error('sgho_finalized_block_unavailable')
  }

  return {
    status: 'ok' as const,
    source: {
      chainId: GHO_SGHO.chainId,
      blockNumber: Number(blockNumber),
      blockHash,
      blockTime: new Date(blockMs).toISOString(),
      observedAt: new Date(completedAt).toISOString(),
      ageSeconds: Math.max(0, Math.floor((completedAt - blockMs) / 1000)),
      method: 'eth_call_withdraw_at_finalized_block' as const,
    },
    vault: {
      address: VAULT,
      assetAddress: GHO,
      shareDecimals: EXPECTED_DECIMALS,
      assetDecimals: EXPECTED_DECIMALS,
      totalAssetsGhoRaw: totalAssets.toString(),
      vaultCashGhoRaw: cash.toString(),
      withdrawalsPaused: paused,
    },
    position: {
      sharesRaw: shares.toString(),
      sharesSgho: formatUnits(shares, EXPECTED_DECIMALS),
      maxRedeemSharesRaw: maxRedeem.toString(),
      maxRedeemSgho: formatUnits(maxRedeem, EXPECTED_DECIMALS),
      redeemableSharesRaw: redeemableShares.toString(),
      previewRedeemGhoRaw: previewRedeem.toString(),
      ...(options.includeCapacityFacts === true ? { fullPositionEntitlementGhoRaw } : {}),
      previewRedeemGho: formatUnits(previewRedeem, EXPECTED_DECIMALS),
      maxWithdrawGhoRaw: maxWithdraw.toString(),
      maxWithdrawGho: formatUnits(maxWithdraw, EXPECTED_DECIMALS),
      effectiveExitGhoRaw: effectiveExit.toString(),
      effectiveExitGho: formatUnits(effectiveExit, EXPECTED_DECIMALS),
      previewWithdrawSharesRaw: previewWithdraw.toString(),
    },
    request: { assetsRaw: amount.toString(), assetsGho: formatUnits(amount, EXPECTED_DECIMALS) },
    simulation:
      simulation.status === 'success'
        ? simulation
        : shares < previewWithdraw
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
      'Read-only same-holder withdrawal simulation at one finalized block. Wallet gas funding and transaction-time state are unassessed. This does not establish future exit ability or GHO→sGHO route attribution.',
  }
}
