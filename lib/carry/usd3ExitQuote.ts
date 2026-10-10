import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  keccak256,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import { isEoaTransactionOriginCode } from './holderOriginCode'

export const USD3_ROUTE_KEY = 'USDC → USD3 [USDC]'
export const USD3_VAULT = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc' as Address
export const USDC_ASSET = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
export const USD3_IMPLEMENTATION = '0xd1f1c3f485063712873285bf4ef25ab068f13893' as Address
export const USD3_TOKENIZED_STRATEGY = '0xd377919fa87120584b21279a491f82d5265a139c' as Address

/** Source-block observations only; a positive native limit is not execution evidence. */
export type Usd3NativeCapacityFact = {
  owner: string
  method: 'availableWithdrawLimit(address)'
  asset: typeof USDC_ASSET
  assetDecimals: 6
  unit: 'raw_usdc_6'
  capacityRaw: string | null
  resultStatus: 'quoted' | 'unsupported' | 'unavailable'
  /** Optional on legacy observations; null means the source-pinned getter was unavailable. */
  shutdown?: boolean | null
  /** Completed original read clock; optional only for legacy capacity observations. */
  readAtUtc?: string | null
  source: { chainId: 1; blockNumber: number; blockHash: string; blockTime: string; finalized: true }
  runtimeProfile: {
    sourceClass: 'pinned_usd3_native_runtime'
    shareDecimals: 6
    /** Ordered proxy, USD3 implementation, tokenized strategy delegate, USDC asset. */
    contracts: [Usd3RuntimeIdentity, Usd3RuntimeIdentity, Usd3RuntimeIdentity, Usd3RuntimeIdentity]
  } | null
}
export type Usd3RuntimeIdentity = { address: string; code: `0x${string}`; keccak256: `0x${string}` }

const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const

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
  'function availableWithdrawLimit(address) view returns (uint256)',
  'function isShutdown() view returns (bool)',
  'function tokenizedStrategyAddress() view returns (address)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const tokenAbi = parseAbi(['function decimals() view returns (uint8)'])

export type Usd3ExitRequest = {
  routeKey: string
  destinationAddress: Address
  owner: Address
  assetsRaw: string
}
/** Internal scorer input; deliberately absent from Usd3ExitRequest/API. */
export type Usd3HistoricalFinalizedBlock = {
  mode: 'internal_historical_finalized_block'
  blockNumber: bigint
  blockHash: `0x${string}`
}
export type Usd3ExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'getCode' | 'getStorageAt' | 'readContract' | 'call' | 'request'
>

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const isUint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n
const canonicalCode = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && value.length <= 65536 && /^0x(?:[0-9a-f]{2})+$/.test(value)
export function resolveUsd3ExitTarget(routeKey: string, destinationAddress: Address) {
  if (routeKey !== USD3_ROUTE_KEY || !same(destinationAddress, USD3_VAULT)) {
    throw new Error('usd3_exit_target_unknown')
  }
  return {
    routeKey: USD3_ROUTE_KEY,
    vault: USD3_VAULT,
    asset: USDC_ASSET,
    implementation: USD3_IMPLEMENTATION,
    assetDecimals: 6,
    shareDecimals: 6,
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
  ) {
    return false
  }
  if (value.cause && value.cause !== error && !isEvmRevert(value.cause)) return false
  return (
    value.name === 'ContractFunctionRevertedError' ||
    /execution reverted|reverted with/.test(detail)
  )
}

/** Never invoke request accessors or reread caller-owned proof inputs after an await. */
function snapshotDataProperties<T extends object>(
  input: unknown,
  keys: readonly (keyof T)[],
  error: string,
): T {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(error)
  const snapshot: Partial<T> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(error)
    snapshot[key] = descriptor.value
  }
  return snapshot as T
}

/** Read-only direct USD3 withdrawal check for one holder, amount, and finalized block. */
export async function readUsd3ExitQuote(
  client: Usd3ExitClient,
  requestInput: Usd3ExitRequest,
  now: number | (() => number) = () => Date.now(),
  historicalInput?: Usd3HistoricalFinalizedBlock,
  capacityInput?: { includeCapacityFacts: true },
) {
  const request = snapshotDataProperties<Usd3ExitRequest>(
    requestInput,
    ['routeKey', 'destinationAddress', 'owner', 'assetsRaw'],
    'usd3_exit_request_invalid',
  )
  const historicalBlock =
    historicalInput === undefined
      ? undefined
      : snapshotDataProperties<Usd3HistoricalFinalizedBlock>(
          historicalInput,
          ['mode', 'blockNumber', 'blockHash'],
          'usd3_exit_historical_block_invalid',
        )
  if (
    historicalBlock &&
    (historicalBlock.mode !== 'internal_historical_finalized_block' ||
      typeof historicalBlock.blockNumber !== 'bigint' ||
      historicalBlock.blockNumber < 0n ||
      typeof historicalBlock.blockHash !== 'string' ||
      !HASH.test(historicalBlock.blockHash))
  )
    throw new Error('usd3_exit_historical_block_invalid')
  let includeCapacityFacts = false
  if (capacityInput !== undefined) {
    if (!capacityInput || typeof capacityInput !== 'object' || Array.isArray(capacityInput))
      throw new Error('usd3_exit_capacity_options_invalid')
    const flag = Object.getOwnPropertyDescriptor(capacityInput, 'includeCapacityFacts')
    if (flag && (!Object.hasOwn(flag, 'value') || typeof flag.value !== 'boolean'))
      throw new Error('usd3_exit_capacity_options_invalid')
    includeCapacityFacts = flag?.value === true
  }
  const readNow = typeof now === 'function' ? now : () => now
  if (
    !request ||
    typeof request.routeKey !== 'string' ||
    typeof request.destinationAddress !== 'string' ||
    !ADDRESS.test(request.destinationAddress) ||
    typeof request.owner !== 'string' ||
    !ADDRESS.test(request.owner) ||
    typeof request.assetsRaw !== 'string' ||
    !RAW_AMOUNT.test(request.assetsRaw)
  ) {
    throw new Error('usd3_exit_request_invalid')
  }
  const amount = BigInt(request.assetsRaw)
  if (amount > MAX_UINT256) throw new Error('usd3_exit_request_invalid')
  const target = resolveUsd3ExitTarget(request.routeKey, request.destinationAddress)
  if ((await client.getChainId()) !== 1) throw new Error('usd3_exit_chain_mismatch')

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
    throw new Error('usd3_exit_finalized_block_unavailable')
  if (
    historicalBlock &&
    (historicalBlock.mode !== 'internal_historical_finalized_block' ||
      typeof historicalBlock.blockNumber !== 'bigint' ||
      historicalBlock.blockNumber < 0n ||
      historicalBlock.blockNumber > finalized.number ||
      typeof historicalBlock.blockHash !== 'string' ||
      !HASH.test(historicalBlock.blockHash))
  )
    throw new Error('usd3_exit_historical_block_invalid')
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
    throw new Error('usd3_exit_block_hash_changed')
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
    throw new Error('usd3_exit_finalized_block_unavailable')
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
      throw new Error('usd3_exit_block_hash_changed')
    }
  }
  await confirmBlock()

  const pinned = { blockHash: pinnedHash, requireCanonical: true as const }
  const [vaultCode, implementationCode, holderCode, implementationSlot] = await Promise.all([
    client.getCode({ address: target.vault, ...pinned }),
    client.getCode({ address: target.implementation, ...pinned }),
    client.request({ method: 'eth_getCode', params: [request.owner, pinned] }),
    client.getStorageAt({
      address: target.vault,
      slot: EIP1967_IMPLEMENTATION_SLOT,
      ...pinned,
    }),
  ])
  if (
    !vaultCode ||
    vaultCode === '0x' ||
    !implementationCode ||
    implementationCode === '0x' ||
    !HASH.test(implementationSlot ?? '') ||
    !same(`0x${implementationSlot?.slice(-40)}`, target.implementation)
  ) {
    throw new Error('usd3_exit_vault_identity_unavailable')
  }
  if (!isEoaTransactionOriginCode(holderCode)) {
    throw new Error('usd3_exit_contract_holder_unavailable')
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
    Number(assetDecimals) !== target.assetDecimals ||
    Number(vaultDecimals) !== target.shareDecimals ||
    !isUint(balanceShares) ||
    !isUint(maxWithdrawAssets) ||
    !isUint(previewShares) ||
    previewShares === 0n
  ) {
    throw new Error('usd3_exit_identity_or_position_invalid')
  }

  let entitlementAssetsRaw: string | null = null
  let nativeCapacity: Omit<Usd3NativeCapacityFact, 'source'> | undefined
  if (includeCapacityFacts) {
    try {
      const entitlement = await client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'previewRedeem',
        args: [balanceShares],
        ...pinned,
      })
      if (isUint(entitlement) && entitlement <= MAX_UINT256)
        entitlementAssetsRaw = entitlement.toString()
    } catch {
      /* Optional capacity quote does not invalidate the independent withdrawal assay. */
    }
    nativeCapacity = {
      owner: request.owner.toLowerCase(),
      method: 'availableWithdrawLimit(address)',
      asset: USDC_ASSET,
      assetDecimals: 6,
      unit: 'raw_usdc_6',
      capacityRaw: null,
      resultStatus: 'unavailable',
      shutdown: null,
      runtimeProfile: null,
    }
    try {
      // Validate the actual ABI word, including zero, instead of accepting permissive decoding.
      const word = await client.request({
        method: 'eth_call',
        params: [
          {
            to: target.vault,
            data: encodeFunctionData({
              abi: vaultAbi,
              functionName: 'availableWithdrawLimit',
              args: [request.owner],
            }),
          },
          pinned,
        ],
      })
      if (typeof word === 'string' && /^0x[0-9a-fA-F]{64}$/.test(word)) {
        nativeCapacity.capacityRaw = BigInt(word).toString()
        nativeCapacity.resultStatus = 'quoted'
      }
    } catch (error) {
      nativeCapacity.resultStatus = isEvmRevert(error) ? 'unsupported' : 'unavailable'
    }
    try {
      const word = await client.request({
        method: 'eth_call',
        params: [
          {
            to: target.vault,
            data: encodeFunctionData({ abi: vaultAbi, functionName: 'isShutdown' }),
          },
          pinned,
        ],
      })
      // ABI bool has exactly one word and only 0/1 are valid; malformed is never false.
      if (typeof word === 'string' && /^0x0{63}[01]$/.test(word))
        nativeCapacity.shutdown = word.endsWith('1')
    } catch {
      /* Optional regime metadata does not invalidate independent entitlement or execution. */
    }
    try {
      const delegate = await client.readContract({
        address: target.vault,
        abi: vaultAbi,
        functionName: 'tokenizedStrategyAddress',
        ...pinned,
      })
      if (
        typeof delegate === 'string' &&
        ADDRESS.test(delegate) &&
        same(delegate, USD3_TOKENIZED_STRATEGY)
      ) {
        const [delegateCode, assetCode] = await Promise.all([
          client.getCode({ address: USD3_TOKENIZED_STRATEGY, ...pinned }),
          client.getCode({ address: target.asset, ...pinned }),
        ])
        if ([vaultCode, implementationCode, delegateCode, assetCode].every(canonicalCode)) {
          const identity = (address: string, code: `0x${string}`): Usd3RuntimeIdentity => ({
            address,
            code,
            keccak256: keccak256(code),
          })
          nativeCapacity.runtimeProfile = {
            sourceClass: 'pinned_usd3_native_runtime',
            shareDecimals: 6,
            contracts: [
              identity(target.vault, vaultCode as `0x${string}`),
              identity(target.implementation, implementationCode as `0x${string}`),
              identity(USD3_TOKENIZED_STRATEGY, delegateCode as `0x${string}`),
              identity(target.asset, assetCode as `0x${string}`),
            ],
          }
        }
      }
    } catch {
      /* Optional runtime evidence is censored without changing the withdrawal assay. */
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
    if (!result.data) throw new Error('usd3_exit_result_invalid')
    const burned = decodeFunctionResult({
      abi: vaultAbi,
      functionName: 'withdraw',
      data: result.data,
    })
    if (typeof burned !== 'bigint' || burned <= 0n || burned > balanceShares) {
      throw new Error('usd3_exit_result_invalid')
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
    throw new Error('usd3_exit_finalized_block_unavailable')
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
      assetDecimals: target.assetDecimals,
      shareDecimals: target.shareDecimals,
      implementation: target.implementation,
      identity: 'pinned_vault_asset_and_implementation' as const,
    },
    position: {
      ...(includeCapacityFacts ? { entitlementAssetsRaw } : {}),
      balanceSharesRaw: balanceShares.toString(),
      maxWithdrawAssetsRaw: maxWithdrawAssets.toString(),
      previewSharesRaw: previewShares.toString(),
    },
    ...(nativeCapacity
      ? {
          usd3NativeCapacity: {
            ...nativeCapacity,
            readAtUtc: new Date(completedAt).toISOString(),
            source: {
              chainId: 1 as const,
              blockNumber: Number(blockNumber),
              blockHash: pinnedHash.toLowerCase(),
              blockTime: new Date(blockMs).toISOString(),
              finalized: true as const,
            },
          },
        }
      : {}),
    request: { assetsRaw: amount.toString(), assets: formatUnits(amount, target.assetDecimals) },
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
      'Read-only same-holder USD3 to USDC withdrawal check at one finalized block. Wallet gas funding and state at transaction time are unassessed. This does not establish future exit ability.',
  }
}
