// Parameter formatting for the Mechanism panel: a raw contract value or a catalog parameter
// rendered in its unit — a price cap at its decimals, a WAD (1e18 = 100%) or Aave
// PERCENTAGE_FACTOR (1e4 = 100%) percent, seconds as a duration, a unix time as a date — with
// the raw value kept alongside (hover + secondary text), so the row still reports exactly
// what the contract returned or the catalog stores. Pure; tested in
// tests/unit/oracleRegistryParamFormat.test.ts.
//
// The scale is a property of the CONTRACT, not of the number: Aave's on-chain CAPO growth cap
// 880 is 8.8%, while the catalog's `maxYearlyGrowthPercent: 8.8` is already a percent. So
// known parameters are listed by name; unlisted names fall back to unambiguous suffix rules
// (…Timestamp, …Seconds, …Duration, an 18-decimal …Ratio), and an unknown scale stays raw.

import type { CardView } from '@/lib/oracleRegistry/apiTypes'
import type { ParamValue } from '@/lib/oracleRegistry/types'

import { fmtDuration, fmtRatio, fmtUtc, pctOf, priceDecimals } from './viewModel'

export type ParamUnit =
  | 'usd'
  | 'percent'
  | 'percent_per_year'
  | 'duration'
  | 'date'
  | 'ratio'
  | 'scale'
  | 'raw'

export type ParamDisplay = {
  /** The value in its unit: "$1.04" · "2%" · "8.8%/yr" · "2h" · "2026-10-22" · "1.22828". */
  text: string
  /** The value exactly as returned / stored, when `text` differs from it (else null). */
  raw: string | null
  unit: ParamUnit
}

export type ParamContext = {
  /** Decimals of a price-valued parameter (priceCap): its `…Decimals` sibling, else the feed's. */
  priceDecimals?: number | null
  /** Fixed-point decimals of an exchange ratio (a CAPO map's `ratioDecimals`; default 18). */
  ratioDecimals?: number
  /** Fixed-point scale of a yearly rate (a discount map's `scale`; default 1e18 = 100%/yr). */
  rateScale?: number
}

type Spec =
  | { unit: 'usd' | 'duration' | 'date' | 'ratio' | 'scale' }
  | { unit: 'percent' | 'percent_per_year'; scale: number | 'rate' }

/** Parameters whose scale is known from the contract that holds them (lower-cased names). */
const KNOWN: Readonly<Record<string, Spec>> = {
  // Aave price-cap adapter (stables): answers in the market oracle's 8-decimal USD.
  pricecap: { unit: 'usd' },
  // Morpho deviation-timelock meta-oracle: a WAD challenge threshold, timelocks in seconds.
  deviationthreshold: { unit: 'percent', scale: 1e18 },
  challengetimelockduration: { unit: 'duration' },
  healingtimelockduration: { unit: 'duration' },
  // Aave CAPO getter and event argument: PERCENTAGE_FACTOR, 1e4 = 100% (880 = 8.8%/yr).
  getmaxyearlygrowthratepercent: { unit: 'percent_per_year', scale: 1e4 },
  maxyearlyratiogrowthpercent: { unit: 'percent_per_year', scale: 1e4 },
  // The catalog's CAPO map stores the growth cap already as a percent (8.8 = 8.8%/yr).
  maxyearlygrowthpercent: { unit: 'percent_per_year', scale: 100 },
  getsnapshotratio: { unit: 'ratio' },
  snapshotratio: { unit: 'ratio' },
  getsnapshottimestamp: { unit: 'date' },
  snapshottimestamp: { unit: 'date' },
  minimumsnapshotdelayseconds: { unit: 'duration' },
  // Aave PT linear-discount adapter: yearly rates at its `scale` (1e18 = 100%/yr).
  discountrateperyear: { unit: 'percent_per_year', scale: 'rate' },
  maxdiscountrateperyear: { unit: 'percent_per_year', scale: 'rate' },
  maturity: { unit: 'date' },
  scale: { unit: 'scale' },
}

/** Unlisted names: only suffixes whose unit cannot be misread. */
function specFor(key: string, v: ParamValue): Spec | null {
  const known = KNOWN[key.toLowerCase()]
  if (known) return known
  if (/timestamp$/i.test(key)) return { unit: 'date' }
  if (/(seconds|duration)$/i.test(key)) return { unit: 'duration' }
  if (/ratio$/i.test(key) && typeof v === 'string' && /^\d{15,}$/.test(v)) return { unit: 'ratio' }
  return null
}

const isUint = (s: string): boolean => /^\d+$/.test(s)

/** $1.04 · $86,084 · $0.99973 — about one bp of resolution, trailing zeros trimmed. */
function fmtUsdTrim(x: number): string {
  let s = Math.abs(x).toFixed(priceDecimals(x))
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  const [i, d] = s.split('.')
  return `${x < 0 ? '−' : ''}$${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${d ? `.${d}` : ''}`
}

function scaled(spec: Spec, s: string, n: number, ctx: ParamContext): string | null {
  switch (spec.unit) {
    case 'date':
      return Number.isFinite(n) && n > 1e9 && n < 1e11 ? fmtUtc(n).slice(0, 10) : null
    case 'duration':
      return isUint(s) ? fmtDuration(n) : null
    case 'usd': {
      const d = ctx.priceDecimals
      if (d == null || !Number.isInteger(d) || d < 0 || d > 36 || !isUint(s)) return null
      return fmtUsdTrim(n / 10 ** d)
    }
    case 'ratio': {
      // An exchange ratio sits near 1, so its raw integer has about d + 1 digits; a short
      // integer is not at this scale and is left raw rather than shown as ~0.
      const d = ctx.ratioDecimals ?? 18
      if (!Number.isInteger(d) || d < 0 || !isUint(s) || s.length < d - 2) return null
      return fmtRatio(n / 10 ** d)
    }
    case 'scale': {
      const e = Math.log10(n)
      return Number.isFinite(n) && n > 1 && Number.isInteger(e) ? `1e${e}` : null
    }
    case 'percent':
    case 'percent_per_year': {
      const base = spec.scale === 'rate' ? (ctx.rateScale ?? 1e18) : spec.scale
      // WAD / 1e4 values are integers on-chain; the catalog's plain percents may be decimals.
      if (!Number.isFinite(n) || n < 0 || !(base > 0)) return null
      if (base !== 100 && !isUint(s)) return null
      const p = pctOf(n / base)
      return spec.unit === 'percent_per_year' ? `${p}/yr` : p
    }
    default:
      return null
  }
}

/** One parameter in its unit, with the raw value kept whenever the text differs from it. */
export function formatParam(key: string, v: ParamValue, ctx: ParamContext = {}): ParamDisplay {
  if (v == null) return { text: '—', raw: null, unit: 'raw' }
  const s = String(v)
  if (typeof v === 'boolean') return { text: s, raw: null, unit: 'raw' }
  const spec = specFor(key, v)
  const text = spec ? scaled(spec, s, Number(v), ctx) : null
  if (spec == null || text == null) return { text: s, raw: null, unit: 'raw' }
  return { text, raw: text === s ? null : s, unit: spec.unit }
}

/**
 * Rows for a catalog cap / discount map. Scale-carrying keys are consumed, not listed:
 * `ratioDecimals` (CAPO ratios), a `<name>Decimals` sibling (priceCapDecimals → priceCap);
 * `kind` leads. A discount map's `scale` stays listed — it is the adapter's own constant.
 */
export function paramRows(
  params: Record<string, string | number> | undefined,
  ctx: ParamContext = {},
): [string, ParamDisplay][] {
  if (!params) return []
  const base: ParamContext = {
    ...ctx,
    ratioDecimals: params.ratioDecimals != null ? Number(params.ratioDecimals) : ctx.ratioDecimals,
    rateScale: params.scale != null ? Number(params.scale) : ctx.rateScale,
  }
  const rows: [string, ParamDisplay][] = []
  for (const [k, v] of Object.entries(params)) {
    if (k === 'kind' || k === 'ratioDecimals') continue
    if (/Decimals$/.test(k) && k.slice(0, -'Decimals'.length) in params) continue
    const own = params[`${k}Decimals`]
    rows.push([k, formatParam(k, v, own != null ? { ...base, priceDecimals: Number(own) } : base)])
  }
  if (params.kind != null)
    rows.unshift(['kind', { text: String(params.kind), raw: null, unit: 'raw' }])
  return rows
}

/**
 * The scales a card's raw on-chain reads are in: a price cap at its declared decimals (else
 * the feed's own), CAPO ratios at the cap map's ratioDecimals, discount rates at the
 * discount map's scale.
 */
export function onchainContext(card: Pick<CardView, 'decimals' | 'mechanism'>): ParamContext {
  const { cap, discount } = card.mechanism
  const num = (x: string | number | undefined): number | undefined =>
    x != null && Number.isFinite(Number(x)) ? Number(x) : undefined
  return {
    priceDecimals: num(cap?.priceCapDecimals) ?? card.decimals,
    ratioDecimals: num(cap?.ratioDecimals),
    rateScale: num(discount?.scale),
  }
}
