/**
 * Builds the committed Oct 10 2025 stress dataset under public/data/oct10-2025/.
 *
 * SOURCE (not in this repo): ~/Downloads/oct10_data — a measured pull produced in a
 * prior session from public JSON-RPC (Tenderly public gateways) and Binance public
 * daily dumps. Its own FINDINGS.md / SOURCES.md document the fetch method, endpoint
 * verification and known data-quality caveats.
 *
 * This script exists so the committed JSON is reproducible and auditable rather than
 * hand-typed. It only ever COPIES measured values — it never derives, smooths or
 * invents one. Run:  pnpm build:oct10-data
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SRC = process.env.OCT10_SRC || path.join(os.homedir(), 'Downloads', 'oct10_data')
const OUT = path.join(process.cwd(), 'public', 'data', 'oct10-2025')

if (!fs.existsSync(SRC)) {
  console.error(`Source dataset not found at ${SRC}.`)
  console.error('The committed output under public/data/oct10-2025/ is what ships; this')
  console.error('script only regenerates it. Set OCT10_SRC to point at the raw pull.')
  process.exit(1)
}

// ---------------------------------------------------------------- csv helpers
function readCsv(file: string): Record<string, string>[] {
  const raw = fs.readFileSync(path.join(SRC, file), 'utf8').trim().split('\n')
  const head = raw[0].split(',')
  return raw.slice(1).map((line) => {
    const cells = line.split(',')
    const row: Record<string, string> = {}
    head.forEach((h, i) => (row[h] = cells[i]))
    return row
  })
}
const num = (v: string | undefined): number | null => {
  if (v === undefined || v === '' || v === 'nan') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
/** Round to a fixed number of decimals to keep the payload small. Never changes a
 *  value by more than half a cent at these scales. */
const r = (v: number | null, dp: number): number | null =>
  v === null ? null : Number(v.toFixed(dp))

// ------------------------------------------------------------------ 1m series
const chainlink = readCsv('chainlink_1m.csv')
const binance = readCsv('binance_1m_48h.csv')
const curve = readCsv('usde_curve_depth_1m.csv')

const START = 1760054400 // 2025-10-10 00:00:00 UTC
const STEP = 60

// Index the sources by minute so a missing row becomes an explicit null, never a
// silently forward-filled value.
const byMinute = <T,>(rows: Record<string, string>[], key: string, f: (row: Record<string, string>) => T) => {
  const m = new Map<number, T>()
  for (const row of rows) {
    const t = num(row[key])
    if (t !== null) m.set(t, f(row))
  }
  return m
}

const cl = byMinute(chainlink, 'minute_ts', (row) => ({
  eth: r(num(row.ETH_USD_oracle), 2),
  btc: r(num(row.BTC_USD_oracle), 2),
  stethEth: r(num(row.wstETH_ETH_oracle), 6),
  ethCarried: num(row.ETH_USD_carried) === 1,
  btcCarried: num(row.BTC_USD_carried) === 1,
}))
const bn = byMinute(binance, 'minute_ts', (row) => ({
  eth: r(num(row.ETH), 2),
  ethLow: r(num(row.ETH_low), 2),
  btc: r(num(row.BTC), 2),
  btcLow: r(num(row.BTC_low), 2),
  usde: r(num(row.USDe_binance), 4),
  usdeLow: r(num(row.USDe_binance_low), 4),
}))
const cv = byMinute(curve, 'minute_ts', (row) => ({
  usdeChain: r(num(row.price_1_usde), 5),
}))

const minutes: number[] = []
for (let t = START; t < START + 2880 * STEP; t += STEP) minutes.push(t)

// Columnar layout — ~4x smaller than an array of objects over 2,880 rows.
const series = {
  startTs: START,
  stepSeconds: STEP,
  count: minutes.length,
  columns: {
    ethOracle: minutes.map((t) => cl.get(t)?.eth ?? null),
    btcOracle: minutes.map((t) => cl.get(t)?.btc ?? null),
    stethEthOracle: minutes.map((t) => cl.get(t)?.stethEth ?? null),
    ethSpot: minutes.map((t) => bn.get(t)?.eth ?? null),
    ethSpotLow: minutes.map((t) => bn.get(t)?.ethLow ?? null),
    btcSpot: minutes.map((t) => bn.get(t)?.btc ?? null),
    btcSpotLow: minutes.map((t) => bn.get(t)?.btcLow ?? null),
    usdeSpot: minutes.map((t) => bn.get(t)?.usde ?? null),
    usdeSpotLow: minutes.map((t) => bn.get(t)?.usdeLow ?? null),
    usdeOnchain: minutes.map((t) => cv.get(t)?.usdeChain ?? null),
  },
  /** True where the oracle carried its previous round rather than printing a new one. */
  carried: {
    ethOracle: minutes.map((t) => (cl.get(t)?.ethCarried ? 1 : 0)),
    btcOracle: minutes.map((t) => (cl.get(t)?.btcCarried ? 1 : 0)),
  },
}

// ------------------------------------------------------- protocol parameters
const params = JSON.parse(fs.readFileSync(path.join(SRC, 'protocol_params_oct10.json'), 'utf8'))
const aaveWanted = ['WETH', 'WBTC', 'wstETH', 'USDC', 'USDT', 'DAI', 'cbBTC', 'weETH', 'rETH', 'LINK']
const aaveReserves: Record<string, unknown> = {}
for (const sym of aaveWanted) {
  const res = params.aave_v3?.assets?.[sym]
  const oc = (res as { onchain?: Record<string, number> })?.onchain
  if (!oc) continue
  aaveReserves[sym] = {
    decimals: oc.decimals,
    ltvPct: oc.ltv_pct,
    liquidationThresholdPct: oc.liquidation_threshold_pct,
    liquidationBonusPct: oc.liquidation_bonus_pct,
    liquidationPenaltyPct: oc.liquidation_penalty_pct,
    usageAsCollateralEnabled: oc.usage_as_collateral_enabled,
    borrowingEnabled: oc.borrowing_enabled,
  }
}

const morphoMarkets: Record<string, unknown> = {}
for (const [id, m] of Object.entries<Record<string, unknown>>(params.morpho_blue?.markets ?? {})) {
  morphoMarkets[id] = {
    loanSymbol: m.loan_symbol ?? m.symbol,
    collateralSymbol: m.collateral_symbol,
    loanToken: m.loan_token,
    collateralToken: m.collateral_token,
    oracle: m.oracle,
    lltvPct: m.lltv_pct,
    liquidationsInWindow: m.liquidations_in_window,
  }
}

const aaveRepay = JSON.parse(fs.readFileSync(path.join(SRC, 'aave_repay_distribution.json'), 'utf8'))
const morphoRepay = JSON.parse(fs.readFileSync(path.join(SRC, 'morpho_repay_distribution.json'), 'utf8'))
const oracleLag = JSON.parse(fs.readFileSync(path.join(SRC, 'oracle_lag_report.json'), 'utf8'))
const curveDepth = JSON.parse(fs.readFileSync(path.join(SRC, 'usde_curve_depth_summary.json'), 'utf8'))

const protocols = {
  readBlock: params.read_block,
  readBlockTimestamp: params.read_block_timestamp,
  chain: params.chain ?? 'mainnet',
  aaveV3: {
    provenance: 'onchain — read at mainnet block ' + params.read_block,
    reserves: aaveReserves,
    emodeEthCorrelated: params.aave_v3?.emode_categories?.['1'] ?? null,
    closeFactor: params.aave_v3?.liquidation_close_factor ?? null,
  },
  morphoBlue: {
    provenance: 'onchain — read at mainnet block ' + params.read_block,
    hasCloseFactor: params.morpho_blue?.close_factor?.has_close_factor ?? null,
    liquidationIncentive: params.morpho_blue?.liquidation_incentive_factor?.documented_constants ?? null,
    markets: morphoMarkets,
  },
  /** MEASURED liquidation behaviour in the window — what actually happened, not doctrine. */
  measuredLiquidations: {
    aaveV3: {
      events: aaveRepay.overall?.n_events,
      meanRepayFraction: aaveRepay.overall?.mean,
      medianRepayFraction: aaveRepay.overall?.median,
      shareFullLiquidations: aaveRepay.overall?.share_full_liquidations,
      shareInCloseFactorBand: aaveRepay.overall?.['share_frac_in_0.49_0.51'],
      buckets: aaveRepay.overall?.buckets ?? null,
      note: 'All chains (mainnet + arbitrum + optimism + base).',
    },
    morphoBlue: {
      events: morphoRepay.n_events,
      meanRepayFraction: morphoRepay.mean,
      medianRepayFraction: morphoRepay.median,
      shareFullLiquidations: morphoRepay.share_full_liquidations,
      buckets: morphoRepay.buckets ?? null,
      note: 'Repay fraction computed in SHARES (repaidShares/borrowShares at block-1), immune to interest accrual.',
    },
  },
  oracleBehaviour: oracleLag,
  usdeExitLiquidity: curveDepth,
}

// ------------------------------------------------------------------- manifest
const manifest = {
  name: 'Oct 10 2025 stress window',
  windowStartUtc: '2025-10-10T00:00:00Z',
  windowEndUtc: '2025-10-11T23:59:00Z',
  windowStartTs: START,
  resolution: '1 minute',
  generatedAt: new Date().toISOString(),
  generatedBy: 'scripts/build-oct10-dataset.ts',
  sourceDirectory: '~/Downloads/oct10_data (not committed)',
  sources: [
    { series: 'ethOracle / btcOracle / stethEthOracle', source: 'Chainlink AnswerUpdated logs via public JSON-RPC (Tenderly public gateway)', file: 'chainlink_1m.csv' },
    { series: 'ethSpot / btcSpot / usdeSpot (+ lows)', source: 'Binance public 1m klines', file: 'binance_1m_48h.csv' },
    { series: 'usdeOnchain', source: 'Curve USDe/USDC pool quote for a 1 USDe clip, per minute', file: 'usde_curve_depth_1m.csv' },
    { series: 'protocol params', source: 'on-chain reads at mainnet block ' + params.read_block, file: 'protocol_params_oct10.json' },
    { series: 'measured liquidations', source: 'Aave/Morpho Liquidate event logs, decoded', file: 'aave_repay_distribution.json / morpho_repay_distribution.json' },
  ],
  caveats: [
    "The feed labelled wstETH/ETH is actually the stETH/ETH feed — its on-chain description() reads 'STETH / ETH'. It is a ~24h-heartbeat feed and is NOT the accruing wstETH rate. Do not use it to price wstETH without first resolving the feed Aave's oracle actually read at that block.",
    'usdeOnchain is a MARGINAL quote for a 1 USDe clip. It bottomed at $0.99683, but the same pool bottomed at $1.13M USDC of reserves — a 1,000,000 USDe sell realised an average of $0.9759 at the worst minute. "On-chain never broke $0.997" is true of the quote, not of exit liquidity at size.',
    'A prior session recorded the on-chain USDe minimum as $0.9957. That figure is NOT supported by this data: it appears only as a pre-existing assumption in a source-script comment (fetch_curve_depth.py), never as a measured output. The measured minimum is $0.99683 at 2025-10-10 22:56 UTC.',
    'Nulls are genuine gaps, never forward-filled. The `carried` columns mark minutes where the oracle held its previous round instead of printing a new one.',
    "Aave's liquidation close factor is documented, not on-chain readable; the measured repay distribution is the honest read of what liquidators actually did.",
    'Oracle and spot are different series. During the crash the ETH oracle printed 0.70% BELOW the Binance spot trough, while the BTC oracle bottomed 4 minutes late and 1.14% ABOVE it. Keying a liquidation model off spot will fire late for ETH and early for BTC.',
  ],
}

// --------------------------------------------------------------------- write
fs.mkdirSync(OUT, { recursive: true })
const write = (name: string, data: unknown) => {
  const p = path.join(OUT, name)
  fs.writeFileSync(p, JSON.stringify(data))
  console.log(`  ${name}  ${(fs.statSync(p).size / 1024).toFixed(0)} KB`)
}
console.log(`Writing ${OUT}`)
write('prices-1m.json', series)
write('protocols.json', protocols)
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log('  manifest.json')

// Report the measured extremes so the numbers quoted in docs/UI are traceable.
const lowOf = (col: (number | null)[]) => {
  let bi = -1
  let bv = Infinity
  col.forEach((v, i) => {
    if (v !== null && v < bv) {
      bv = v
      bi = i
    }
  })
  return { value: bv, ts: START + bi * STEP, utc: new Date((START + bi * STEP) * 1000).toISOString() }
}
console.log('\nMeasured lows (for docs — do not hand-edit these into the UI):')
for (const k of ['ethOracle', 'btcOracle', 'ethSpot', 'btcSpot', 'usdeSpot', 'usdeOnchain'] as const) {
  const l = lowOf(series.columns[k])
  console.log(`  ${k.padEnd(14)} ${String(l.value).padStart(12)}  ${l.utc}`)
}
