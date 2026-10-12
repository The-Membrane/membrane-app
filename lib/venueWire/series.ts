/**
 * Measured series for The Wire, built from the datasets in triccs/membrane-datasets (rule N18).
 * Pure: the service reads the files, this file only reshapes them.
 *
 *   venue-stress/history.json   hourly archive reads of 9 Aave / Spark / MetaMorpho venues
 *   venue-stress/summary.json   labels, material-size start per venue, stress episodes
 *   price-history/eth-usd-1h    Chainlink ETH/USD with Coinbase and Binance closes
 *   price-history/steth-eth-1h  Chainlink STETH/ETH market feed
 *   position-alerts/depeg-history.json   USDC and USDe prices (DefiLlama, about hourly)
 *
 * File shapes are copied structurally (as lib/positionAlerts/capacity.ts does), not imported
 * from their builders on other branches.
 */

import type { MetricKey, Series, Subject } from './types'

// ------------------------------------------------------------------ input shapes

type Col = (number | null)[]

export interface VenueStressHistoryFile {
  schema: string
  timeline: { t: number[]; b?: number[] }
  venues: Record<
    string,
    { cash: Col; supply: Col; debt: Col; util: Col; flags?: Col; apr?: Col; liquid?: Col }
  >
}

export interface StressWindow {
  id: string
  label: string
  from: string
  to: string
  /** 'named' (a market event), 'eth-drop', 'util>=95', 'util>=99'; absent = named. */
  trigger?: string
  venue?: string
}

export interface VenueStressSummaryFile {
  schema: string
  venues: Record<string, { protocol: string; symbol: string; name?: string }>
  coverage: Record<string, { first?: string; materialFrom?: string }>
  method?: { triggers?: { named?: StressWindow[] } }
  episodes?: StressWindow[]
}

export interface HourlyPriceFile {
  asset: string
  startTs: number
  stepSeconds: number
  count: number
  columns: Record<string, Col>
  primary?: { segments: { source: string; fromIndex: number; toIndex: number }[] }
}

export interface DepegHistoryFile {
  source: string
  series: Record<string, [number, number][]>
}

export interface WireInputs {
  venueStress?: { history: VenueStressHistoryFile; summary: VenueStressSummaryFile }
  ethUsd?: HourlyPriceFile
  stethEth?: HourlyPriceFile
  depeg?: DepegHistoryFile
}

// ------------------------------------------------------------------ frames

/** Every column of one venue, for the drivers. */
export interface VenueFrame {
  subject: Subject
  symbol: string
  /** A $1 stable: token units are USD (the venue-stress convention). */
  usd: boolean
  morpho: boolean
  t: number[]
  block: number[] | null
  cash: Col
  supply: Col
  debt: Col
  util: Col
  flags: Col
  apr: Col | null
  /** What can leave now: Aave/Spark cash; MetaMorpho `liquid` (first in line). */
  exit: Col
  fromTs: number
  source: string
}

/** One asset's price columns, for the drivers. */
export interface AssetFrame {
  subject: Subject
  t: number[]
  price: Col
  /** A second price for the same asset (exchange vs oracle), when the input has one. */
  ref: Col | null
  priceName: string
  refName: string | null
  /** Venue ids whose risk or reward this asset's price moves. */
  affects: string[]
  source: string
}

export interface WireFrames {
  venues: Map<string, VenueFrame>
  assets: Map<string, AssetFrame>
  /** Stress windows: named market events and per-venue utilisation episodes. */
  windows: StressWindow[]
  series: Series[]
  /** Inputs that were not supplied: every series they feed is uncovered. */
  missing: string[]
}

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDS'])
const PROTOCOL_SHORT: [RegExp, string][] = [
  [/^Aave/i, 'Aave'],
  [/^SparkLend/i, 'Spark'],
]

export const isoToTs = (s: string): number =>
  Math.floor(Date.parse(s.endsWith('Z') ? s : `${s}Z`) / 1000)

export function venueLabel(v: { protocol: string; symbol: string; name?: string }): string {
  if (v.name) return v.name
  const short = PROTOCOL_SHORT.find(([re]) => re.test(v.protocol))?.[1] ?? v.protocol.split(' ')[0]
  return `${short} ${v.symbol}`
}

const ratio = (a: number | null, b: number | null): number | null =>
  a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0 ? null : a / b

function venueFrames(input: NonNullable<WireInputs['venueStress']>): VenueFrame[] {
  const { history, summary } = input
  if (!history.schema.startsWith('venue-stress-history/'))
    throw new Error(`venueWire: unexpected venue-stress schema ${history.schema}`)
  const t = history.timeline.t
  const out: VenueFrame[] = []
  for (const [id, cols] of Object.entries(history.venues)) {
    const meta = summary.venues[id]
    if (!meta) continue
    const cov = summary.coverage[id] ?? {}
    const from = cov.materialFrom ?? cov.first
    const morpho = cols.liquid !== undefined
    const usd = STABLES.has(meta.symbol.toUpperCase())
    out.push({
      subject: { kind: 'venue', id, label: venueLabel(meta) },
      symbol: meta.symbol,
      usd,
      morpho,
      t,
      block: history.timeline.b ?? null,
      cash: cols.cash,
      supply: cols.supply,
      debt: cols.debt,
      util: cols.util,
      flags: cols.flags ?? t.map(() => null),
      // MetaMorpho's `apr` column is the withdraw-queue length, not a rate.
      apr: morpho ? null : (cols.apr ?? null),
      exit: morpho ? (cols.liquid as Col) : cols.cash,
      fromTs: from ? isoToTs(from) : t[0],
      source: morpho
        ? `MetaMorpho ${meta.name ?? id} archive reads, hourly (venue-stress-history/v1)`
        : `${meta.protocol} ${meta.symbol} reserve archive reads, hourly (venue-stress-history/v1)`,
    })
  }
  return out
}

function venueSeries(f: VenueFrame): Series[] {
  const base = { subject: f.subject, t: f.t, fromTs: f.fromTs, source: f.source }
  const out: Series[] = [
    {
      ...base,
      metric: 'idleCashPct',
      unit: 'pct',
      v: f.cash.map((c, i) => {
        const r = ratio(c, f.supply[i])
        return r === null ? null : 100 * r
      }),
    },
    {
      ...base,
      metric: 'exitCapacity',
      unit: f.usd ? 'usd' : f.symbol,
      v: f.exit.map((x) => (x === null ? null : x)),
    },
    {
      ...base,
      metric: 'utilisationPct',
      unit: 'pct',
      v: f.util.map((u) => (u === null ? null : 100 * u)),
    },
  ]
  if (f.apr) out.push({ ...base, metric: 'borrowAprPct', unit: 'pct', v: f.apr })
  return out
}

/** The hourly grid of a price file, and its primary column (the segment sources stitched). */
function hourly(file: HourlyPriceFile): { t: number[]; primary: Col } {
  const t = Array.from({ length: file.count }, (_, i) => file.startTs + i * file.stepSeconds)
  const segs = file.primary?.segments
  if (!segs?.length) return { t, primary: file.columns.oracle ?? Object.values(file.columns)[0] }
  const primary: Col = t.map(() => null)
  for (const s of segs) {
    const col = file.columns[s.source]
    if (!col) continue
    for (let i = s.fromIndex; i <= s.toIndex && i < t.length; i++) primary[i] = col[i] ?? null
  }
  return { t, primary }
}

function ethFrames(
  file: HourlyPriceFile,
  venueIds: string[],
  aaveSpark: string[],
): { frame: AssetFrame; series: Series[] } {
  const { t, primary } = hourly(file)
  const oracle = file.columns.oracle ?? null
  const coinbase = file.columns.coinbase ?? null
  const lag = Math.round(86_400 / file.stepSeconds)
  const subject: Subject = { kind: 'asset', id: 'eth', label: 'ETH' }
  const frame: AssetFrame = {
    subject,
    t,
    price: primary,
    ref: coinbase,
    priceName: 'Chainlink ETH/USD',
    refName: coinbase ? 'Coinbase ETH/USD' : null,
    // ETH is collateral on every Aave and Spark venue here.
    affects: aaveSpark.length ? aaveSpark : venueIds,
    source: 'Chainlink ETH/USD hourly (Coinbase before the oracle run)',
  }
  const series: Series[] = [
    {
      subject,
      metric: 'priceMove24hPct',
      unit: 'pct',
      t,
      fromTs: t[0],
      source: frame.source,
      v: primary.map((p, i) => {
        const r = i >= lag ? ratio(p, primary[i - lag]) : null
        return r === null ? null : 100 * (r - 1)
      }),
    },
  ]
  if (oracle && coinbase)
    series.push({
      subject,
      metric: 'oracleDeviationBps',
      unit: 'bps',
      t,
      fromTs: t[0],
      source: 'Chainlink ETH/USD vs Coinbase ETH/USD hourly close',
      v: oracle.map((o, i) => {
        const r = ratio(o, coinbase[i])
        return r === null ? null : Math.abs(r - 1) * 1e4
      }),
    })
  return { frame, series }
}

function stethFrame(
  file: HourlyPriceFile,
  wethVenues: string[],
): { frame: AssetFrame; series: Series[] } {
  const { t, primary } = hourly(file)
  const subject: Subject = { kind: 'asset', id: 'steth', label: 'stETH' }
  const frame: AssetFrame = {
    subject,
    t,
    price: primary,
    ref: null,
    priceName: 'Chainlink STETH/ETH',
    refName: null,
    // stETH loops borrow WETH: its discount moves the WETH venues.
    affects: wethVenues,
    source: 'Chainlink STETH/ETH market feed, hourly (redemption value 1 ETH)',
  }
  return {
    frame,
    series: [
      {
        subject,
        metric: 'navDiscountBps',
        unit: 'bps',
        t,
        fromTs: t[0],
        source: frame.source,
        v: primary.map((p) => (p === null ? null : (1 - p) * 1e4)),
      },
    ],
  }
}

const DEPEG_ASSETS: Record<string, { label: string; symbol: string }> = {
  usdc: { label: 'USDC', symbol: 'USDC' },
  usde: { label: 'USDe', symbol: 'USDE' },
}

function depegFrames(
  file: DepegHistoryFile,
  venueSymbol: Map<string, string>,
): { frame: AssetFrame; series: Series }[] {
  const out: { frame: AssetFrame; series: Series }[] = []
  for (const [key, meta] of Object.entries(DEPEG_ASSETS)) {
    const rows = file.series[key]
    if (!rows?.length) continue
    const t = rows.map((r) => r[0])
    const price = rows.map((r) => r[1])
    const subject: Subject = { kind: 'asset', id: key, label: meta.label }
    const affects = [...venueSymbol]
      .filter(([, s]) => s.toUpperCase() === meta.symbol)
      .map(([id]) => id)
    const source = `${meta.label}/USD market price, about hourly (DefiLlama coins API)`
    out.push({
      frame: {
        subject,
        t,
        price,
        ref: null,
        priceName: `${meta.label}/USD`,
        refName: null,
        affects,
        source,
      },
      series: {
        subject,
        metric: 'depegBps',
        unit: 'bps',
        t,
        fromTs: t[0],
        source,
        v: price.map((p) => (1 - p) * 1e4),
      },
    })
  }
  return out
}

/** Every frame and series the inputs support. A missing input yields nothing, not zeros. */
export function buildFrames(inputs: WireInputs): WireFrames {
  const venues = new Map<string, VenueFrame>()
  const assets = new Map<string, AssetFrame>()
  const series: Series[] = []
  const windows: StressWindow[] = []

  if (inputs.venueStress) {
    for (const f of venueFrames(inputs.venueStress)) {
      venues.set(f.subject.id, f)
      series.push(...venueSeries(f))
    }
    const s = inputs.venueStress.summary
    windows.push(...(s.method?.triggers?.named ?? []), ...(s.episodes ?? []))
  }
  const ids = [...venues.keys()]
  const aaveSpark = [...venues.values()].filter((f) => !f.morpho).map((f) => f.subject.id)
  const symbols = new Map([...venues.values()].map((f) => [f.subject.id, f.symbol]))
  if (inputs.ethUsd) {
    const { frame, series: s } = ethFrames(inputs.ethUsd, ids, aaveSpark)
    assets.set('eth', frame)
    series.push(...s)
  }
  if (inputs.stethEth) {
    const weth = ids.filter((id) => symbols.get(id)?.toUpperCase() === 'WETH')
    const { frame, series: s } = stethFrame(inputs.stethEth, weth)
    assets.set('steth', frame)
    series.push(...s)
  }
  if (inputs.depeg) {
    for (const { frame, series: s } of depegFrames(inputs.depeg, symbols)) {
      assets.set(frame.subject.id, frame)
      series.push(s)
    }
  }
  const missing = (['venueStress', 'ethUsd', 'stethEth', 'depeg'] as const).filter(
    (k) => !inputs[k],
  )
  return { venues, assets, windows, series, missing }
}

/** Index of the last t at or before ts, or −1. Binary search; t ascending. */
export function indexAt(t: number[], ts: number): number {
  let lo = 0
  let hi = t.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] <= ts) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** Value of a column at the last t at or before ts, looking back at most maxBackS. */
export function valueAt(t: number[], col: Col, ts: number, maxBackS: number): number | null {
  for (let i = indexAt(t, ts); i >= 0 && ts - t[i] <= maxBackS; i--) {
    const v = col[i]
    if (v !== null && v !== undefined && Number.isFinite(v)) return v
  }
  return null
}

export const METRICS: readonly MetricKey[] = [
  'idleCashPct',
  'exitCapacity',
  'utilisationPct',
  'borrowAprPct',
  'navDiscountBps',
  'depegBps',
  'oracleDeviationBps',
  'priceMove24hPct',
]
