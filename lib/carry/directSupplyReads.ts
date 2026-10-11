import { formatUnits, isAddress, parseAbi, type Address, type PublicClient } from 'viem'

import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'

const MAX_SOURCE_AGE_MS = 60 * 60 * 1000
const HASH = /^0x[0-9a-fA-F]{64}$/
const USDC_DECIMALS = 6
const USDT_DECIMALS = 6
const USDE_DECIMALS = 18
const aTokenAbi = parseAbi([
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
])
const cometAbi = parseAbi([
  'function baseToken() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
])
const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
])

type Reader = Pick<PublicClient, 'getChainId' | 'getBlock' | 'readContract'>
export type DirectSupplyRouteKey =
  | typeof DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey
  | typeof DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey
  | typeof DIRECT_SUPPLY_MARKETS.compoundV3Usdc.routeKey
  | typeof DIRECT_SUPPLY_MARKETS.sparkLendUsdt.routeKey

function marketConstants() {
  const aave = DIRECT_SUPPLY_MARKETS.aaveV3Usdc
  const compound = DIRECT_SUPPLY_MARKETS.compoundV3Usdc
  if (
    aave.underlying.toLowerCase() !== compound.underlying.toLowerCase() ||
    aave.decimals !== USDC_DECIMALS ||
    compound.decimals !== USDC_DECIMALS
  ) {
    throw new Error('direct_supply_market_constants_invalid')
  }
  return {
    usdc: aave.underlying as Address,
    aToken: aave.destination as Address,
    comet: compound.destination as Address,
  }
}

function validRaw(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n
}

function validAge(blockTimestamp: bigint, nowMs: number) {
  const blockMs = Number(blockTimestamp) * 1000
  const ageMs = nowMs - blockMs
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(blockMs) ||
    ageMs < -120_000 ||
    ageMs > MAX_SOURCE_AGE_MS
  ) {
    throw new Error('direct_supply_finalized_block_stale')
  }
  return Math.floor(ageMs / 1000)
}

/** Reusable Aave-family aToken cash leg. The caller must pin and verify finality. */
export async function readAaveATokenCashAtBlock(
  client: Pick<PublicClient, 'readContract'>,
  options: {
    aToken: Address
    underlying: Address
    decimals: number
    blockNumber: bigint
  },
) {
  const { aToken, underlying, decimals, blockNumber } = options
  if (
    !isAddress(aToken, { strict: false }) ||
    !isAddress(underlying, { strict: false }) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    typeof blockNumber !== 'bigint' ||
    blockNumber < 0n
  ) {
    throw new Error('direct_supply_market_constants_invalid')
  }
  let underlyingIdentity: Address
  let supply: bigint
  let shareDecimals: number
  let underlyingDecimals: number
  let cash: bigint
  try {
    ;[underlyingIdentity, supply, shareDecimals, underlyingDecimals, cash] = await Promise.all([
      client.readContract({
        address: aToken,
        abi: aTokenAbi,
        functionName: 'UNDERLYING_ASSET_ADDRESS',
        blockNumber,
      }),
      client.readContract({
        address: aToken,
        abi: aTokenAbi,
        functionName: 'totalSupply',
        blockNumber,
      }),
      client.readContract({
        address: aToken,
        abi: aTokenAbi,
        functionName: 'decimals',
        blockNumber,
      }),
      client.readContract({
        address: underlying,
        abi: erc20Abi,
        functionName: 'decimals',
        blockNumber,
      }),
      client.readContract({
        address: underlying,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [aToken],
        blockNumber,
      }),
    ])
  } catch {
    throw new Error('direct_supply_read_unavailable')
  }
  if (
    typeof underlyingIdentity !== 'string' ||
    underlyingIdentity.toLowerCase() !== underlying.toLowerCase() ||
    shareDecimals !== decimals ||
    underlyingDecimals !== decimals ||
    !validRaw(supply) ||
    !validRaw(cash)
  ) {
    throw new Error('direct_supply_identity_or_state_mismatch')
  }
  return { cashRaw: cash, totalSupplyRaw: supply }
}

/**
 * Reads two known direct-supply destinations at one fresh Ethereum finalized
 * block. USDC held by aToken/Comet is aggregate cash, not a holder-specific
 * withdraw limit, executable quote, or validated future exit forecast.
 */
export async function readDirectSupplyCash(
  client: Reader,
  now: number | (() => number) = () => Date.now(),
) {
  const readNow = typeof now === 'function' ? now : () => now
  const { usdc, aToken, comet } = marketConstants()
  if ((await client.getChainId()) !== 1) throw new Error('direct_supply_chain_mismatch')

  const block = await client.getBlock({ blockTag: 'finalized' })
  if (
    typeof block?.number !== 'bigint' ||
    block.number < 0n ||
    !Number.isSafeInteger(Number(block.number)) ||
    !HASH.test(block.hash ?? '') ||
    typeof block.timestamp !== 'bigint'
  ) {
    throw new Error('direct_supply_finalized_block_unavailable')
  }
  validAge(block.timestamp, readNow())
  const blockNumber = block.number
  const blockHash = block.hash as `0x${string}`
  const before = await client.getBlock({ blockNumber })
  if (before?.hash?.toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error('direct_supply_block_hash_changed')
  }

  let reads: [
    Awaited<ReturnType<typeof readAaveATokenCashAtBlock>>,
    Address,
    bigint,
    number,
    bigint,
  ]
  try {
    reads = (await Promise.all([
      readAaveATokenCashAtBlock(client, {
        aToken,
        underlying: usdc,
        decimals: USDC_DECIMALS,
        blockNumber,
      }),
      client.readContract({
        address: comet,
        abi: cometAbi,
        functionName: 'baseToken',
        blockNumber,
      }),
      client.readContract({
        address: comet,
        abi: cometAbi,
        functionName: 'totalSupply',
        blockNumber,
      }),
      client.readContract({ address: comet, abi: cometAbi, functionName: 'decimals', blockNumber }),
      client.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [comet],
        blockNumber,
      }),
    ])) as typeof reads
  } catch (error) {
    if (error instanceof Error && error.message === 'direct_supply_identity_or_state_mismatch')
      throw error
    throw new Error('direct_supply_read_unavailable')
  }
  const [aave, compoundBase, compoundSupply, compoundDecimals, compoundCash] = reads
  if (
    typeof compoundBase !== 'string' ||
    compoundBase.toLowerCase() !== usdc.toLowerCase() ||
    compoundDecimals !== USDC_DECIMALS ||
    !validRaw(compoundSupply) ||
    !validRaw(compoundCash)
  ) {
    throw new Error('direct_supply_identity_or_state_mismatch')
  }

  const after = await client.getBlock({ blockNumber })
  if (after?.hash?.toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error('direct_supply_block_hash_changed')
  }
  const ageSeconds = validAge(block.timestamp, readNow())

  const source = {
    chainId: 1 as const,
    blockNumber: Number(blockNumber),
    blockHash,
    blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
    ageSeconds,
    finality: 'finalized' as const,
  }
  return {
    source,
    asset: { symbol: 'USDC' as const, address: usdc, decimals: USDC_DECIMALS },
    caveat:
      'Aggregate USDC cash proxy at the destination contract; no holder-specific withdraw limit, executable exit quote, or forecast validation.',
    routes: [
      {
        routeKey: 'USDC → supply on Aave V3' as const,
        venueKind: 'aave_v3_atoken' as const,
        destination: aToken,
        cashRaw: aave.cashRaw.toString(),
        cashUsdc: formatUnits(aave.cashRaw, USDC_DECIMALS),
        totalSupplyRaw: aave.totalSupplyRaw.toString(),
      },
      {
        routeKey: 'USDC → supply on Compound v3' as const,
        venueKind: 'compound_v3_comet' as const,
        destination: comet,
        cashRaw: compoundCash.toString(),
        cashUsdc: formatUnits(compoundCash, USDC_DECIMALS),
        totalSupplyRaw: compoundSupply.toString(),
      },
    ],
  }
}

/**
 * Route-specific live read. A failure in the other market cannot suppress this
 * route's finalized cash observation. The result remains an aggregate proxy.
 */
export async function readDirectSupplyCashForRoute(
  client: Reader,
  routeKey: DirectSupplyRouteKey,
  now: number | (() => number) = () => Date.now(),
) {
  if (
    routeKey !== DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey &&
    routeKey !== DIRECT_SUPPLY_MARKETS.aaveV3Usde.routeKey &&
    routeKey !== DIRECT_SUPPLY_MARKETS.compoundV3Usdc.routeKey &&
    routeKey !== DIRECT_SUPPLY_MARKETS.sparkLendUsdt.routeKey
  ) {
    throw new Error('direct_supply_route_unknown')
  }
  const readNow = typeof now === 'function' ? now : () => now
  const spark = DIRECT_SUPPLY_MARKETS.sparkLendUsdt
  const aaveUsde = DIRECT_SUPPLY_MARKETS.aaveV3Usde
  const isSpark = routeKey === spark.routeKey
  const isAaveUsde = routeKey === aaveUsde.routeKey
  if (!isSpark && !isAaveUsde) marketConstants()
  const usdc = DIRECT_SUPPLY_MARKETS.aaveV3Usdc.underlying as Address
  const aToken = DIRECT_SUPPLY_MARKETS.aaveV3Usdc.destination as Address
  const comet = DIRECT_SUPPLY_MARKETS.compoundV3Usdc.destination as Address
  if (isSpark && spark.decimals !== USDT_DECIMALS)
    throw new Error('direct_supply_market_constants_invalid')
  if (isAaveUsde && aaveUsde.decimals !== USDE_DECIMALS)
    throw new Error('direct_supply_market_constants_invalid')
  if ((await client.getChainId()) !== 1) throw new Error('direct_supply_chain_mismatch')
  const block = await client.getBlock({ blockTag: 'finalized' })
  if (
    typeof block?.number !== 'bigint' ||
    block.number < 0n ||
    !Number.isSafeInteger(Number(block.number)) ||
    !HASH.test(block.hash ?? '') ||
    typeof block.timestamp !== 'bigint'
  ) {
    throw new Error('direct_supply_finalized_block_unavailable')
  }
  validAge(block.timestamp, readNow())
  const blockNumber = block.number
  const blockHash = block.hash as `0x${string}`
  const before = await client.getBlock({ blockNumber })
  if (before?.hash?.toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error('direct_supply_block_hash_changed')
  }

  let cash: bigint
  let totalSupply: bigint
  let destination: Address
  let venueKind: 'aave_v3_atoken' | 'compound_v3_comet' | 'spark_lend_atoken'
  if (routeKey === DIRECT_SUPPLY_MARKETS.aaveV3Usdc.routeKey) {
    const aave = await readAaveATokenCashAtBlock(client, {
      aToken,
      underlying: usdc,
      decimals: USDC_DECIMALS,
      blockNumber,
    })
    cash = aave.cashRaw
    totalSupply = aave.totalSupplyRaw
    destination = aToken
    venueKind = 'aave_v3_atoken'
  } else if (isAaveUsde) {
    const aave = await readAaveATokenCashAtBlock(client, {
      aToken: aaveUsde.destination as Address,
      underlying: aaveUsde.underlying as Address,
      decimals: USDE_DECIMALS,
      blockNumber,
    })
    cash = aave.cashRaw
    totalSupply = aave.totalSupplyRaw
    destination = aaveUsde.destination as Address
    venueKind = 'aave_v3_atoken'
  } else if (isSpark) {
    const sparkRead = await readAaveATokenCashAtBlock(client, {
      aToken: spark.destination as Address,
      underlying: spark.underlying as Address,
      decimals: USDT_DECIMALS,
      blockNumber,
    })
    cash = sparkRead.cashRaw
    totalSupply = sparkRead.totalSupplyRaw
    destination = spark.destination as Address
    venueKind = 'spark_lend_atoken'
  } else {
    let base: Address
    let supply: bigint
    let decimals: number
    let underlyingDecimals: number
    let balance: bigint
    try {
      ;[base, supply, decimals, underlyingDecimals, balance] = await Promise.all([
        client.readContract({
          address: comet,
          abi: cometAbi,
          functionName: 'baseToken',
          blockNumber,
        }),
        client.readContract({
          address: comet,
          abi: cometAbi,
          functionName: 'totalSupply',
          blockNumber,
        }),
        client.readContract({
          address: comet,
          abi: cometAbi,
          functionName: 'decimals',
          blockNumber,
        }),
        client.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: 'decimals',
          blockNumber,
        }),
        client.readContract({
          address: usdc,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [comet],
          blockNumber,
        }),
      ])
    } catch {
      throw new Error('direct_supply_read_unavailable')
    }
    if (
      typeof base !== 'string' ||
      base.toLowerCase() !== usdc.toLowerCase() ||
      decimals !== USDC_DECIMALS ||
      underlyingDecimals !== USDC_DECIMALS ||
      !validRaw(supply) ||
      !validRaw(balance)
    ) {
      throw new Error('direct_supply_identity_or_state_mismatch')
    }
    cash = balance
    totalSupply = supply
    destination = comet
    venueKind = 'compound_v3_comet'
  }

  const after = await client.getBlock({ blockNumber })
  if (after?.hash?.toLowerCase() !== blockHash.toLowerCase()) {
    throw new Error('direct_supply_block_hash_changed')
  }
  const ageSeconds = validAge(block.timestamp, readNow())
  return {
    source: {
      chainId: 1 as const,
      blockNumber: Number(blockNumber),
      blockHash,
      blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
      ageSeconds,
      finality: 'finalized' as const,
    },
    asset: isSpark
      ? { symbol: 'USDT' as const, address: spark.underlying as Address, decimals: USDT_DECIMALS }
      : isAaveUsde
        ? {
            symbol: 'USDe' as const,
            address: aaveUsde.underlying as Address,
            decimals: USDE_DECIMALS,
          }
        : { symbol: 'USDC' as const, address: usdc, decimals: USDC_DECIMALS },
    caveat: isSpark
      ? 'Aggregate SparkLend USDT cash proxy; 13 of 15 August route rows have USDT supply receipt evidence and two are contrary borrows. No holder-specific withdraw limit, executable exit quote, or forecast validation.'
      : isAaveUsde
        ? 'Aggregate Aave V3 USDe reserve cash proxy; no holder-specific withdraw limit, executable exit quote, or forecast validation.'
        : 'Aggregate USDC cash proxy at the destination contract; no holder-specific withdraw limit, executable exit quote, or forecast validation.',
    route: {
      routeKey,
      venueKind,
      destination,
      cashRaw: cash.toString(),
      cashAsset: formatUnits(
        cash,
        isSpark ? USDT_DECIMALS : isAaveUsde ? USDE_DECIMALS : USDC_DECIMALS,
      ),
      cashUsdc: isSpark || isAaveUsde ? undefined : formatUnits(cash, USDC_DECIMALS),
      totalSupplyRaw: totalSupply.toString(),
    },
  }
}
