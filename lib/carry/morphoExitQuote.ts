import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { isEoaTransactionOriginCode } from './holderOriginCode'
import {
  decodeMorphoHolderPositionUint,
  type MorphoHolderPositionObservation,
  type MorphoHolderPositionTrace,
} from './morphoV2HolderPositionEvidence'

import { ROUTES } from '@/components/Carry/fixtures'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import morphoIdentities from '@/lib/carry/morpho-v2-asset-identities.json'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const RAW_AMOUNT = /^(?:[1-9][0-9]{0,77})$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_FINALIZED_AGE_MS = 2 * 60 * 60 * 1000
const MAX_CALL_GAS = 20_000_000n
const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const assetAbi = parseAbi(['function decimals() view returns (uint8)'])

export type MorphoExitRequest = {
  routeKey: string
  destinationAddress: Address
  owner: Address
  assetsRaw: string
}

/** Internal scorer input; deliberately absent from MorphoExitRequest/API. */
export type MorphoHistoricalFinalizedBlock = {
  mode: 'internal_historical_finalized_block'
  blockNumber: bigint
  blockHash: `0x${string}`
}

export type MorphoExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getCode' | 'readContract' | 'call' | 'request'
>

const isUint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function resolveMorphoExitTarget(routeKey: string, destinationAddress: Address) {
  const registry = buildCarryForecastRegistry(
    ROUTES,
    seed,
    recorderConfig.venues,
    GHO_SGHO.destination,
    verifiedDirectSupplyDestinations(),
  )
  const route = registry.routeGroups.find((group) => group.routeKey === routeKey)
  const subject = route?.contractSubjects.find(
    (entry) => entry.destinationAddress === destinationAddress.toLowerCase(),
  )
  if (!subject || subject.identitySource.kind !== 'august_observed') {
    throw new Error('morpho_route_destination_unknown')
  }
  if (
    morphoIdentities.schemaVersion !== 1 ||
    morphoIdentities.chainId !== 1 ||
    morphoIdentities.cohortId !== registry.provenance.cohortId ||
    morphoIdentities.entries.length !== 49 ||
    new Set(morphoIdentities.entries.map((entry) => entry.vault.toLowerCase())).size !== 49
  ) {
    throw new Error('morpho_identity_manifest_invalid')
  }
  const identity = morphoIdentities.entries.find((entry) => same(entry.vault, destinationAddress))
  if (!identity || !ADDRESS.test(identity.asset)) {
    throw new Error('morpho_route_destination_unknown')
  }
  return { vault: destinationAddress, asset: identity.asset as Address }
}

function isEvmRevert(error: unknown): boolean {
  // A transport timeout or malformed RPC reply is never an observed EVM revert.
  const record = error as {
    name?: unknown
    shortMessage?: unknown
    message?: unknown
    details?: unknown
    cause?: unknown
  } | null
  if (!record || typeof record !== 'object') return false
  const detail = [record.shortMessage, record.message, record.details]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
    .toLowerCase()
  if (
    /gas required exceeds allowance|out of gas|exceeds block gas|intrinsic gas|gas limit/.test(
      detail,
    )
  )
    return false
  if (record.cause && record.cause !== error && !isEvmRevert(record.cause)) return false
  if (record.name === 'ContractFunctionRevertedError') return true
  return /execution reverted|reverted with/i.test(detail)
}

/** Simulates a present holder withdrawal. It never estimates a future exit window. */
export async function readMorphoExitQuote(
  client: MorphoExitClient,
  request: MorphoExitRequest,
  now: number | (() => number) = () => Date.now(),
  historicalBlock?: MorphoHistoricalFinalizedBlock,
  capacityOptions?: { includeCapacityFacts: true },
) {
  if (
    typeof request.routeKey !== 'string' ||
    !request.routeKey ||
    request.routeKey.length > 160 ||
    !ADDRESS.test(request.destinationAddress) ||
    !ADDRESS.test(request.owner) ||
    typeof request.assetsRaw !== 'string' ||
    !RAW_AMOUNT.test(request.assetsRaw)
  ) {
    throw new Error('morpho_exit_request_invalid')
  }
  const requestedAssets = BigInt(request.assetsRaw)
  if (requestedAssets > MAX_UINT256) throw new Error('morpho_exit_request_invalid')
  const target = resolveMorphoExitTarget(request.routeKey, request.destinationAddress)
  if ((await client.getChainId()) !== 1) throw new Error('morpho_chain_mismatch')

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
    startedAt - finalizedMs > MAX_FINALIZED_AGE_MS
  )
    throw new Error('morpho_finalized_block_unavailable')
  if (
    historicalBlock &&
    (historicalBlock.mode !== 'internal_historical_finalized_block' ||
      typeof historicalBlock.blockNumber !== 'bigint' ||
      historicalBlock.blockNumber < 0n ||
      historicalBlock.blockNumber > finalized.number ||
      typeof historicalBlock.blockHash !== 'string' ||
      !HASH.test(historicalBlock.blockHash))
  )
    throw new Error('morpho_historical_block_invalid')
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
    throw new Error('morpho_block_hash_changed')
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
    (!historicalBlock && startedAt - blockMs > MAX_FINALIZED_AGE_MS)
  ) {
    throw new Error('morpho_finalized_block_unavailable')
  }
  const pinnedHash = blockHash as `0x${string}`
  const confirmBlock = async () => {
    const header = await client.getBlock({ blockNumber })
    if (
      header?.number !== blockNumber ||
      header.timestamp !== block.timestamp ||
      !header.hash ||
      !same(header.hash, blockHash)
    ) {
      throw new Error('morpho_block_hash_changed')
    }
  }
  await confirmBlock()

  // A direct eth_call from a contract holder cannot reproduce the contract's
  // own execution path. Do not imply its withdrawal is executable by a wallet.
  const ownerCode = await client.request({
    method: 'eth_getCode',
    params: [request.owner, { blockHash: pinnedHash, requireCanonical: true }],
  })
  if (!isEoaTransactionOriginCode(ownerCode))
    throw new Error('morpho_contract_holder_path_unavailable')

  // Keep the original no-caller/no-gas read semantics, retaining the exact RPC
  // result separately from the withdrawal simulation and its requested Q.
  const holderRead = async (key: 'balanceOf' | 'previewRedeem', argument: Address | bigint) => {
    const data =
      key === 'balanceOf'
        ? encodeFunctionData({ abi: vaultAbi, functionName: key, args: [argument as Address] })
        : encodeFunctionData({ abi: vaultAbi, functionName: key, args: [argument as bigint] })
    const params: MorphoHolderPositionTrace['params'] = [
      { to: target.vault.toLowerCase() as Address, data },
      { blockHash: pinnedHash.toLowerCase() as `0x${string}`, requireCanonical: true },
    ]
    const begin = readNow()
    const result = await client.request({ method: 'eth_call', params })
    const end = readNow()
    return { key, params, result, begin, end, decoded: decodeMorphoHolderPositionUint(key, result) }
  }
  const [asset, shareDecimals, assetDecimals, balanceRead] = await Promise.all([
    client.readContract({
      address: target.vault,
      abi: vaultAbi,
      functionName: 'asset',
      blockHash: pinnedHash,
      requireCanonical: true,
    }),
    client.readContract({
      address: target.vault,
      abi: vaultAbi,
      functionName: 'decimals',
      blockHash: pinnedHash,
      requireCanonical: true,
    }),
    client.readContract({
      address: target.asset,
      abi: assetAbi,
      functionName: 'decimals',
      blockHash: pinnedHash,
      requireCanonical: true,
    }),
    holderRead('balanceOf', request.owner),
  ])
  const shares = balanceRead.decoded
  if (
    !same(asset, target.asset) ||
    !Number.isInteger(Number(shareDecimals)) ||
    Number(shareDecimals) < 0 ||
    Number(shareDecimals) > 36 ||
    !Number.isInteger(Number(assetDecimals)) ||
    Number(assetDecimals) < 0 ||
    Number(assetDecimals) > 36 ||
    !isUint(shares)
  ) {
    throw new Error('morpho_exit_identity_or_balance_invalid')
  }
  const previewRead = await holderRead('previewRedeem', shares)
  const claim = previewRead.decoded
  if (!isUint(claim)) throw new Error('morpho_exit_preview_invalid')

  let maxWithdrawQuote:
    | { status: 'quoted' | 'unsupported' | 'unavailable'; amountRaw: string | null }
    | undefined
  if (capacityOptions?.includeCapacityFacts === true) {
    try {
      const limit = await client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'maxWithdraw',
        args: [request.owner],
        blockHash: pinnedHash,
        requireCanonical: true,
      })
      maxWithdrawQuote = isUint(limit)
        ? { status: 'quoted', amountRaw: limit.toString() }
        : { status: 'unavailable', amountRaw: null }
    } catch (error) {
      maxWithdrawQuote = {
        status: isEvmRevert(error) ? 'unsupported' : 'unavailable',
        amountRaw: null,
      }
    }
  }
  const callData = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'withdraw',
    args: [requestedAssets, request.owner, request.owner],
  })
  let simulation:
    | { status: 'executable_at_finalized_block'; sharesBurned: bigint }
    | { status: 'blocked_at_finalized_block' }
  try {
    const result = await client.call({
      account: request.owner,
      to: target.vault,
      data: callData,
      gas: MAX_CALL_GAS,
      blockHash: pinnedHash,
      requireCanonical: true,
    })
    if (!result.data) throw new Error('morpho_simulation_result_invalid')
    const sharesBurned = decodeFunctionResult({
      abi: vaultAbi,
      functionName: 'withdraw',
      data: result.data,
    })
    if (
      !isUint(sharesBurned) ||
      sharesBurned === 0n ||
      sharesBurned > shares ||
      requestedAssets > claim
    ) {
      throw new Error('morpho_simulation_result_invalid')
    }
    simulation = { status: 'executable_at_finalized_block', sharesBurned }
  } catch (error) {
    if (!isEvmRevert(error)) throw error
    simulation = { status: 'blocked_at_finalized_block' }
  }

  await confirmBlock()
  const completedAt = readNow()
  if (
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt ||
    completedAt - blockMs < -120_000 ||
    (!historicalBlock && completedAt - blockMs > MAX_FINALIZED_AGE_MS)
  ) {
    throw new Error('morpho_finalized_block_unavailable')
  }
  const traceTimes = [
    startedAt,
    balanceRead.begin,
    balanceRead.end,
    previewRead.begin,
    previewRead.end,
    completedAt,
  ]
  // Historical reads and slow observations still retain the quote's existing
  // behavior; they cannot become a fresh holder-position approval.
  const morphoHolderPositionObservation: MorphoHolderPositionObservation | undefined =
    completedAt - startedAt <= 120_000 &&
    completedAt - blockMs <= MAX_FINALIZED_AGE_MS &&
    traceTimes.every(
      (time, i) =>
        Number.isSafeInteger(time) && time >= 0 && (i === 0 || time >= traceTimes[i - 1]),
    )
      ? {
          schemaVersion: 1,
          kind: 'morpho_v2_holder_position_origin_v1',
          routeKey: request.routeKey,
          destination: target.vault.toLowerCase() as Address,
          asset: target.asset.toLowerCase() as Address,
          assetDecimals: Number(assetDecimals),
          shareDecimals: Number(shareDecimals),
          source: {
            chainId: 1,
            blockNumber: Number(blockNumber),
            blockHash: pinnedHash.toLowerCase() as `0x${string}`,
            blockTime: new Date(blockMs).toISOString(),
            finalized: true,
          },
          startedAtUtc: new Date(startedAt).toISOString(),
          readAtUtc: new Date(completedAt).toISOString(),
          deadlineMs: 120_000,
          traces: [balanceRead, previewRead].map((read) => ({
            key: read.key,
            method: 'eth_call' as const,
            params: read.params,
            result: read.result as `0x${string}`,
            startedAtUtc: new Date(read.begin).toISOString(),
            completedAtUtc: new Date(read.end).toISOString(),
          })) as MorphoHolderPositionObservation['traces'],
        }
      : undefined
  return {
    ...(morphoHolderPositionObservation ? { morphoHolderPositionObservation } : {}),
    status: 'checked_at_finalized_block' as const,
    source: {
      chainId: 1,
      blockNumber: Number(blockNumber),
      blockHash,
      blockTime: new Date(blockMs).toISOString(),
      observedAt: new Date(completedAt).toISOString(),
      ageSeconds: Math.max(0, Math.floor((completedAt - blockMs) / 1000)),
      method: 'eth_call_withdraw_at_finalized_block' as const,
    },
    routeKey: request.routeKey,
    vault: {
      address: target.vault,
      assetAddress: target.asset,
      assetDecimals: Number(assetDecimals),
      shareDecimals: Number(shareDecimals),
      identity: 'factory_receipt_verified' as const,
    },
    position: {
      ...(maxWithdrawQuote ? { maxWithdrawQuote } : {}),
      sharesRaw: shares.toString(),
      shares: formatUnits(shares, Number(shareDecimals)),
      previewRedeemAssetsRaw: claim.toString(),
      previewRedeemAssets: formatUnits(claim, Number(assetDecimals)),
    },
    request: {
      assetsRaw: requestedAssets.toString(),
      assets: formatUnits(requestedAssets, Number(assetDecimals)),
    },
    simulation:
      simulation.status === 'executable_at_finalized_block'
        ? { status: 'success' as const, sharesBurnedRaw: simulation.sharesBurned.toString() }
        : {
            status: 'evm_revert' as const,
            reason:
              shares === 0n
                ? 'no_holder_shares'
                : requestedAssets > claim
                  ? 'requested_amount_exceeds_preview_claim'
                  : 'unknown_execution_constraint',
          },
    forecast: {
      futureExit: 'unavailable' as const,
      exitDuration: 'unavailable' as const,
      prospectiveValidated: false as const,
    },
    caveat:
      'A read-only same-holder withdrawal simulation at one finalized block. Wallet gas funding and state at transaction time are unassessed; no future exit or deposit-counterfactual estimate is implied.',
  }
}
