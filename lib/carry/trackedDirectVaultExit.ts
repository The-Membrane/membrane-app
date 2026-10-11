import { createHash } from 'node:crypto'
import {
  stusdsProtocolReadPlan,
  replayStusdsCurrentProtocolOrigin,
  type StusdsProtocolOriginObservation,
} from './stusdsCurrentProtocolCapacityEvidence'
import type { DirectSupplyHistoricalFinalizedBlock } from './directSupplyExitQuote'
import {
  readFluidUsdcBridgeNativeCapacityFact,
  type FluidUsdcBridgeNativeCapacityFact,
} from './fluidUsdcBridgeNativeCapacity'
import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { isEoaTransactionOriginCode } from './holderOriginCode'

import identities from '@/lib/carry/other-vault-asset-identities.json'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_FINALIZED_AGE_MS = 60 * 60 * 1000
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

const TRACKED = [
  {
    routeKey: 'USDS → StUsds [USDS]',
    vault: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    assetDecimals: 18,
    kind: 'spark_stusds',
  },
  {
    routeKey: 'USDC → Fluid USD Coin [USDC]',
    vault: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    kind: 'fluid_fusdc',
  },
  {
    routeKey: 'USDT → fToken [USDT]',
    vault: '0x5c20b550819128074fd538edf79791733ccedd18',
    asset: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    assetDecimals: 6,
    kind: 'fluid_fusdt',
  },
  {
    routeKey: 'GHO → fToken [GHO]',
    vault: '0x6a29a46e21c730dca1d8b23d637c101cec605c5b',
    asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    assetDecimals: 18,
    kind: 'fluid_fgho',
  },
  {
    routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
    vault: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    kind: 'fluid_bridge_usdc',
  },
  {
    routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
    vault: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    kind: 'fluid_bridge_usdc_first_leg',
  },
] as const

export type TrackedDirectVaultExitRequest = {
  routeKey: string
  destinationAddress: Address
  owner: Address
  assetsRaw: string
  assetUnit?: 'USDC'
}
export type TrackedDirectVaultExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getCode' | 'request' | 'readContract' | 'call'
>

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const isUint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n
/** The route and vault are fixed by the Carry board; the underlying comes from its pinned identity manifest. */
export function resolveTrackedDirectVaultExitTarget(routeKey: string, destinationAddress: Address) {
  const target = TRACKED.find(
    (item) => item.routeKey === routeKey && same(item.vault, destinationAddress),
  )
  if (!target) throw new Error('tracked_direct_exit_target_unknown')
  if (
    identities.schemaVersion !== 1 ||
    identities.chainId !== 1 ||
    identities.cohortId !== 'aug-2026-ab-vault-routes' ||
    identities.entries.length !== 11
  )
    throw new Error('tracked_direct_exit_manifest_invalid')
  const identity = identities.entries.find((entry) => same(entry.vault, target.vault))
  if (
    !identity ||
    !same(identity.asset, target.asset) ||
    identity.exitMechanics !== 'unassessed' ||
    (target.kind.startsWith('fluid_bridge_usdc')
      ? identity.evidenceKind !== 'official_deployment_documentation'
      : target.kind.startsWith('fluid_') &&
        identity.evidenceKind !== 'fluid_factory_computed_and_listed')
  )
    throw new Error('tracked_direct_exit_manifest_invalid')
  return {
    ...target,
    vault: target.vault as Address,
    asset: identity.asset as Address,
  }
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
  )
    return false
  if (value.cause && value.cause !== error && !isEvmRevert(value.cause)) return false
  return (
    value.name === 'ContractFunctionRevertedError' ||
    /execution reverted|reverted with/.test(detail)
  )
}

/** One present same-holder/amount withdrawal simulation; neither a future nor actual-transfer claim. */
export async function readTrackedDirectVaultExit(
  client: TrackedDirectVaultExitClient,
  request: TrackedDirectVaultExitRequest,
  now: number | (() => number) = () => Date.now(),
  historicalBlock?: DirectSupplyHistoricalFinalizedBlock,
  capacityOptions?: {
    includeCapacityFacts: true
    includeStusdsProtocolCapacity?: true
    includeFluidUsdcBridgeNativeCapacity?: true
  },
) {
  request = structuredClone(request)
  capacityOptions = structuredClone(capacityOptions)
  const protocolRpcRequest = client.request.bind(client)
  if (
    !request ||
    typeof request.routeKey !== 'string' ||
    !ADDRESS.test(request.destinationAddress) ||
    !ADDRESS.test(request.owner) ||
    typeof request.assetsRaw !== 'string' ||
    !RAW_AMOUNT.test(request.assetsRaw) ||
    (request.routeKey === 'USDT → FluidBridgeAggregatorProxy [USDC]' &&
      request.assetUnit !== 'USDC')
  )
    throw new Error('tracked_direct_exit_request_invalid')
  const amount = BigInt(request.assetsRaw)
  if (amount > MAX_UINT256) throw new Error('tracked_direct_exit_request_invalid')
  const target = resolveTrackedDirectVaultExitTarget(request.routeKey, request.destinationAddress)
  if ((await client.getChainId()) !== 1) throw new Error('tracked_direct_exit_chain_mismatch')

  const readNow = typeof now === 'function' ? now : () => now
  const startedAt = readNow()
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const finalizedMs = Number(finalized?.timestamp) * 1000
  if (
    typeof finalized?.number !== 'bigint' ||
    finalized.number < 0n ||
    typeof finalized.hash !== 'string' ||
    !HASH.test(finalized.hash) ||
    !Number.isSafeInteger(finalizedMs) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt - finalizedMs < -120_000 ||
    startedAt - finalizedMs > MAX_FINALIZED_AGE_MS
  )
    throw new Error('tracked_direct_exit_finalized_block_unavailable')
  if (
    historicalBlock &&
    (historicalBlock.mode !== 'internal_historical_finalized_block' ||
      typeof historicalBlock.blockNumber !== 'bigint' ||
      historicalBlock.blockNumber < 0n ||
      historicalBlock.blockNumber > finalized.number ||
      typeof historicalBlock.blockHash !== 'string' ||
      !HASH.test(historicalBlock.blockHash))
  )
    throw new Error('tracked_direct_exit_historical_block_invalid')
  const block = historicalBlock
    ? await client.getBlock({ blockNumber: historicalBlock.blockNumber })
    : finalized
  if (
    historicalBlock &&
    (block?.number !== historicalBlock.blockNumber ||
      typeof block.hash !== 'string' ||
      !same(block.hash, historicalBlock.blockHash) ||
      typeof block.timestamp !== 'bigint' ||
      block.timestamp > finalized.timestamp)
  )
    throw new Error('tracked_direct_exit_block_hash_changed')
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
  )
    throw new Error('tracked_direct_exit_finalized_block_unavailable')
  const pinnedHash = blockHash as `0x${string}`
  const confirmBlock = async () => {
    const header = await client.getBlock({ blockNumber })
    if (
      header?.number !== blockNumber ||
      header.timestamp !== block.timestamp ||
      !header.hash ||
      !same(header.hash, pinnedHash)
    )
      throw new Error('tracked_direct_exit_block_hash_changed')
  }
  await confirmBlock()

  const pinned = { blockHash: pinnedHash, requireCanonical: true as const }
  const [vaultCode, assetCode, holderCode] = await Promise.all([
    client.getCode({ address: target.vault, ...pinned }),
    client.getCode({ address: target.asset, ...pinned }),
    // viem getCode maps a valid raw '0x' to undefined. Preserve the exact RPC
    // response so an absent read cannot be mistaken for an EOA.
    client.request({ method: 'eth_getCode', params: [request.owner, pinned] }),
  ])
  if (!vaultCode || vaultCode === '0x' || !assetCode || assetCode === '0x')
    throw new Error('tracked_direct_exit_code_unavailable')
  if (!isEoaTransactionOriginCode(holderCode))
    throw new Error('tracked_direct_exit_contract_holder_unavailable')

  const [liveAsset, assetDecimals, shareDecimals, holderShares, maxWithdraw, previewShares] =
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
    Number(assetDecimals) !== target.assetDecimals ||
    !Number.isInteger(Number(shareDecimals)) ||
    Number(shareDecimals) < 0 ||
    Number(shareDecimals) > 36 ||
    !isUint(holderShares) ||
    !isUint(maxWithdraw) ||
    !isUint(previewShares) ||
    previewShares === 0n
  )
    throw new Error('tracked_direct_exit_identity_or_position_invalid')

  let entitlementAssetsRaw: string | null = null
  if (capacityOptions?.includeCapacityFacts === true) {
    try {
      const entitlement = await client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'previewRedeem',
        args: [holderShares],
        ...pinned,
      })
      if (isUint(entitlement)) entitlementAssetsRaw = entitlement.toString()
    } catch {
      /* Optional capacity quote does not invalidate the independent withdrawal assay. */
    }
  }
  let simulation:
    | { status: 'success'; sharesBurnedRaw: string }
    | { status: 'evm_revert'; reason: 'unknown_execution_constraint' }
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
    if (!result.data) throw new Error('tracked_direct_exit_result_invalid')
    const burned = decodeFunctionResult({
      abi: vaultAbi,
      functionName: 'withdraw',
      data: result.data,
    })
    if (typeof burned !== 'bigint' || burned <= 0n || burned > holderShares)
      throw new Error('tracked_direct_exit_result_invalid')
    simulation = { status: 'success', sharesBurnedRaw: burned.toString() }
  } catch (error) {
    if (!isEvmRevert(error)) throw error
    simulation = { status: 'evm_revert', reason: 'unknown_execution_constraint' }
  }

  // Optional global evidence is enclosed by the native assay's existing header checks.
  // Raw replies are retained; ABI reconstructions are never substituted for RPC results.
  let protocolCapacityObservation: StusdsProtocolOriginObservation | null = null
  if (capacityOptions?.includeStusdsProtocolCapacity === true && target.kind === 'spark_stusds') {
    try {
      const source = {
        chainId: 1 as const,
        blockNumber: Number(blockNumber),
        blockHash: pinnedHash,
        blockTime: new Date(blockMs).toISOString(),
        finalized: true as const,
      }
      const traces = []
      for (const spec of stusdsProtocolReadPlan(source)) {
        const params = structuredClone(spec.params)
        const result = await protocolRpcRequest({
          method: spec.method,
          params: structuredClone(params),
        } as any)
        traces.push({ key: spec.key, method: spec.method, params, result })
      }
      protocolCapacityObservation = {
        source,
        readAtUtc: new Date(readNow()).toISOString(),
        nativeIdentity: { assetAddress: target.asset, assetDecimals: 18, shareDecimals: 18 },
        coreRuntimeCodes: { proxy: vaultCode, asset: assetCode },
        traces,
      }
    } catch {
      /* Optional evidence never invalidates Q/E/M or the withdrawal simulation. */
    }
  }
  let fluidUsdcBridgeNativeCapacity: FluidUsdcBridgeNativeCapacityFact | null = null
  if (
    capacityOptions?.includeFluidUsdcBridgeNativeCapacity === true &&
    target.kind === 'fluid_bridge_usdc'
  ) {
    fluidUsdcBridgeNativeCapacity = await readFluidUsdcBridgeNativeCapacityFact(
      protocolRpcRequest as never,
      request.owner.toLowerCase(),
      {
        chainId: 1,
        blockNumber: Number(blockNumber),
        blockHash: pinnedHash.toLowerCase(),
        blockTime: new Date(blockMs).toISOString(),
        finalized: true,
      },
      readNow,
    )
    if (
      fluidUsdcBridgeNativeCapacity &&
      (fluidUsdcBridgeNativeCapacity.sharesRaw !== holderShares.toString() ||
        fluidUsdcBridgeNativeCapacity.fullNetEaRaw !== entitlementAssetsRaw)
    )
      fluidUsdcBridgeNativeCapacity = null
  }
  await confirmBlock()
  const completedAt = readNow()
  if (
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt ||
    completedAt - blockMs < -120_000 ||
    (!historicalBlock && completedAt - blockMs > MAX_FINALIZED_AGE_MS)
  )
    throw new Error('tracked_direct_exit_finalized_block_unavailable')

  if (protocolCapacityObservation) {
    protocolCapacityObservation.readAtUtc = new Date(completedAt).toISOString()
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (
      !replayStusdsCurrentProtocolOrigin(
        protocolCapacityObservation,
        protocolCapacityObservation.source,
        completedAt,
        hash,
      )
    )
      protocolCapacityObservation = null
  }
  return {
    ...(capacityOptions?.includeFluidUsdcBridgeNativeCapacity === true &&
    target.kind === 'fluid_bridge_usdc'
      ? { fluidUsdcBridgeNativeCapacity }
      : {}),
    ...(capacityOptions?.includeStusdsProtocolCapacity === true && target.kind === 'spark_stusds'
      ? { protocolCapacityObservation }
      : {}),
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
      assetDecimals: target.assetDecimals,
      shareDecimals: Number(shareDecimals),
      identity: 'pinned_route_and_live_asset' as const,
      implementationSourceAttested: false as const,
      kind: target.kind,
    },
    position: {
      ...(capacityOptions?.includeCapacityFacts === true ? { entitlementAssetsRaw } : {}),
      holderSharesRaw: holderShares.toString(),
      maxWithdrawAssetsRaw: maxWithdraw.toString(),
      previewSharesRaw: previewShares.toString(),
    },
    request: {
      assetsRaw: amount.toString(),
      assets: formatUnits(amount, target.assetDecimals),
      assetUnit: target.asset === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' ? 'USDC' : undefined,
    },
    ...(target.kind === 'fluid_bridge_usdc_first_leg'
      ? {
          routeLeg: {
            checked: 'same_holder_usdc_vault_withdrawal_simulation' as const,
            usdcToUsdtConversion: 'unassessed' as const,
            usdtReceipt: 'unassessed' as const,
          },
        }
      : {}),
    simulation:
      simulation.status === 'evm_revert'
        ? holderShares === 0n
          ? {
              status: 'position_insufficient' as const,
              reason: 'holder_has_no_shares' as const,
            }
          : {
              ...simulation,
              holderCoverage:
                holderShares < previewShares
                  ? ('inconclusive_preview_gap' as const)
                  : ('preview_covered_not_proven' as const),
            }
        : simulation,
    forecast: {
      futureExit: 'unavailable' as const,
      exitDuration: 'unavailable' as const,
      prospectiveValidated: false as const,
    },
    caveat:
      target.kind === 'fluid_bridge_usdc_first_leg'
        ? 'Read-only same-holder USDC vault withdrawal simulation only. USDC to USDT conversion, USDT receipt, actual delivery, and future exit are unassessed.'
        : 'Read-only same-holder underlying-asset withdrawal simulation at one finalized block. Actual delivered tokens, wallet gas, future exit, and route round trip are unassessed.',
  }
}
