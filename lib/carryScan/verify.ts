/**
 * S5/S6 ADDRESS RESOLUTION and ON-CHAIN VERIFICATION, all at one finalized anchor.
 *
 * Resolve (DeFiLlama pool UUIDs are never addresses):
 *   - hand-kept ./poolAddresses.json (UUID → address, kind, verifiedAt) wins;
 *   - Aave v3 Core/Prime and SparkLend: Pool.getReserveData(asset).aToken;
 *   - MetaMorpho / Morpho Vault V2: Morpho GraphQL, by asset + symbol (TVL breaks a tie);
 *   - anything else is unresolved and listed as Unverified.
 *
 * Checks on each resolved address:
 *   - code exists at the anchor;
 *   - the deposit asset equals the stable's address from ./stables.json
 *     (aToken.UNDERLYING_ASSET_ADDRESS(), else ERC-4626 asset());
 *   - supplied value at $1 within ±15% of DeFiLlama's (lendBorrow totalSupplyUsd for a
 *     lending row, whose /pools tvlUsd is supply − borrow; tvlUsd otherwise);
 *   - ERC-4626 vaults: trailing 7-day convertToAssets growth between the anchor and the block
 *     50,400 blocks earlier, annualised over the span their block timestamps give (missed slots
 *     make it longer than 7 days); more than 1pp from apyBase7d marks "source disagreement"
 *     (a flag, not a fail).
 * An LP pool is checked for code only (no asset/TVL getter in common).
 */

import { getAddress, type PublicClient } from 'viem'

import { netBreakdown, type NetBreakdown } from '../netApy/breakdown'
import { poolAbi } from '../netApy/read'
import type { AssetRef, BlockAnchor } from '../netApy/types'
import { AAVE_V3_POOL, SPARK_POOL, type VenueDef } from '../netApy/venues'
import type { IncentiveCampaign } from '../netApy/incentives'
import { serialize } from '../netApy/service'
import { keyOf } from './onApp'
import {
  SCAN_SIZES_USD,
  sizeKeyOf,
  THRESHOLDS,
  type Candidate,
  type MorphoVaultInfo,
  type PoolAddressEntry,
  type ScoutKind,
  type SizeKey,
  type StableEntry,
  type Verification,
} from './types'

/** Aave v3 Lido ("Prime") pool. Read back 2026-10-10 at block 26,163,743:
 *  getReserveData(USDC).aToken = aEthLidoUSDC, getReserveData(GHO).aToken = aEthLidoGHO. */
export const AAVE_V3_PRIME_POOL = '0x4e033931ad43597d96D6bcc25c280717730B58B1' as const

const lc = (s: string | null | undefined): string => String(s ?? '').toLowerCase()
const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

export interface Resolved {
  address: string
  kind: ScoutKind
  via: 'poolAddresses.json' | 'aave getReserveData' | 'morpho graphql'
  /** Aave/Spark: the Pool the reserve lives in (DeploymentVault venueData). */
  aavePool?: string
  withdraw?: 'instant' | 'queued'
}

export type Resolution = Resolved | { address: null; reason: string }

/** The Aave-like Pool a DeFiLlama row lives in, or null. */
export function aavePoolOf(
  c: Candidate,
): { pool: string; kind: 'aave-reserve' | 'spark-reserve' } | null {
  const p = c.pool
  if (c.exposure !== 'single' || c.stables.length !== 1) return null
  // The reserve row's symbol is the asset itself. Aave's sGHO savings row ("SGHO", underlying
  // GHO) is not the GHO reserve: the dry run of 2026-10-10 resolved it to aEthGHO and only
  // the TVL check caught it.
  if (norm(p.symbol) !== norm(c.stables[0].symbol)) return null
  if (p.project === 'aave-v3' && p.poolMeta === null)
    return { pool: AAVE_V3_POOL, kind: 'aave-reserve' }
  if (p.project === 'aave-v3' && p.poolMeta === 'Prime Instance')
    return { pool: AAVE_V3_PRIME_POOL, kind: 'aave-reserve' }
  if (p.project === 'sparklend' && p.poolMeta === null)
    return { pool: SPARK_POOL, kind: 'spark-reserve' }
  return null
}

/** Morpho vault for a DeFiLlama Morpho vault row: same asset and symbol; TVL within 15% breaks a tie. */
export function matchMorphoVault(
  c: Candidate,
  vaults: readonly MorphoVaultInfo[],
): MorphoVaultInfo | { ambiguous: number } | null {
  if (c.exposure !== 'single' || c.stables.length !== 1) return null
  const asset = lc(c.stables[0].address)
  const sym = norm(c.pool.symbol)
  const hits = vaults.filter((v) => lc(v.assetAddress) === asset && norm(v.symbol) === sym)
  if (hits.length <= 1) return hits[0] ?? null
  const close = hits.filter(
    (v) =>
      v.totalAssetsUsd !== null &&
      Math.abs(v.totalAssetsUsd - c.pool.tvlUsd) / c.pool.tvlUsd <= THRESHOLDS.tvlTolerance,
  )
  return close.length === 1 ? close[0] : { ambiguous: hits.length }
}

export async function resolveAddress(
  c: Candidate,
  ctx: {
    poolAddresses: Record<string, PoolAddressEntry>
    morphoVaults: readonly MorphoVaultInfo[]
    aTokenOf: (pool: string, asset: string) => Promise<string | null>
  },
): Promise<Resolution> {
  const hand = ctx.poolAddresses[c.pool.pool]
  const queued = hand?.withdraw === 'queued' || /unstak|cooldown/i.test(c.pool.poolMeta ?? '')
  if (hand)
    return {
      address: lc(hand.address),
      kind: hand.kind,
      via: 'poolAddresses.json',
      withdraw: queued ? 'queued' : hand.withdraw,
    }
  const aave = aavePoolOf(c)
  if (aave) {
    const a = await ctx.aTokenOf(aave.pool, c.stables[0].address)
    return a
      ? { address: lc(a), kind: aave.kind, via: 'aave getReserveData', aavePool: aave.pool }
      : { address: null, reason: 'reserve not listed in the Pool (aToken = 0)' }
  }
  if (c.pool.project === 'morpho-blue') {
    const m = matchMorphoVault(c, ctx.morphoVaults)
    if (m && 'address' in m)
      return {
        address: lc(m.address),
        kind: m.version === 'v2' ? 'morpho-vault-v2' : 'metamorpho',
        via: 'morpho graphql',
      }
    if (m && 'ambiguous' in m)
      return {
        address: null,
        reason: `${m.ambiguous} listed Morpho vaults share this asset and symbol`,
      }
    return { address: null, reason: 'no listed Morpho vault with this asset and symbol' }
  }
  return {
    address: null,
    reason: `no address resolver for ${c.pool.project}; add the pool to lib/carryScan/poolAddresses.json`,
  }
}

// ----------------------------------------------------------------- on-chain checks

const vaultAbi = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'UNDERLYING_ASSET_ADDRESS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

/** Blocks in 7 days at 12 s slots, with no missed slot. The real span is read from timestamps. */
export const BLOCKS_7D = 50_400n
const SECONDS_7D = 7 * 86_400
const SECONDS_YEAR = 365 * 86_400

export interface VerifyInput {
  address: string
  kind: ScoutKind
  stable: StableEntry | null
  /** DeFiLlama's supplied value: lendBorrow totalSupplyUsd for lending rows, else tvlUsd. */
  suppliedUsd: number
  /** DeFiLlama apyBase7d in percent, for the trailing-growth cross-check. */
  apyBase7dPct: number | null
  /**
   * DeFiLlama's base APY in percent: the cross-check's reference when apyBase7d is absent,
   * which on 2026-10-10 was every ranked row (apyBase7d was numeric for 167 of 1,315 pools).
   */
  apyBasePct?: number | null
}

/** Pure check of the TVL tolerance. */
export const withinTvl = (onchainUsd: number, reportedUsd: number): boolean =>
  reportedUsd > 0 && Math.abs(onchainUsd - reportedUsd) / reportedUsd <= THRESHOLDS.tvlTolerance

/**
 * Trailing APY from two share prices `elapsedSec` apart (7 days by default), compounded over a
 * 365-day year. 2026-10-11: the 50,400 blocks behind the anchor spanned 7.025 days, and a
 * nominal 7 days overstated the figure by about 0.02pp at 5.6%.
 */
export const trailing7dApy = (
  pricePrev: bigint,
  priceNow: bigint,
  elapsedSec: number = SECONDS_7D,
): number | null =>
  pricePrev > 0n && Number.isFinite(elapsedSec) && elapsedSec > 0
    ? (Number(priceNow) / Number(pricePrev)) ** (SECONDS_YEAR / elapsedSec) - 1
    : null

export async function verifyOnChain(
  client: PublicClient,
  anchor: BlockAnchor,
  v: VerifyInput,
): Promise<Verification & { sourceDisagreement: boolean }> {
  const blockNumber = anchor.blockNumber
  const address = getAddress(v.address)
  const checks: string[] = []
  const fail = (failed: string) => ({ ok: false, checks, failed, sourceDisagreement: false })
  // One untyped door into viem's readContract: the ABI is local and every call site names its return type.
  const readContract = client.readContract as unknown as (p: {
    address: `0x${string}`
    abi: typeof vaultAbi
    functionName: string
    args: readonly unknown[]
    blockNumber: bigint
  }) => Promise<unknown>
  const read = async <T>(
    fn: (typeof vaultAbi)[number]['name'],
    args: readonly unknown[] = [],
    at: bigint = blockNumber,
  ): Promise<T> =>
    (await readContract({ address, abi: vaultAbi, functionName: fn, args, blockNumber: at })) as T

  try {
    const code = await client.getCode({ address, blockNumber })
    if (!code || code === '0x') return fail('no contract code at the anchor')
    checks.push('code')
    if (v.kind === 'lp' || v.kind === 'compound' || v.kind === 'other')
      return { ok: true, checks, sourceDisagreement: false }
    if (!v.stable) return fail('stable not resolved')
    const dec = v.stable.decimals

    if (v.kind === 'aave-reserve' || v.kind === 'spark-reserve') {
      const under = await read<string>('UNDERLYING_ASSET_ADDRESS')
      if (lc(under) !== lc(v.stable.address))
        return fail(`aToken underlying ${under} is not ${v.stable.symbol}`)
      checks.push('asset')
      const supplied = Number(await read<bigint>('totalSupply')) / 10 ** dec
      if (!withinTvl(supplied, v.suppliedUsd))
        return fail(
          `aToken supply $${Math.round(supplied).toLocaleString('en-US')} is not within ±15% of DeFiLlama's $${Math.round(v.suppliedUsd).toLocaleString('en-US')}`,
        )
      checks.push('tvl')
      return { ok: true, checks, sourceDisagreement: false }
    }

    const asset = await read<string>('asset')
    if (lc(asset) !== lc(v.stable.address))
      return fail(`asset() ${asset} is not ${v.stable.symbol}`)
    checks.push('asset')
    const total = Number(await read<bigint>('totalAssets')) / 10 ** dec
    if (!withinTvl(total, v.suppliedUsd))
      return fail(
        `totalAssets $${Math.round(total).toLocaleString('en-US')} is not within ±15% of DeFiLlama's $${Math.round(v.suppliedUsd).toLocaleString('en-US')}`,
      )
    checks.push('tvl')

    let trailing: number | null = null
    let trailingError: string | undefined
    let disagree = false
    try {
      const shareDec = Number(await read<number>('decimals'))
      const one = 10n ** BigInt(shareDec)
      const prevBlock = blockNumber - BLOCKS_7D
      const [now, prev, prevHeader] = await Promise.all([
        read<bigint>('convertToAssets', [one]),
        read<bigint>('convertToAssets', [one], prevBlock),
        client.getBlock({ blockNumber: prevBlock }),
      ])
      // Annualise over the blocks' real span: missed slots make 50,400 blocks longer than 7 days.
      const elapsed = Number(anchor.blockTimestamp - prevHeader.timestamp)
      if (!(elapsed > 0)) throw new Error(`block ${prevBlock} is not older than the anchor`)
      trailing = trailing7dApy(prev, now, elapsed)
      const seven = v.apyBase7dPct !== null && Number.isFinite(v.apyBase7dPct)
      const ref = seven ? v.apyBase7dPct : (v.apyBasePct ?? null)
      if (trailing !== null && ref !== null && Number.isFinite(ref)) {
        disagree = Math.abs(trailing * 100 - ref) > THRESHOLDS.sourceDisagreementPp
        checks.push(seven ? 'trailing-7d vs apyBase7d' : 'trailing-7d vs base APY')
      } else {
        checks.push('trailing-7d')
      }
    } catch (e) {
      // A vault younger than 7 days, or an RPC without archive state: no cross-check, not a
      // failure of the row. The averaged venue APY lists the source as failed, with this reason.
      trailingError = `7-day share-price read failed: ${oneLine(e)}`
    }
    return {
      ok: true,
      checks,
      trailing7dApy: trailing,
      ...(trailingError ? { trailing7dError: trailingError } : {}),
      sourceDisagreement: disagree,
    }
  } catch (e) {
    return fail(`read failed: ${oneLine(e)}`)
  }
}

/** First line of an error, RPC URLs redacted, at most 160 characters. */
const oneLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e))
    .split('\n')[0]
    .replace(/https?:\/\/\S+/g, '[rpc]')
    .slice(0, 160)

export async function aTokenOfAt(
  client: PublicClient,
  anchor: BlockAnchor,
  pool: string,
  asset: string,
): Promise<string | null> {
  const rd = (await client.readContract({
    address: getAddress(pool),
    abi: poolAbi,
    functionName: 'getReserveData',
    args: [getAddress(asset)],
    blockNumber: anchor.blockNumber,
  })) as { aTokenAddress: string }
  return /^0x0{40}$/i.test(rd.aTokenAddress) ? null : rd.aTokenAddress
}

// ----------------------------------------------------------- on-chain pricing

/** A VenueDef for a lending-market candidate, keyed by the SCOUT key (never a registry venue key). */
export function venueDefFor(r: {
  address: string
  kind: ScoutKind
  aavePool?: string | null
  stable: StableEntry
  label: string
}): VenueDef | null {
  const asset: AssetRef = {
    address: getAddress(r.stable.address),
    symbol: r.stable.symbol,
    decimals: r.stable.decimals,
    usdPriceAssumption: 1,
  }
  const venueKey = keyOf(r.address)
  if ((r.kind === 'aave-reserve' || r.kind === 'spark-reserve') && r.aavePool) {
    return {
      venueKey,
      label: r.label,
      asset,
      protocol: r.kind === 'spark-reserve' ? 'spark' : 'aave-v3',
      pool: getAddress(r.aavePool),
    }
  }
  if (r.kind === 'euler')
    return { venueKey, label: r.label, asset, protocol: 'euler-v2', vault: getAddress(r.address) }
  return null
}

/** Supply breakdowns at every scan size, and the serialized one at the default size. */
export function supplyBreakdowns(
  snap: Parameters<typeof netBreakdown>[0],
  campaigns: readonly IncentiveCampaign[],
  nowTs: number,
): { bySize: Record<SizeKey, NetBreakdown>; serialized: unknown } {
  const bySize = {} as Record<SizeKey, NetBreakdown>
  for (const size of SCAN_SIZES_USD)
    bySize[sizeKeyOf(size)] = netBreakdown(snap, {
      side: 'supply',
      sizeUsd: size,
      campaigns,
      nowTs,
    })
  return { bySize, serialized: stripVenueKeys(serialize(bySize['100k'])) }
}

/** Removes every `venueKey` field: scout output must carry nothing that reads as a registry venue key. */
export function stripVenueKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripVenueKeys) as T
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      if (k !== 'venueKey') out[k] = stripVenueKeys(x)
    return out as T
  }
  return v
}
