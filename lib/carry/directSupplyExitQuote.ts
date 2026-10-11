import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import type { CometWithdrawFacts } from './cometHolderCapacityProjection'

import { isEoaTransactionOriginCode } from './holderOriginCode'

import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const RAW_AMOUNT = /^[1-9][0-9]{0,77}$/
const MAX_UINT256 = (1n << 256n) - 1n
const MAX_SOURCE_AGE_MS = 2 * 60 * 60 * 1000
const MAX_CALL_GAS = 20_000_000n
// Exact Ethereum Pool identities from the local Aave Core forward panel and
// receipt-verified SparkLend August cohort. The reserve data is checked live.
const POOLS = {
  aaveV3Usdc: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  aaveV3Usde: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  sparkLendUsdt: '0xc13e21b648a5ee794902342038ff3adab66be987',
} as const

const tokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
])
const cometAbi = parseAbi([
  'function baseToken() view returns (address)',
  'function isWithdrawPaused() view returns (bool)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function withdraw(address,uint256)',
])
const poolAbi = parseAbi([
  'function withdraw(address,uint256,address) returns (uint256)',
  'function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
])

export type DirectSupplyReserveFacts = {
  status: 'reserve_getter_observed'
  pool: string
  aToken: string
  asset: string
  assetDecimals: number
  source: { chainId: 1; blockNumber: number; blockHash: string; blockTime: string; finalized: true }
  configurationRaw: string | null
  liquidityIndexRaw: string | null
  variableBorrowIndexRaw: string | null
  reserveLastUpdateTimestampRaw: string | null
  unbackedRaw: string | null
  restrictionInterpretation: 'unverified'
  active: null
  withdrawalsPaused: null
}
export type DirectSupplyExitRequest = {
  routeKey: string
  destinationAddress: Address
  owner: Address
  assetsRaw: string
}
/** Internal scorer input; deliberately absent from DirectSupplyExitRequest/API. */
export type DirectSupplyHistoricalFinalizedBlock = {
  mode: 'internal_historical_finalized_block'
  blockNumber: bigint
  blockHash: `0x${string}`
}
export type DirectSupplyExitClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'request' | 'readContract' | 'call'
>

type MarketKey = keyof typeof DIRECT_SUPPLY_MARKETS
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
const isUint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n
export function resolveDirectSupplyExitTarget(routeKey: string, destinationAddress: Address) {
  const entry = Object.entries(DIRECT_SUPPLY_MARKETS).find(
    ([, market]) => market.routeKey === routeKey && same(market.destination, destinationAddress),
  )
  if (!entry) throw new Error('direct_supply_exit_target_unknown')
  const [key, market] = entry as [MarketKey, (typeof DIRECT_SUPPLY_MARKETS)[MarketKey]]
  return {
    kind: key,
    routeKey: market.routeKey,
    destination: market.destination as Address,
    underlying: market.underlying as Address,
    decimals: market.decimals,
    pool: key === 'compoundV3Usdc' ? undefined : POOLS[key],
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

/** Read-only exact-holder, exact-amount check at one Ethereum finalized block. */
export async function readDirectSupplyExitQuote(
  client: DirectSupplyExitClient,
  request: DirectSupplyExitRequest,
  now: number | (() => number) = () => Date.now(),
  historicalBlock?: DirectSupplyHistoricalFinalizedBlock,
  options: { includeCapacityFacts?: true } = {},
) {
  if (
    !request ||
    typeof request.routeKey !== 'string' ||
    request.routeKey.length > 160 ||
    !ADDRESS.test(request.destinationAddress) ||
    !ADDRESS.test(request.owner) ||
    typeof request.assetsRaw !== 'string' ||
    !RAW_AMOUNT.test(request.assetsRaw)
  ) {
    throw new Error('direct_supply_exit_request_invalid')
  }
  const amount = BigInt(request.assetsRaw)
  if (amount > MAX_UINT256) throw new Error('direct_supply_exit_request_invalid')
  const target = resolveDirectSupplyExitTarget(request.routeKey, request.destinationAddress)
  if ((await client.getChainId()) !== 1) throw new Error('direct_supply_exit_chain_mismatch')

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
    throw new Error('direct_supply_exit_finalized_block_unavailable')
  if (
    historicalBlock &&
    (historicalBlock.mode !== 'internal_historical_finalized_block' ||
      typeof historicalBlock.blockNumber !== 'bigint' ||
      historicalBlock.blockNumber < 0n ||
      historicalBlock.blockNumber > finalized.number ||
      typeof historicalBlock.blockHash !== 'string' ||
      !HASH.test(historicalBlock.blockHash))
  )
    throw new Error('direct_supply_exit_historical_block_invalid')
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
    throw new Error('direct_supply_exit_block_hash_changed')
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
    throw new Error('direct_supply_exit_finalized_block_unavailable')
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
      throw new Error('direct_supply_exit_block_hash_changed')
    }
  }
  await confirmBlock()
  // viem getCode normalizes the RPC's exact '0x' to undefined. Read the raw
  // EIP-1898 response so an absent result cannot masquerade as EOA evidence.
  const holderCode = await client.request({
    method: 'eth_getCode',
    params: [request.owner, { blockHash: pinnedHash, requireCanonical: true }],
  })
  if (!isEoaTransactionOriginCode(holderCode)) {
    throw new Error('direct_supply_exit_contract_holder_unavailable')
  }

  const pinned = { blockHash: pinnedHash, requireCanonical: true as const }
  const [underlyingDecimals, shareDecimals, holderBalance, liveUnderlying] = await Promise.all([
    client.readContract({
      address: target.underlying,
      abi: tokenAbi,
      functionName: 'decimals',
      ...pinned,
    }),
    client.readContract({
      address: target.destination,
      abi: target.kind === 'compoundV3Usdc' ? cometAbi : tokenAbi,
      functionName: 'decimals',
      ...pinned,
    }),
    client.readContract({
      address: target.destination,
      abi: target.kind === 'compoundV3Usdc' ? cometAbi : tokenAbi,
      functionName: 'balanceOf',
      args: [request.owner],
      ...pinned,
    }),
    target.kind === 'compoundV3Usdc'
      ? client.readContract({
          address: target.destination,
          abi: cometAbi,
          functionName: 'baseToken',
          ...pinned,
        })
      : client.readContract({
          address: target.destination,
          abi: tokenAbi,
          functionName: 'UNDERLYING_ASSET_ADDRESS',
          ...pinned,
        }),
  ])
  if (
    Number(underlyingDecimals) !== target.decimals ||
    Number(shareDecimals) !== target.decimals ||
    !isUint(holderBalance) ||
    typeof liveUnderlying !== 'string' ||
    !same(liveUnderlying, target.underlying)
  ) {
    throw new Error('direct_supply_exit_identity_or_balance_invalid')
  }
  let reserveFacts: DirectSupplyReserveFacts | null = null
  if (target.pool) {
    const reserve = await client.readContract({
      address: target.pool,
      abi: poolAbi,
      functionName: 'getReserveData',
      args: [target.underlying],
      ...pinned,
    })
    if (
      !reserve ||
      typeof reserve.aTokenAddress !== 'string' ||
      !same(reserve.aTokenAddress, target.destination)
    ) {
      throw new Error('direct_supply_exit_reserve_identity_invalid')
    }
    const retainedUint = (value: unknown, bits: number) =>
      typeof value === 'bigint' && value >= 0n && value < 1n << BigInt(bits)
        ? value.toString()
        : bits <= 48 &&
            typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 0 &&
            value < 2 ** bits
          ? value.toString()
          : null
    reserveFacts = {
      status: 'reserve_getter_observed',
      pool: target.pool.toLowerCase(),
      aToken: target.destination.toLowerCase(),
      asset: target.underlying.toLowerCase(),
      assetDecimals: target.decimals,
      source: {
        chainId: 1,
        blockNumber: Number(blockNumber),
        blockHash: pinnedHash.toLowerCase(),
        blockTime: new Date(blockMs).toISOString(),
        finalized: true,
      },
      configurationRaw: retainedUint(reserve.configuration, 256),
      liquidityIndexRaw: retainedUint(reserve.liquidityIndex, 128),
      variableBorrowIndexRaw: retainedUint(reserve.variableBorrowIndex, 128),
      reserveLastUpdateTimestampRaw: retainedUint(reserve.lastUpdateTimestamp, 40),
      unbackedRaw: retainedUint(reserve.unbacked, 128),
      restrictionInterpretation: 'unverified',
      active: null,
      withdrawalsPaused: null,
    }
  }

  let cometFacts: CometWithdrawFacts | null = null
  if (target.kind === 'compoundV3Usdc' && options.includeCapacityFacts === true) {
    let withdrawalsPaused: boolean | null = null
    try {
      const value = await client.readContract({
        address: target.destination,
        abi: cometAbi,
        functionName: 'isWithdrawPaused',
        ...pinned,
      })
      if (typeof value === 'boolean') withdrawalsPaused = value
    } catch {
      /* optional getter failure preserves the core Q/entitlement evidence */
    }
    cometFacts = {
      status: 'comet_withdraw_getter_observed',
      routeKey: target.routeKey,
      destination: target.destination.toLowerCase(),
      asset: target.underlying.toLowerCase(),
      assetDecimals: target.decimals,
      source: {
        chainId: 1,
        blockNumber: Number(blockNumber),
        blockHash: pinnedHash.toLowerCase(),
        blockTime: new Date(blockMs).toISOString(),
        finalized: true,
      },
      withdrawalsPaused,
    }
  }

  let simulation: { status: 'success' } | { status: 'evm_revert'; reason: string }
  try {
    const data = target.pool
      ? encodeFunctionData({
          abi: poolAbi,
          functionName: 'withdraw',
          args: [target.underlying, amount, request.owner],
        })
      : encodeFunctionData({
          abi: cometAbi,
          functionName: 'withdraw',
          args: [target.underlying, amount],
        })
    const result = await client.call({
      account: request.owner,
      to: target.pool ?? target.destination,
      data,
      gas: MAX_CALL_GAS,
      ...pinned,
    })
    if (target.pool) {
      if (!result.data) throw new Error('direct_supply_exit_result_invalid')
      const returned = decodeFunctionResult({
        abi: poolAbi,
        functionName: 'withdraw',
        data: result.data,
      })
      if (returned !== amount) throw new Error('direct_supply_exit_result_invalid')
    } else if (result.data !== undefined && result.data !== '0x') {
      throw new Error('direct_supply_exit_result_invalid')
    }
    simulation = { status: 'success' }
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
    throw new Error('direct_supply_exit_finalized_block_unavailable')
  }
  // Comet.withdraw can succeed by opening a borrow. A successful call is a
  // holder exit only if the holder already owns at least the exact base amount.
  const enoughBalance = holderBalance >= amount
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
    reserveFacts,
    ...(cometFacts ? { cometFacts } : {}),
    routeKey: target.routeKey,
    owner: request.owner.toLowerCase() as Address,
    market: {
      kind: target.kind,
      address: target.destination,
      pool: target.pool ?? null,
      assetAddress: target.underlying,
      assetDecimals: target.decimals,
      identity: 'pinned_market_and_live_underlying' as const,
    },
    position: {
      suppliedBalanceRaw: holderBalance.toString(),
      suppliedBalance: formatUnits(holderBalance, target.decimals),
    },
    request: { assetsRaw: amount.toString(), assets: formatUnits(amount, target.decimals) },
    simulation:
      simulation.status === 'evm_revert'
        ? simulation
        : !enoughBalance
          ? {
              status: 'not_holder_exit' as const,
              reason: 'requested_amount_exceeds_holder_supply' as const,
            }
          : simulation,
    forecast: {
      futureExit: 'unavailable' as const,
      exitDuration: 'unavailable' as const,
      prospectiveValidated: false as const,
    },
    caveat:
      'Read-only same-holder withdrawal simulation at one finalized block. Wallet gas funding and state at transaction time are unassessed; no future exit or duration is implied.',
  }
}
