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
  // Some of the source CSVs are CRLF (csv.DictWriter on macOS); strip the \r so the
  // LAST column's name and values are not silently suffixed with it.
  const raw = fs
    .readFileSync(path.join(SRC, file), 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
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
const byMinute = <T>(
  rows: Record<string, string>[],
  key: string,
  f: (row: Record<string, string>) => T,
) => {
  const m = new Map<number, T>()
  for (const row of rows) {
    const t = num(row[key])
    if (t !== null) m.set(t, f(row))
  }
  return m
}

/**
 * ---------------------------------------------------------------------------
 * ORACLE COLUMNS: IN FORCE AT THE MINUTE **START**, NOT AT THE MINUTE END.
 * ---------------------------------------------------------------------------
 * `chainlink_1m.csv` holds each minute's LAST round (`fetch_chainlink.py:~130`,
 * `while rounds[i].updated_at_ts <= m_end`). Read as a price for that minute, that
 * cell is a LOOKAHEAD: an account liquidated 11 s into a minute gets priced at a round
 * that printed 40 s later, in a later block. Every consumer of this file reads a cell as
 * "the price during minute i", so the cell must be the round that was ALREADY IN FORCE
 * when minute i began:
 *
 *     columns.<feed>[i] = last round with updated_at_ts <= startTs + 60 * i
 *
 * The round log itself (`chainlink_rounds.csv`) is the source, not the pre-binned CSV,
 * so the binning is done here and is auditable. `chainlink_1m.csv` is still read for ONE
 * thing: its minute-0 cell is the SEED round (the round in force at the window open,
 * fetched from a 7,200-block lookback and therefore absent from the in-window round log).
 * That only holds while no feed prints inside minute 0, which is asserted below.
 *
 * `carried[i] == 0` marks a minute that OPENED on a round the previous minute did not
 * have — the same "a fresh print landed" signal the minute-end flag carried, moved onto
 * the same clock as the values. The counts are unchanged by the move (ETH 183, BTC 118).
 */
type Round = { ts: number; block: number; log: number; p: number }
const roundsByFeed = new Map<string, Round[]>()
for (const row of readCsv('chainlink_rounds.csv')) {
  const ts = num(row.updated_at_ts)
  const p = num(row.answer_float)
  const block = num(row.block_number)
  if (ts === null || p === null || block === null) continue
  const a = roundsByFeed.get(row.feed) ?? []
  a.push({ ts, block, log: num(row.log_index) ?? 0, p })
  roundsByFeed.set(row.feed, a)
}
for (const a of roundsByFeed.values()) {
  a.sort((x, y) => x.ts - y.ts || x.block - y.block || x.log - y.log)
}
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

/** Builds one oracle column on minute-START semantics, plus its `carried` flags. */
const oracleGrid = (feed: string, dp: number) => {
  const rs = roundsByFeed.get(feed) ?? []
  const seed = num(chainlink[0]?.[`${feed.replace('/', '_')}_oracle`])
  if (rs.some((x) => x.ts >= START && x.ts < START + STEP)) {
    throw new Error(
      `${feed}: a round prints inside minute 0, so chainlink_1m.csv's first cell is not ` +
        'the seed round. Fetch the seed explicitly before trusting this column.',
    )
  }
  const values: (number | null)[] = []
  const carried: number[] = []
  let i = 0
  let cur: Round | null = null
  let prevTs: number | null = null
  for (const t of minutes) {
    while (i < rs.length && rs[i].ts <= t) cur = rs[i++]
    values.push(r(cur ? cur.p : seed, dp))
    const key = cur ? cur.ts : null
    carried.push(prevTs === key ? 1 : 0)
    prevTs = key
  }
  return { values, carried }
}
const ethOracleCol = oracleGrid('ETH/USD', 2)
const btcOracleCol = oracleGrid('BTC/USD', 2)
const stethOracleCol = oracleGrid('wstETH/ETH', 6)

/**
 * ---------------------------------------------------------------------------
 * wstETH IN USD = ETH/USD x A CONSTANT WRAP RATE. THE MARKET STETH/ETH FEED IS NOT IT.
 * ---------------------------------------------------------------------------
 * This column used to be `stethEthOracle[i] * ethOracle[i]`, on the reasoning that the
 * ETH-denominated feed carried the Oct 10 staked-ETH depeg (0.99960 -> 0.95569) and that
 * a wstETH leg priced off raw ETH/USD would miss it. That reasoning was WRONG about the
 * thing being modelled: the depeg is real, but AAVE NEVER SAW IT.
 *
 * MEASURED, from Aave's own per-block prices recoverable out of the liquidation CSV.
 * For a single-collateral account, `total_collateral_base_usd / pre_collateral_normalized`
 * IS the unit price Aave's oracle returned at that block. Taking only the values agreed
 * to 1e-6 by >= 2 distinct users in the same (chain, block, asset), the wstETH price and
 * the WETH price paired at the same block give:
 *
 *   blk 23549967  wstETH 4358.822389 / WETH 3584.590591 = 1.21598891
 *   blk 23549982  wstETH 4203.314443 / WETH 3456.704609 = 1.21598890
 *   blk 23549989  wstETH 4203.314443 / WETH 3456.704600 = 1.21598891
 *   blk 23549991  wstETH 4203.314443 / WETH 3456.704600 = 1.21598891
 *   blk 23549993  wstETH 4203.314443 / WETH 3456.704600 = 1.21598891
 *   arb 388184135 wstETH 4271.328141 / WETH 3512.637428 = 1.21598891   (8 pairs in all)
 *
 * The ratio is CONSTANT to 8 decimal places across blocks over which the market
 * STETH/ETH feed moved 0.99960 -> 0.99394 -> 0.96171. Aave priced wstETH as
 * ETH/USD x the wstETH<->stETH WRAP RATE (a slow monotone accrual), and the market
 * depeg never entered it. Injecting the market feed into a wstETH leg does not
 * "restore" a move Aave made; it invents one Aave did not make.
 *
 *   columns.wstethOracle[i] = ethOracle[i] * WSTETH_WRAP_RATE
 *
 * The wrap rate is a CONSTANT, so it cancels out of every ratio p(t)/p(t0) this dataset
 * is read through; it is applied anyway so the absolute column is the real wstETH price
 * and not stETH's.
 *
 * columns.stethEthOracle IS STILL PUBLISHED, and it is flagged `notAaveOracle` in
 * meta.feedIdentity: it is the STETH/ETH market-rate feed
 * (0x86392dC19c0b719886221c78AB11eb8Cf5c52812, description() = "STETH / ETH"), it is a
 * genuine measurement of the Oct 10 depeg, and it is NOT what any lending venue in this
 * window priced a wstETH leg through. Do not multiply it into a wstETH leg.
 */
/** MEASURED wstETH<->stETH wrap rate on 2025-10-10, from Aave's own per-block prices. */
const WSTETH_WRAP_RATE = 1.215989
const wstethUsd: (number | null)[] = ethOracleCol.values.map((e) =>
  e === null ? null : r(e * WSTETH_WRAP_RATE, 2),
)
const wstethCarried: number[] = [...ethOracleCol.carried]

// Columnar layout — ~4x smaller than an array of objects over 2,880 rows.
const series = {
  startTs: START,
  stepSeconds: STEP,
  count: minutes.length,
  columns: {
    ethOracle: ethOracleCol.values,
    btcOracle: btcOracleCol.values,
    stethEthOracle: stethOracleCol.values,
    /**
     * wstETH in USD = ethOracle x WSTETH_WRAP_RATE (1.215989, measured from Aave's own
     * per-block prices). NOT stethEthOracle x ethOracle — see the block comment above.
     */
    wstethOracle: wstethUsd,
    ethSpot: minutes.map((t) => bn.get(t)?.eth ?? null),
    ethSpotLow: minutes.map((t) => bn.get(t)?.ethLow ?? null),
    btcSpot: minutes.map((t) => bn.get(t)?.btc ?? null),
    btcSpotLow: minutes.map((t) => bn.get(t)?.btcLow ?? null),
    usdeSpot: minutes.map((t) => bn.get(t)?.usde ?? null),
    usdeSpotLow: minutes.map((t) => bn.get(t)?.usdeLow ?? null),
    usdeOnchain: minutes.map((t) => cv.get(t)?.usdeChain ?? null),
  },
  /** 1 where the minute OPENED on the round the previous minute already had. */
  carried: {
    ethOracle: ethOracleCol.carried,
    btcOracle: btcOracleCol.carried,
    stethEthOracle: stethOracleCol.carried,
    /** Identical to ethOracle: the wrap rate is a constant and never prints a round. */
    wstethOracle: wstethCarried,
  },
  /** The semantics a consumer needs before reading a cell as "the price at minute i". */
  meta: {
    oracleSemantics: 'minute-start-in-force',
    wstethSemantics:
      'columns.wstethOracle[i] = ethOracle[i] x 1.215989 — the ETH/USD round in force at ' +
      'minute i times the MEASURED wstETH<->stETH wrap rate. It is NOT stethEthOracle x ' +
      'ethOracle. Aave priced wstETH through the wrap rate, not through the STETH/ETH ' +
      'market feed: across 8 block pairs where both a wstETH and a WETH price are ' +
      "recoverable from Aave's own state, wstETH/WETH is 1.21598891 to 8 decimal places " +
      'while the market STETH/ETH feed moved 0.99960 -> 0.96171. The wrap rate is a ' +
      'constant and cancels out of every ratio read from this column.',
    wstethWrapRate: WSTETH_WRAP_RATE,
    wstethWrapRateDerivation:
      'MEASURED. For a single-collateral Aave account, total_collateral_base_usd / ' +
      'pre_collateral_normalized is the unit price the oracle returned at block N-1. ' +
      'Taking only values agreed to 1e-6 by >= 2 distinct users in the same ' +
      '(chain, block, asset) and pairing the wstETH and WETH prices at the same block ' +
      'gives 1.21598891 on 8 of 9 pairs (the 9th pairs blocks 1 apart, so it measures a ' +
      'price change, not the wrap rate). Source rows: mainnet blocks 23549967 / 23549982 / ' +
      '23549983 / 23549986 / 23549987 / 23549989 / 23549991 / 23549993 and arbitrum ' +
      '388184135, in aave_liquidations_enriched.csv.',
    feedIdentity: {
      stethEthOracle: {
        proxy: '0x86392dC19c0b719886221c78AB11eb8Cf5c52812',
        description: 'STETH / ETH',
        notAaveOracle: true,
        reason:
          'This is the stETH/ETH MARKET-RATE feed. It measured a real 4.4% staked-ETH ' +
          'depeg on Oct 10 (0.99960 at 18:35 UTC to 0.95569 at 21:28 UTC) and it is ' +
          'published for that. It is NOT the series Aave priced wstETH collateral ' +
          "through: Aave's own per-block wstETH/WETH ratio is the constant wrap rate " +
          '1.21598891 across blocks spanning that collapse. Multiplying this column into ' +
          'a wstETH leg invents a move no lending venue in this window acted on.',
      },
    },
    oracleSemanticsDetail:
      'columns.ethOracle / btcOracle / stethEthOracle[i] is the last Chainlink round ' +
      'with updated_at_ts <= startTs + stepSeconds * i — the round ALREADY IN FORCE when ' +
      'minute i began. It is never a round that printed later inside minute i, so reading ' +
      'a cell as the price during minute i carries no lookahead. Built from the ' +
      'AnswerUpdated round log (chainlink_rounds.csv), not from the pre-binned ' +
      "chainlink_1m.csv, whose cells are each minute's LAST round (minute-END).",
    oracleSeed:
      'The round in force at the window open is older than the round log, so minute 0 is ' +
      'seeded from chainlink_1m.csv minute 0. That cell is the same round only because no ' +
      'feed printed inside minute 0; the builder throws if that ever stops holding.',
    carriedSemantics:
      'carried[i] == 1 when minute i opened on the same round minute i-1 had. Minute 0 is ' +
      'carried by definition (it opens on the seed).',
    spotSemantics:
      'The Binance and Curve columns are unchanged: per-minute klines / quotes keyed by ' +
      'minute_ts, with *Low the minute low. Only the ORACLE columns changed clock.',
  },
}

// ------------------------------------------------------- protocol parameters
const params = JSON.parse(fs.readFileSync(path.join(SRC, 'protocol_params_oct10.json'), 'utf8'))
const aaveWanted = [
  'WETH',
  'WBTC',
  'wstETH',
  'USDC',
  'USDT',
  'DAI',
  'cbBTC',
  'weETH',
  'rETH',
  'LINK',
]
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

const aaveRepay = JSON.parse(
  fs.readFileSync(path.join(SRC, 'aave_repay_distribution.json'), 'utf8'),
)
const morphoRepay = JSON.parse(
  fs.readFileSync(path.join(SRC, 'morpho_repay_distribution.json'), 'utf8'),
)
const oracleLag = JSON.parse(fs.readFileSync(path.join(SRC, 'oracle_lag_report.json'), 'utf8'))
const curveDepth = JSON.parse(
  fs.readFileSync(path.join(SRC, 'usde_curve_depth_summary.json'), 'utf8'),
)

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
    liquidationIncentive:
      params.morpho_blue?.liquidation_incentive_factor?.documented_constants ?? null,
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
    {
      series: 'ethOracle / btcOracle / stethEthOracle',
      source:
        'Chainlink AnswerUpdated round log via public JSON-RPC (Tenderly public gateway), binned to the round IN FORCE AT EACH MINUTE START',
      file: 'chainlink_rounds.csv (+ chainlink_1m.csv minute 0 for the seed round)',
    },
    {
      series: 'wstethOracle',
      source:
        'DERIVED: ethOracle (minute-START in force) x the measured wstETH<->stETH wrap rate 1.215989. NOT stethEthOracle x ethOracle: Aave priced wstETH through the wrap rate and never through the STETH/ETH market feed.',
      file: 'chainlink_rounds.csv + aave_liquidations_enriched.csv (wrap rate)',
    },
    {
      series: 'ethSpot / btcSpot / usdeSpot (+ lows)',
      source: 'Binance public 1m klines',
      file: 'binance_1m_48h.csv',
    },
    {
      series: 'usdeOnchain',
      source: 'Curve USDe/USDC pool quote for a 1 USDe clip, per minute',
      file: 'usde_curve_depth_1m.csv',
    },
    {
      series: 'protocol params',
      source: 'on-chain reads at mainnet block ' + params.read_block,
      file: 'protocol_params_oct10.json',
    },
    {
      series: 'measured liquidations',
      source: 'Aave/Morpho Liquidate event logs, decoded',
      file: 'aave_repay_distribution.json / morpho_repay_distribution.json',
    },
  ],
  caveats: [
    "The feed labelled wstETH/ETH is the stETH/ETH MARKET feed - its on-chain description() reads 'STETH / ETH'. It is deviation-triggered and on Oct 10 it fired 23 rounds between 18:35 and 22:07 UTC, collapsing 0.99960 -> 0.95569 between 21:20 and 21:28. That depeg is real and the column is published for it. It is NOT what priced a wstETH leg. columns.wstethOracle is ethOracle x 1.215989, the MEASURED wstETH<->stETH wrap rate: Aave\u2019s own per-block prices, recovered as total_collateral_base_usd / pre_collateral_normalized on single-collateral accounts agreed to 1e-6 by >= 2 distinct users, give wstETH/WETH = 1.21598891 to 8 decimal places across 8 block pairs spanning that collapse, so Aave never saw the market depeg at all. Injecting stethEthOracle into a wstETH leg does not restore a move Aave made, it invents one Aave did not make. meta.feedIdentity.stethEthOracle carries notAaveOracle: true.",
    'usdeOnchain is a MARGINAL quote for a 1 USDe clip. It bottomed at $0.99683, but the same pool bottomed at $1.13M USDC of reserves — a 1,000,000 USDe sell realised an average of $0.9759 at the worst minute. "On-chain never broke $0.997" is true of the quote, not of exit liquidity at size.',
    'A prior session recorded the on-chain USDe minimum as $0.9957. That figure is NOT supported by this data: it appears only as a pre-existing assumption in a source-script comment (fetch_curve_depth.py), never as a measured output. The measured minimum is $0.99683 at 2025-10-10 22:56 UTC.',
    'Nulls are genuine gaps, never forward-filled. The `carried` columns mark minutes where the oracle held its previous round instead of printing a new one.',
    'Oracle cells are the round IN FORCE AT THE MINUTE START (last round with updated_at_ts <= the minute boundary). The upstream chainlink_1m.csv binned each minute to its LAST round, which prices an event early in a minute at a round that printed after it. See prices-1m.json meta.oracleSemantics.',
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
  return {
    value: bv,
    ts: START + bi * STEP,
    utc: new Date((START + bi * STEP) * 1000).toISOString(),
  }
}
console.log('\nMeasured lows (for docs — do not hand-edit these into the UI):')
for (const k of [
  'ethOracle',
  'btcOracle',
  'stethEthOracle',
  'wstethOracle',
  'ethSpot',
  'btcSpot',
  'usdeSpot',
  'usdeOnchain',
] as const) {
  const l = lowOf(series.columns[k])
  console.log(`  ${k.padEnd(14)} ${String(l.value).padStart(12)}  ${l.utc}`)
}
