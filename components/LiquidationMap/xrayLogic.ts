// Position X-ray — pure logic (no I/O). TypeScript port of the research prototype
// membrane-app research/history-forecasts scripts/research/history-forecasts/live/q26_terminal.py
// (xray_metrics), which reuses the D14 quantities (r111v5_labels): LT-weighted collateral,
// debt, and k* — the common fractional move of every non-stable price that brings HF to 1.
//
// PROVENANCE: every output is MEASURED state at the read block. Nothing here forecasts.
// Risk types (board Q26-TERMINAL-MAP):
//   price  — a common drop of non-stable prices reaches HF 1 (k* line below 100 %)
//   pair   — non-stable debt against correlated collateral (e.g. weETH vs WETH): the
//            trigger is the collateral/debt RATIO, often an exchange-rate oracle
//   stable — stable-only, or stable collateral alone covers the debt: no price line

export const BAND_EDGES = [0, 0.01, 0.02, 0.035, 0.05, 0.10001] as const
export const BAND_NAMES = ['0-1%', '1-2%', '2-3.5%', '3.5-5%', '5-10%'] as const
export const MAX_BAND = 0.1

// D14 stable sets (q26_live_d14.py STABLE_SYMS + STABLE_SYMS_LIVE). Keep in sync.
const STABLES = new Set([
  'DAI',
  'USDC',
  'USDT0',
  'USDT',
  'miMATIC',
  'EURS',
  'jEUR',
  'EURA',
  'agEUR',
  'USDC.e',
  'GHO',
  'LUSD',
  'FRAX',
  'DAI.e',
  'USDt',
  'USDT.e',
  'USDbC',
  'PYUSD',
  'USDe',
  'sUSDe',
  'USDS',
  'sDAI',
  'crvUSD',
  'RLUSD',
  'FDUSD',
  'EURC',
  'USD1',
  'USDtb',
  'eUSDe',
  'syrupUSDT',
  'syrupUSDC',
  'USDG',
  'BUSD',
  'mUSD',
  'lisUSD',
  'frxUSD',
  'sfrxUSD',
  'USDf',
  'sUSDS',
  'fxUSD',
  'GHO.e',
  'mUSDC',
  'USDC.ARB',
  'USD₮0',
])

export function isStable(symbol: string): boolean {
  if (STABLES.has(symbol)) return true
  // Pendle principal tokens of stables (PT-sUSDE-..., PT-USDe-...) carry the stable in their name.
  const m = /^PT-([A-Za-z]+)-/.exec(symbol)
  return !!m && [...STABLES].some((s) => s.toLowerCase() === m[1].toLowerCase())
}

export type XrayReserve = {
  symbol: string
  priceUsd: number // oracle price, USD
  lt: number // effective liquidation threshold for this user (e-mode applied), fraction
  collateralUsd: number // balance x price, only if used as collateral
  debtUsd: number
}

export type RiskType = 'price' | 'pair' | 'stable'

export type XrayResult = {
  healthFactor: number | null
  collateralUsd: number
  debtUsd: number
  mainCollateral: string
  riskType: RiskType
  distance: number | null
  distanceJointPrice: number | null
  distanceCollateralOnly: number | null
  liquidationPrice: number | null
  oraclePrice: number | null
  band: string | null
  bandIndex: number | null
}

export function bandOf(d: number | null): number | null {
  if (d === null || !(d > 0)) return null
  for (let i = 0; i < BAND_NAMES.length; i++) {
    if (d >= BAND_EDGES[i] && d < BAND_EDGES[i + 1]) return i
  }
  return null
}

export function xrayMetrics(reserves: XrayReserve[]): XrayResult {
  let Cst = 0
  let Cv = 0
  let Dst = 0
  let Dv = 0
  let coll = 0
  let debt = 0
  const volColl: Record<string, number> = {}
  let volDebt = false
  for (const r of reserves) {
    const st = isStable(r.symbol)
    if (r.collateralUsd > 0 && r.lt > 0) {
      const v = r.collateralUsd * r.lt
      if (st) Cst += v
      else {
        Cv += v
        volColl[r.symbol] = (volColl[r.symbol] ?? 0) + v
      }
    }
    if (r.collateralUsd > 0) coll += r.collateralUsd
    if (r.debtUsd > 0) {
      debt += r.debtUsd
      if (st) Dst += r.debtUsd
      else {
        Dv += r.debtUsd
        volDebt = true
      }
    }
  }
  const hf = Dst + Dv > 0 ? (Cst + Cv) / (Dst + Dv) : Infinity
  const kstar = Cv - Dv > 0 ? (Dst + Dv - Cst - Cv) / (Cv - Dv) : null
  const dj = kstar === null ? null : kstar >= 0 ? 0 : -kstar < 1 ? -kstar : null
  const dc = hf > 0 && Number.isFinite(hf) ? 1 - 1 / hf : null
  const names = Object.keys(volColl)
  const main = names.length
    ? names.reduce((a, b) => (volColl[a] >= volColl[b] ? a : b))
    : 'stable-only'
  const riskType: RiskType =
    volDebt && main !== 'stable-only' ? 'pair' : dj !== null ? 'price' : 'stable'
  const d = riskType === 'price' ? dj : dc
  const px = reserves.find((r) => r.symbol === main)?.priceUsd ?? null
  const bandIndex = d !== null && d > 0 && d <= MAX_BAND ? bandOf(d) : null
  return {
    healthFactor: Number.isFinite(hf) ? hf : null,
    collateralUsd: coll,
    debtUsd: debt,
    mainCollateral: main,
    riskType,
    distance: d,
    distanceJointPrice: dj,
    distanceCollateralOnly: dc,
    // The price line itself: px (1 + k*). Below HF 1, k* > 0 and the line sits above today's price.
    liquidationPrice:
      riskType === 'price' && kstar !== null && kstar > -1 && px ? px * (1 + kstar) : null,
    oraclePrice: px,
    band:
      bandIndex !== null ? BAND_NAMES[bandIndex] : d !== null && d > MAX_BAND ? 'over 10%' : null,
    bandIndex,
  }
}

/** Effective LT per reserve under a user's e-mode (Aave v3.2+ bitmap layout). */
export function effectiveLt(
  baseLtBps: number,
  reserveId: number,
  emode: { ltBps: number; bitmap: bigint } | null,
) {
  if (emode && emode.ltBps > 0 && ((emode.bitmap >> BigInt(reserveId)) & 1n) === 1n)
    return emode.ltBps / 1e4
  return baseLtBps / 1e4
}

/** Reserve configuration bitmap → liquidation threshold (bps), bits 16..31. */
export function ltFromConfig(config: bigint): number {
  return Number((config >> 16n) & 0xffffn)
}
