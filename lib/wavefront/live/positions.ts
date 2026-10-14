/**
 * Positions in the live engine: from a liquidation's re-read to the census's `open` record, its
 * `real` records and its Membrane kernels — built with the SAME pieces the Oct 10-11 census uses
 * (scripts/oct10-coverage/census.ts), field for field:
 *
 *   spec      lib/wavefront/aave.ts `aavePositionSpec` / lib/wavefront/morpho.ts
 *             `morphoPositionSpec` (composition, line, LTV0, delay class, the mixed split)
 *   open      the census's open record (cluster from the primary collateral leg)
 *   real      `aaveRealUsd` / `morphoRealUsd` (block-N protocol-oracle prices)
 *   kernels   one `MembraneKernel` per half, the census's parameters
 *
 * ONE DIFFERENCE BY CONSTRUCTION. The census sees a position's whole window, so when its FIRST
 * event is not located (HF at N >= 1) and a LATER one is, it anchors t0 at the later one (one
 * account on Oct 10-11). A live stream cannot look ahead and the schema allows one `open` per
 * pid: such a position opens `walked: false` at its first event and its later events are real
 * records only.
 *
 * Kernels are serialized for the durable state by snapshotting their fields (kernel.ts and
 * DelayTimer keep plain TypeScript-private fields); `restoreKernel` refuses a snapshot whose
 * field set no longer matches a fresh kernel (the kernel changed under a saved state).
 */
import {
  BORROW_LTV_GAP,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
} from '../../position-sim/membrane'
import { heldAtOne } from '../../position-sim/collateralClass'
import { DELAY_STEPS, MAX_SALES } from '../../../scripts/oct10-coverage/census'
import {
  AAVE_PRICE_UNIT,
  aavePositionSpec,
  aaveRealUsd,
  kernelLegs,
  pathAnchors,
  streamLegs,
  type AaveEventRecord,
  type PositionSpec,
} from '../aave'
import { clusterAssigner, primarySymbol } from '../cluster'
import { MembraneKernel, type KernelLeg, type KernelSpec } from '../kernel'
import { morphoPositionSpec, morphoRealUsd, type MorphoEventRecord } from '../morpho'
import { aavePid } from '../pid'
import { roundUsd, type OpenRecord, type RealRecord } from '../stream'
import { normUnits, type AaveLiquidation, type MorphoLiquidation } from './codec'

/**
 * How a position's unit converts to USD (Aave: USD; Morpho: its loan token — held at $1, or the
 * Core market's AaveOracle price of the token on the same chain at the minute: `key` is that
 * price's MinutePrices key, or unpriced).
 */
export type UsdMode =
  | { kind: 'usd' }
  | { kind: 'stable' }
  | { kind: 'aave'; key: string }
  | { kind: 'none' }

export interface WindowParams {
  startTs: number
  stepSeconds: number
}

export interface KernelParams {
  /** Last grid minute (the census's grid end). Live: no grid end. */
  lastMinute: number
  walkOnAfterT0BandSale?: boolean
}

export const NO_GRID_END = Number.MAX_SAFE_INTEGER

/**
 * The census's loan-token USD rule: held at $1, else the (Core) AaveOracle path, else unpriced.
 * `coreKey` is the MinutePrices key of the token on the Core oracle, or null when it is not a
 * Core reserve.
 */
export function morphoUsdMode(loanSymbol: string, coreKey: string | null): UsdMode {
  if (heldAtOne(loanSymbol)) return { kind: 'stable' }
  if (coreKey) return { kind: 'aave', key: coreKey }
  return { kind: 'none' }
}

/** USD per position unit at a minute, from a minute-price lookup (raw AaveOracle strings). */
export function usdPerUnitFn(
  mode: UsdMode,
  price: (minute: number, key: string) => string | null | undefined,
  baseUnit: number,
): (minute: number) => number | null {
  switch (mode.kind) {
    case 'usd':
      return () => 1
    case 'stable':
      return () => 1
    case 'none':
      return () => null
    case 'aave':
      return (minute) => {
        const v = price(minute, mode.key)
        if (v === undefined) throw new Error(`USD ${mode.key} at minute ${minute} was not read`)
        const x = v == null ? NaN : Number(v)
        return Number.isFinite(x) && x > 0 ? x / baseUnit : null
      }
  }
}

/** The census's Aave spec, with the pool-qualified pid (lib/wavefront/pid.ts). */
export function aaveSpec(read: AaveEventRecord, w: WindowParams, pool: string): PositionSpec {
  const s = aavePositionSpec([read], {
    startTs: w.startTs,
    stepSeconds: w.stepSeconds,
    debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
  })
  return { ...s, pid: aavePid(s.chain, pool, s.owner) }
}

export function morphoSpec(
  read: MorphoEventRecord,
  sym: { collateral: string; loan: string },
  loanUsd: (minute: number) => number | null,
  w: WindowParams,
): PositionSpec {
  return morphoPositionSpec([read], {
    startTs: w.startTs,
    stepSeconds: w.stepSeconds,
    debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
    collateralSymbol: sym.collateral,
    loanSymbol: sym.loan,
    loanUsd,
  })
}

/** The census's cluster rule with a fixed own-cluster list (a live stream cannot count ahead). */
export function clusterFn(ownClusters: readonly string[]): (spec: PositionSpec) => string {
  // clusterAssigner gives a symbol its own cluster at >= N primary legs; feeding each own
  // symbol N times reproduces the census's assigner for exactly that list.
  const seed: string[] = []
  for (const s of ownClusters) for (let i = 0; i < 20; i++) seed.push(s)
  const { clusterOf } = clusterAssigner(seed, 20)
  return (spec) => clusterOf(primarySymbol(spec.collateral))
}

/** The census's open record for a spec (scripts/oct10-coverage/census.ts). */
export function openRecordOf(s: PositionSpec, cluster: string): OpenRecord {
  const walked = s.located && !!s.t0 && s.halves.length > 0
  const open: OpenRecord = {
    kind: 'open',
    seq: 0,
    pid: s.pid,
    protocol: s.protocol,
    chain: s.chain,
    block: s.first.block,
    ts: s.first.ts,
    legs: streamLegs(s.collateral),
    debtLegs: streamLegs(s.debt),
    debtUsd: s.debtUsd,
    collUsd: s.collUsd,
    line: s.line,
    ltv0: s.ltv0,
    delayClass: s.delayClass,
    cluster,
    walked,
  }
  if (!walked) open.reason = s.reason ?? 'not walked'
  if (walked && s.t0) open.t0 = { block: s.t0.block, ts: s.t0.ts, minute: s.t0.minute }
  if (walked && s.halves.length > 1) {
    open.subs = s.halves.map((h) => ({
      sub: h.sub as number,
      delayClass: h.delayClass,
      line: h.line,
      share: h.share,
      collUsd: s.collUsd == null ? null : s.collUsd * h.share,
      debtUsd: s.debtUsd == null ? null : s.debtUsd * h.share,
    }))
  }
  return open
}

export const isWalked = (s: PositionSpec) => s.located && !!s.t0 && s.halves.length > 0

/** Kernel specs of a walked position, the census's parameters (usdPerUnit attached later). */
export function kernelSpecs(
  s: PositionSpec,
  w: WindowParams,
  k: KernelParams,
): Omit<KernelSpec, 'usdPerUnit'>[] {
  if (!isWalked(s)) return []
  return s.halves.map((h) => {
    const legs = kernelLegs(s, h)
    return {
      pid: s.pid,
      ...(h.sub !== undefined ? { sub: h.sub } : {}),
      collateral: legs.collateral,
      debt: legs.debt,
      line: h.line,
      noDelay: h.delayClass === 'no-delay',
      band: MAX_THRESHOLD_TO_DELAY,
      delaySteps: DELAY_STEPS,
      gap: BORROW_LTV_GAP,
      debtMinimum: s.debtMinimum,
      maxSales: MAX_SALES,
      t0Minute: s.t0!.minute,
      t0Ts: s.t0!.ts,
      startTs: w.startTs,
      stepSeconds: w.stepSeconds,
      lastMinute: k.lastMinute,
      ...(k.walkOnAfterT0BandSale !== undefined
        ? { walkOnAfterT0BandSale: k.walkOnAfterT0BandSale }
        : {}),
    }
  })
}

/** Path keys and anchors a walked position reads every minute. */
export function pathKeys(s: PositionSpec): { anchors: Record<string, number>; keys: string[] } {
  const m = pathAnchors(s)
  return { anchors: Object.fromEntries(m), keys: [...m.keys()] }
}

/** The census's leg ratio: Number(price(m)) / p0, null when unobserved. Key '' never moves. */
export function legRatio(
  leg: KernelLeg,
  anchors: Record<string, number>,
  price: (key: string) => string | null | undefined,
): number | null {
  if (!leg.key) return 1
  const raw = price(leg.key)
  const v = raw == null ? NaN : Number(raw)
  const p0 = anchors[leg.key]
  return Number.isFinite(v) && v > 0 && p0 > 0 ? v / p0 : null
}

// ------------------------------------------------------------------ real side

/** A real record of the live stream: Aave carries the protocol fee inside seizedUsd. */
export type LiveRealRecord = RealRecord & { protocolFeeUsd?: number | null }

/**
 * One Aave LiquidationCall in USD at block-N AaveOracle prices (census rule). SEIZED is what
 * left the borrower: the liquidator's share (the event amount) PLUS the protocol fee
 * (`protocolFeeRaw`, aaveRead.ts `aaveProtocolFee`); `protocolFeeUsd` is the fee alone, so
 * seizedUsd - protocolFeeUsd is the census's (liquidator-share) figure.
 */
export function aaveRealRecord(
  ev: AaveLiquidation,
  read: AaveEventRecord | undefined,
  decimals: { debt: number; collateral: number },
  fallbackUsd: (asset: string) => number | null,
  protocolFeeRaw = 0n,
): LiveRealRecord {
  const row = (collateralRaw: bigint) => ({
    chain: ev.chain,
    block_number: ev.block,
    ts: ev.ts,
    tx_hash: ev.tx,
    log_index: ev.logIndex,
    user: ev.user,
    collateral_asset: ev.collateralAsset,
    debt_asset: ev.debtAsset,
    debt_to_cover_normalized: String(normUnits(ev.debtToCover, decimals.debt)),
    liquidated_collateral_normalized: String(normUnits(collateralRaw, decimals.collateral)),
  })
  const L = BigInt(ev.liquidatedCollateralAmount)
  const r = aaveRealUsd(row(L + protocolFeeRaw), read, fallbackUsd)
  const fee = aaveRealUsd(row(protocolFeeRaw), read, fallbackUsd)
  return {
    kind: 'real',
    seq: 0,
    pid: ev.pid,
    ts: ev.ts,
    block: ev.block,
    tx: ev.tx,
    logIndex: ev.logIndex,
    repaidUsd: r.repaidUsd,
    seizedUsd: r.seizedUsd,
    protocolFeeUsd: roundUsd(fee.seizedUsd),
  }
}

/** One Morpho Liquidate in USD: loan USD at the event minute, seized at the event's price(N). */
export function morphoRealRecord(
  ev: MorphoLiquidation,
  read: MorphoEventRecord,
  loanUsdAtEvent: number | null,
): RealRecord {
  const r = morphoRealUsd(
    {
      chain: ev.chain,
      block_number: ev.block,
      ts: ev.ts,
      tx_hash: ev.tx,
      log_index: ev.logIndex,
      market_id: ev.marketId,
      borrower: ev.borrower,
      repaid_assets_normalized: String(normUnits(ev.repaidAssets, read.loanDecimals)),
      seized_assets: ev.seizedAssets,
      bad_debt_assets_normalized: String(normUnits(ev.badDebtAssets, read.loanDecimals)),
      collateral_symbol: '',
      loan_symbol: '',
    },
    read,
    loanUsdAtEvent,
  )
  return {
    kind: 'real',
    seq: 0,
    pid: ev.pid,
    ts: ev.ts,
    block: ev.block,
    tx: ev.tx,
    logIndex: ev.logIndex,
    repaidUsd: r.repaidUsd,
    seizedUsd: r.seizedUsd,
    badDebtUsd: r.badDebtUsd,
  }
}

export const aaveUsdOf = (raw: string | null | undefined, baseUnit = AAVE_PRICE_UNIT) => {
  const x = raw == null ? NaN : Number(raw)
  return Number.isFinite(x) && x > 0 ? x / baseUnit : null
}

// ------------------------------------------------------------------ kernel snapshots

export interface KernelSnapshot {
  fields: Record<string, unknown>
  timer: Record<string, unknown>
}

/** Fields rebuilt from the spec by the constructor; not part of a snapshot. */
const DERIVED = new Set(['spec', 'timer', 'params'])

export function snapshotKernel(k: MembraneKernel): KernelSnapshot {
  const fields: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(k)) {
    if (DERIVED.has(key)) continue
    fields[key] = Array.isArray(v) ? [...v] : v && typeof v === 'object' ? { ...v } : v
  }
  const timer = (k as unknown as { timer: object }).timer
  return { fields, timer: { ...(timer as Record<string, unknown>) } }
}

export class KernelSchemaChanged extends Error {}

export function restoreKernel(spec: KernelSpec, snap: KernelSnapshot): MembraneKernel {
  const k = new MembraneKernel(spec)
  const want = Object.keys(k).filter((x) => !DERIVED.has(x)).sort()
  const have = Object.keys(snap.fields).sort()
  if (want.join() !== have.join())
    throw new KernelSchemaChanged(
      `kernel fields changed: saved [${have.join(', ')}], now [${want.join(', ')}]`,
    )
  const timer = (k as unknown as { timer: Record<string, unknown> }).timer
  const wantT = Object.keys(timer).sort()
  const haveT = Object.keys(snap.timer).sort()
  if (wantT.join() !== haveT.join())
    throw new KernelSchemaChanged(
      `DelayTimer fields changed: saved [${haveT.join(', ')}], now [${wantT.join(', ')}]`,
    )
  for (const [key, v] of Object.entries(snap.fields))
    (k as unknown as Record<string, unknown>)[key] = Array.isArray(v) ? [...v] : v
  for (const [key, v] of Object.entries(snap.timer)) timer[key] = v
  return k
}
