/**
 * On-chain reads for net-APY-at-size, all at ONE block (the anchor).
 *
 * Read-only, like the position simulator's adapters (lib/position-sim/adapters/types.ts):
 * a value that was not read is never defaulted. Any failed leg throws with the call
 * that failed; the caller turns that into a per-venue error, so one broken venue never
 * blanks the rest.
 */

import { type PublicClient, zeroAddress } from 'viem'

import { decodeReserveConfig } from './irm/aave'
import { redactError } from './rpc'
import type { BlockAnchor, VenueSnapshot } from './types'
import { MORPHO_ADAPTIVE_CURVE_IRM, MORPHO_BLUE, type VenueDef } from './venues'

// ------------------------------------------------------------------------ ABIs

const reserveDataTuple = {
  type: 'tuple',
  components: [
    { name: 'configuration', type: 'uint256' },
    { name: 'liquidityIndex', type: 'uint128' },
    { name: 'currentLiquidityRate', type: 'uint128' },
    { name: 'variableBorrowIndex', type: 'uint128' },
    { name: 'currentVariableBorrowRate', type: 'uint128' },
    { name: 'currentStableBorrowRate', type: 'uint128' },
    { name: 'lastUpdateTimestamp', type: 'uint40' },
    { name: 'id', type: 'uint16' },
    { name: 'aTokenAddress', type: 'address' },
    { name: 'stableDebtTokenAddress', type: 'address' },
    { name: 'variableDebtTokenAddress', type: 'address' },
    { name: 'interestRateStrategyAddress', type: 'address' },
    { name: 'accruedToTreasury', type: 'uint128' },
    { name: 'unbacked', type: 'uint128' },
    { name: 'isolationModeTotalDebt', type: 'uint128' },
  ],
} as const

export const poolAbi = [
  { type: 'function', name: 'getReserveData', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [reserveDataTuple] },
  { type: 'function', name: 'RESERVE_INTEREST_RATE_STRATEGY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getVirtualUnderlyingBalance', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'uint128' }] },
] as const

export const erc20Abi = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

export const aaveStrategyV2Abi = [
  {
    type: 'function',
    name: 'getInterestRateDataBps',
    stateMutability: 'view',
    inputs: [{ name: 'reserve', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'optimalUsageRatio', type: 'uint16' },
          { name: 'baseVariableBorrowRate', type: 'uint32' },
          { name: 'variableRateSlope1', type: 'uint32' },
          { name: 'variableRateSlope2', type: 'uint32' },
        ],
      },
    ],
  },
] as const

export const sparkStrategyAbi = [
  { type: 'function', name: 'getBaseVariableBorrowRate', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getVariableRateSlope1', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getVariableRateSlope2', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'OPTIMAL_USAGE_RATIO', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

export const morphoAbi = [
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'idToMarketParams',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'loanToken', type: 'address' },
      { name: 'collateralToken', type: 'address' },
      { name: 'oracle', type: 'address' },
      { name: 'irm', type: 'address' },
      { name: 'lltv', type: 'uint256' },
    ],
  },
] as const

export const adaptiveCurveIrmAbi = [
  { type: 'function', name: 'rateAtTarget', stateMutability: 'view', inputs: [{ name: 'id', type: 'bytes32' }], outputs: [{ type: 'int256' }] },
] as const

export const eulerVaultAbi = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'cash', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalBorrows', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'interestFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'interestRate', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'interestRateModel', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

export const eulerKinkAbi = [
  { type: 'function', name: 'baseRate', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'slope1', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'slope2', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'kink', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

// ---------------------------------------------------------------------- anchor

/** The anchor block: `blockNumber` if given (a pinned read), else the latest block. */
export async function resolveAnchor(client: PublicClient, blockNumber?: bigint): Promise<BlockAnchor> {
  const block = await client.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber })
  if (block.number === null || block.hash === null) throw new Error('anchor: block has no number/hash (pending?)')
  return { chainId: 1, blockNumber: block.number, blockTimestamp: block.timestamp, blockHash: block.hash }
}

// ---------------------------------------------------------------------- reader

type Read = <T>(address: `0x${string}`, abi: readonly unknown[], functionName: string, args?: readonly unknown[]) => Promise<T>

const lower = (a: string) => a.toLowerCase()

/** Reads one venue at the anchor. Throws naming the failed call or the failed check. */
export async function readVenueSnapshot(
  client: PublicClient,
  def: VenueDef,
  anchor: BlockAnchor,
  rpc: string,
): Promise<VenueSnapshot> {
  const read: Read = async (address, abi, functionName, args = []) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await client.readContract({ address, abi: abi as any, functionName, args: args as any, blockNumber: anchor.blockNumber })) as any
    } catch (e) {
      throw new Error(`${def.venueKey}: ${functionName}() failed at block ${anchor.blockNumber}: ${redactError(e)}`)
    }
  }
  const base = { venueKey: def.venueKey, protocol: def.protocol, label: def.label, anchor, asset: def.asset, rpc }

  if (def.protocol === 'aave-v3' || def.protocol === 'spark') {
    type RD = {
      configuration: bigint
      currentLiquidityRate: bigint
      currentVariableBorrowRate: bigint
      lastUpdateTimestamp: number
      aTokenAddress: `0x${string}`
      variableDebtTokenAddress: `0x${string}`
      interestRateStrategyAddress: `0x${string}`
      unbacked: bigint
    }
    const rd = await read<RD>(def.pool, poolAbi, 'getReserveData', [def.asset.address])
    if (rd.aTokenAddress === zeroAddress) throw new Error(`${def.venueKey}: reserve not listed (aToken = 0)`)
    const cfg = decodeReserveConfig(rd.configuration)
    if (cfg.decimals !== def.asset.decimals) {
      throw new Error(`${def.venueKey}: reserve decimals ${cfg.decimals} != registry ${def.asset.decimals}`)
    }
    const [totalDebt, totalSupplied] = await Promise.all([
      read<bigint>(rd.variableDebtTokenAddress, erc20Abi, 'totalSupply'),
      read<bigint>(rd.aTokenAddress, erc20Abi, 'totalSupply'),
    ])
    const common = {
      aToken: rd.aTokenAddress,
      variableDebtToken: rd.variableDebtTokenAddress,
      unbacked: rd.unbacked,
      reserveFactorBps: cfg.reserveFactorBps,
      supplyCapWhole: cfg.supplyCapWhole,
      borrowCapWhole: cfg.borrowCapWhole,
      totalSupplied,
      storedLiquidityRateRay: rd.currentLiquidityRate,
      storedVariableBorrowRateRay: rd.currentVariableBorrowRate,
      lastUpdateTimestamp: BigInt(rd.lastUpdateTimestamp),
    }

    if (def.protocol === 'aave-v3') {
      // v3.4+ keeps one strategy on the Pool; the per-reserve field is the fallback.
      let strategy = rd.interestRateStrategyAddress
      try {
        strategy = await read<`0x${string}`>(def.pool, poolAbi, 'RESERVE_INTEREST_RATE_STRATEGY')
      } catch {
        // pre-3.4 pool: the reserve's own field is authoritative
      }
      const [bps, vub] = await Promise.all([
        read<{ optimalUsageRatio: number; baseVariableBorrowRate: number; variableRateSlope1: number; variableRateSlope2: number }>(
          strategy,
          aaveStrategyV2Abi,
          'getInterestRateDataBps',
          [def.asset.address],
        ),
        read<bigint>(def.pool, poolAbi, 'getVirtualUnderlyingBalance', [def.asset.address]),
      ])
      return {
        ...base,
        irm: {
          model: 'aave-rate-strategy-v2',
          strategy,
          optimalUsageRatioBps: BigInt(bps.optimalUsageRatio),
          baseVariableBorrowRateBps: BigInt(bps.baseVariableBorrowRate),
          variableRateSlope1Bps: BigInt(bps.variableRateSlope1),
          variableRateSlope2Bps: BigInt(bps.variableRateSlope2),
        },
        state: { kind: 'aave-virtual', virtualUnderlyingBalance: vub, totalDebt, ...common },
      }
    }

    const strategy = rd.interestRateStrategyAddress
    const [baseRate, slope1, slope2, optimal, availableLiquidity] = await Promise.all([
      read<bigint>(strategy, sparkStrategyAbi, 'getBaseVariableBorrowRate'),
      read<bigint>(strategy, sparkStrategyAbi, 'getVariableRateSlope1'),
      read<bigint>(strategy, sparkStrategyAbi, 'getVariableRateSlope2'),
      read<bigint>(strategy, sparkStrategyAbi, 'OPTIMAL_USAGE_RATIO'),
      read<bigint>(def.asset.address, erc20Abi, 'balanceOf', [rd.aTokenAddress]),
    ])
    return {
      ...base,
      irm: {
        model: 'spark-variable-borrow',
        strategy,
        optimalUsageRatioRay: optimal,
        baseVariableBorrowRateRay: baseRate,
        variableRateSlope1Ray: slope1,
        variableRateSlope2Ray: slope2,
      },
      state: { kind: 'spark', availableLiquidity, totalVariableDebt: totalDebt, ...common },
    }
  }

  if (def.protocol === 'morpho-blue') {
    const [m, p] = await Promise.all([
      read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(MORPHO_BLUE, morphoAbi, 'market', [def.marketId]),
      read<readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint]>(MORPHO_BLUE, morphoAbi, 'idToMarketParams', [def.marketId]),
    ])
    if (lower(p[0]) !== lower(def.asset.address)) throw new Error(`${def.venueKey}: loanToken ${p[0]} != registry ${def.asset.address}`)
    if (lower(p[3]) !== lower(MORPHO_ADAPTIVE_CURVE_IRM)) throw new Error(`${def.venueKey}: irm ${p[3]} is not AdaptiveCurveIrm`)
    const rateAtTarget = await read<bigint>(p[3], adaptiveCurveIrmAbi, 'rateAtTarget', [def.marketId])
    return {
      ...base,
      irm: { model: 'morpho-adaptive-curve', irm: p[3], rateAtTarget },
      state: {
        kind: 'morpho-market',
        marketId: def.marketId,
        loanToken: p[0],
        collateralToken: p[1],
        oracle: p[2],
        lltv: p[4],
        totalSupplyAssets: m[0],
        totalSupplyShares: m[1],
        totalBorrowAssets: m[2],
        totalBorrowShares: m[3],
        lastUpdate: m[4],
        fee: m[5],
      },
    }
  }

  if (def.protocol !== 'euler-v2') throw new Error(`${def.venueKey}: no reader for protocol '${def.protocol}'`)
  const [assetAddr, cash, totalBorrows, interestFee, interestRate, irmAddr] = await Promise.all([
    read<`0x${string}`>(def.vault, eulerVaultAbi, 'asset'),
    read<bigint>(def.vault, eulerVaultAbi, 'cash'),
    read<bigint>(def.vault, eulerVaultAbi, 'totalBorrows'),
    read<number>(def.vault, eulerVaultAbi, 'interestFee'),
    read<bigint>(def.vault, eulerVaultAbi, 'interestRate'),
    read<`0x${string}`>(def.vault, eulerVaultAbi, 'interestRateModel'),
  ])
  if (lower(assetAddr) !== lower(def.asset.address)) throw new Error(`${def.venueKey}: asset ${assetAddr} != registry ${def.asset.address}`)
  // A vault on any other IRM fails one of these four reads and is reported, not modelled.
  const [baseRate, slope1, slope2, kink] = await Promise.all([
    read<bigint>(irmAddr, eulerKinkAbi, 'baseRate'),
    read<bigint>(irmAddr, eulerKinkAbi, 'slope1'),
    read<bigint>(irmAddr, eulerKinkAbi, 'slope2'),
    read<bigint>(irmAddr, eulerKinkAbi, 'kink'),
  ])
  return {
    ...base,
    irm: { model: 'euler-linear-kink', irm: irmAddr, baseRate, slope1, slope2, kink },
    state: { kind: 'euler-vault', cash, totalBorrows, interestFee: BigInt(interestFee), storedInterestRateSpy: interestRate },
  }
}

export interface SnapshotSet {
  anchor: BlockAnchor
  rpc: string
  snapshots: VenueSnapshot[]
  errors: { venueKey: string; message: string }[]
}

/** Reads every venue at one anchor. Never rejects on a venue failure. */
export async function readAllVenues(
  client: PublicClient,
  defs: readonly VenueDef[],
  rpc: string,
  blockNumber?: bigint,
): Promise<SnapshotSet> {
  const anchor = await resolveAnchor(client, blockNumber)
  const results = await Promise.all(
    defs.map(async (d) => {
      try {
        return { ok: true as const, snap: await readVenueSnapshot(client, d, anchor, rpc) }
      } catch (e) {
        return { ok: false as const, venueKey: d.venueKey, message: redactError(e) }
      }
    }),
  )
  return {
    anchor,
    rpc,
    snapshots: results.flatMap((r) => (r.ok ? [r.snap] : [])),
    errors: results.flatMap((r) => (r.ok ? [] : [{ venueKey: r.venueKey, message: r.message }])),
  }
}
