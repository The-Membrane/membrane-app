/**
 * Curator profile logic — pure, no I/O. Formatting of CuratorRegistry reads, the
 * event → history-row mapping, bucket labels, and the provenance stamp text.
 *
 * Units (contracts/CuratorRegistry.sol, membrane-solidity feat/ltv-change-cap):
 *   bondOf / aumCap / trackedAum / trailingPayments / event amounts — CDT wei (18 dp)
 *   rampOf                 — WAD fraction of the 90-day clock (1e18 = complete)
 *   realizedRate / rateWad — WAD per year (1e18 = 100%/yr)
 *   lossRatioWad           — WAD fraction (1e18 = 100%)
 *   bucketOf               — realizedRate / 5e15, clamped to 2000
 */

export const WAD = 10n ** 18n
export const CDT_DECIMALS = 18
/** CuratorRegistry.BUCKET_WIDTH_WAD — 0.5% per bucket. */
export const BUCKET_WIDTH_WAD = 5n * 10n ** 15n
/** CuratorRegistry.MAX_BUCKET_INDEX. */
export const MAX_BUCKET_INDEX = 2000n
/** CuratorRegistry.RAMP_DURATION_S — 90 days. */
export const RAMP_DURATION_DAYS = 90
/** CuratorRegistry NO_BUCKET sentinel == type(uint256).max. */
export const NO_BUCKET = 2n ** 256n - 1n
export const LOCAL_CHAIN_ID = 31337

// ── number formatting ─────────────────────────────────────────────────────────

const group = (s: string): string => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * Fixed-point bigint → decimal string, exact (no float), truncated to `maxFrac`
 * places with trailing zeros trimmed. Thousands grouped.
 */
export function formatUnitsFixed(value: bigint, decimals = CDT_DECIMALS, maxFrac = 2): string {
  const neg = value < 0n
  const abs = neg ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFrac)
  frac = frac.replace(/0+$/, '')
  const out = frac ? `${group(whole.toString())}.${frac}` : group(whole.toString())
  return neg ? `-${out}` : out
}

/** CDT wei → "1,234.5 CDT". */
export const formatCdt = (wei: bigint, maxFrac = 2): string => `${formatUnitsFixed(wei, CDT_DECIMALS, maxFrac)} CDT`

/** WAD fraction → percent string, e.g. 5e16 → "5.00%". Exact to `dp` places (truncated). */
export function formatWadPct(wad: bigint, dp = 2): string {
  // percent × 10^dp = wad × 100 × 10^dp / 1e18
  const scaled = (wad * 100n * 10n ** BigInt(dp)) / WAD
  const whole = scaled / 10n ** BigInt(dp)
  const frac = (scaled % 10n ** BigInt(dp)).toString().padStart(dp, '0')
  return dp > 0 ? `${group(whole.toString())}.${frac}%` : `${group(whole.toString())}%`
}

/** rampOf → days elapsed on the 90-day clock (floored). */
export const rampDays = (ramp: bigint): number => Number((ramp * BigInt(RAMP_DURATION_DAYS)) / WAD)

export const shortAddress = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/** Unix seconds → "2026-09-25 14:03 UTC". */
export function formatBlockTime(ts: bigint | number): string {
  const d = new Date(Number(ts) * 1000)
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// ── figures with explicit empty states ────────────────────────────────────────

/** A rendered figure. `empty` = the chain value was zero and `text` says so in words. */
export interface Figure {
  text: string
  empty: boolean
}

const fig = (text: string, empty = false): Figure => ({ text, empty })

export const bondFigure = (bond: bigint): Figure => (bond === 0n ? fig('no bond posted', true) : fig(formatCdt(bond)))

/** aumCap is 0 only for an unlisted vault; a listed vault floors at BASE_CAP. */
export const aumCapFigure = (cap: bigint): Figure => (cap === 0n ? fig('not listed', true) : fig(formatCdt(cap, 0)))

export const aumFigure = (aum: bigint): Figure => (aum === 0n ? fig('no tracked AUM', true) : fig(formatCdt(aum)))

export function rampFigure(ramp: bigint): Figure {
  if (ramp === 0n) return fig('ramp at 0', true)
  if (ramp >= WAD) return fig(`100% · day ${RAMP_DURATION_DAYS} of ${RAMP_DURATION_DAYS}`)
  return fig(`${formatWadPct(ramp, 1)} · day ${rampDays(ramp)} of ${RAMP_DURATION_DAYS}`)
}

export const rateFigure = (rate: bigint): Figure =>
  rate === 0n ? fig('no realized rate', true) : fig(`${formatWadPct(rate)}/yr`)

export const trailingFigure = (trailing: bigint): Figure =>
  trailing === 0n ? fig('no payments in 30 d', true) : fig(formatCdt(trailing))

export const slashFigure = (count: number): Figure => (count === 0 ? fig('no slashes', true) : fig(String(count)))

/**
 * Bucket index → "bucket 3 · 1.5–2.0%/yr". The top bucket is a clamp (≥ its floor);
 * the sentinel prints "none".
 */
export function bucketLabel(index: bigint): string {
  if (index === NO_BUCKET) return 'none'
  const lo = index * BUCKET_WIDTH_WAD
  if (index >= MAX_BUCKET_INDEX) return `bucket ${index} · ≥ ${formatWadPct(lo, 1).replace('%', '')}%/yr`
  const hi = lo + BUCKET_WIDTH_WAD
  return `bucket ${index} · ${formatWadPct(lo, 1).replace('%', '')}–${formatWadPct(hi, 1)}/yr`
}

export const bucketFigure = (index: bigint, trailing: bigint): Figure =>
  // bucketOf is 0 whenever realizedRate is 0 — say why rather than print a bare 0.
  trailing === 0n && index === 0n ? fig(`${bucketLabel(0n)} · no payments`, true) : fig(bucketLabel(index))

// ── aggregates ────────────────────────────────────────────────────────────────

export const sumBig = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n)

/** totalBonded / totalAum as a number; null when AUM is 0 (ratio undefined). */
export function coverageRatio(totalBonded: bigint, totalAum: bigint): number | null {
  if (totalAum === 0n) return null
  // 1e6 fixed-point keeps precision well past the 2 dp the card prints.
  return Number((totalBonded * 1_000_000n) / totalAum) / 1_000_000
}

// ── provenance ────────────────────────────────────────────────────────────────

export function chainLabel(chainId: number): string {
  return chainId === LOCAL_CHAIN_ID ? 'local chain' : `chain ${chainId}`
}

/** "local chain · CuratorRegistry 0xc3e5…3690 · block 133". */
export function provenanceLabel(chainId: number, registry: string, block: bigint | number): string {
  return `${chainLabel(chainId)} · CuratorRegistry ${shortAddress(registry)} · block ${block}`
}

// ── history ───────────────────────────────────────────────────────────────────

export type CuratorEventName =
  | 'BondPosted'
  | 'UnbondBegun'
  | 'UnbondCompleted'
  | 'PaymentRecorded'
  | 'RateDeclared'
  | 'AumCredited'
  | 'AumDebited'
  | 'Slashed'
  | 'SlashedOnLoss'

/** The decoded shape viem hands back; args are the event's non-indexed + indexed fields. */
export interface CuratorLog {
  eventName: CuratorEventName
  args: Record<string, unknown>
  blockNumber: bigint
  logIndex: number
  txHash?: string
}

export type HistoryTone = 'neutral' | 'credit' | 'debit' | 'slash'

export interface HistoryRow {
  key: string
  eventName: CuratorEventName
  title: string
  detail: string
  tone: HistoryTone
  blockNumber: bigint
  logIndex: number
  /** Unix seconds; null when the block time was not read. */
  timestamp: bigint | null
  txHash?: string
}

const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt((v as number | string | undefined) ?? 0))

/** One event → one history row. Every figure in `detail` is from the event args. */
export function eventToHistoryRow(log: CuratorLog, timestamp: bigint | null = null): HistoryRow {
  const a = log.args
  let title: string
  let detail: string
  let tone: HistoryTone = 'neutral'
  switch (log.eventName) {
    case 'BondPosted':
      title = 'bond posted'
      detail = `+${formatCdt(big(a.amount))} · bond ${formatCdt(big(a.newBond))} · payer ${shortAddress(String(a.payer ?? ''))}`
      tone = 'credit'
      break
    case 'UnbondBegun':
      title = 'unbond begun'
      detail = `cap to ${formatCdt(big(a.newCap), 0)} · ready ${formatBlockTime(big(a.readyTime))}`
      break
    case 'UnbondCompleted':
      title = 'unbond completed'
      detail = `${formatCdt(big(a.released))} released · cap ${formatCdt(big(a.newCap), 0)}`
      tone = 'debit'
      break
    case 'PaymentRecorded':
      title = 'payment recorded'
      detail = `${formatCdt(big(a.amount))} · trailing 30 d ${formatCdt(big(a.trailingTotal))}`
      tone = 'credit'
      break
    case 'RateDeclared':
      title = 'rate declared'
      detail = `${formatWadPct(big(a.rateWad))}/yr`
      break
    case 'AumCredited':
      title = 'AUM credited'
      detail = `+${formatCdt(big(a.amount))} · AUM ${formatCdt(big(a.newTrackedAum))}`
      break
    case 'AumDebited':
      title = 'AUM debited'
      detail = `−${formatCdt(big(a.amount))} · AUM ${formatCdt(big(a.newTrackedAum))}`
      break
    case 'Slashed':
      title = 'slashed'
      detail = `${formatCdt(big(a.slashed))} of ${formatCdt(big(a.failedAmount))} unserved · bond ${formatCdt(big(a.newBond))}`
      tone = 'slash'
      break
    case 'SlashedOnLoss':
      title = 'slashed on loss'
      detail = `${formatCdt(big(a.slashed))} at ${formatWadPct(big(a.lossRatioWad))} loss · bond ${formatCdt(big(a.newBond))}`
      tone = 'slash'
      break
  }
  return {
    key: `${log.blockNumber}-${log.logIndex}`,
    eventName: log.eventName,
    title,
    detail,
    tone,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    timestamp,
    txHash: log.txHash,
  }
}

/** Newest first: block desc, then log index desc. Returns a new array. */
export function sortNewestFirst<T extends { blockNumber: bigint; logIndex: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((x, y) =>
    x.blockNumber === y.blockNumber ? y.logIndex - x.logIndex : x.blockNumber > y.blockNumber ? -1 : 1,
  )
}

export const isSlashEvent = (name: CuratorEventName): boolean => name === 'Slashed' || name === 'SlashedOnLoss'

/** Slash count per vault (lower-cased address) from a flat log list. */
export function slashCounts(logs: readonly CuratorLog[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const l of logs) {
    if (!isSlashEvent(l.eventName)) continue
    const v = String(l.args.vault ?? '').toLowerCase()
    out.set(v, (out.get(v) ?? 0) + 1)
  }
  return out
}

/** Logs whose `vault` arg matches (case-insensitive). */
export const logsForVault = (logs: readonly CuratorLog[], vault: string): CuratorLog[] =>
  logs.filter((l) => String(l.args.vault ?? '').toLowerCase() === vault.toLowerCase())

export const isAddress = (s: string): s is `0x${string}` => /^0x[a-fA-F0-9]{40}$/.test(s)
