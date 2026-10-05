/**
 * Builds public/data/oct10-2025/evidence.json — the dataset behind /[chain]/evidence.
 *
 * SINGLE SOURCE OF TRUTH: this imports membraneCollateralRepayValue, BORROW_LTV_GAP,
 * CURE_WINDOW_SECONDS, MAX_THRESHOLD_TO_DELAY and LIQ_DEBT_MINIMUM_USD from
 * lib/position-sim/membrane.ts, and the delay-window walk itself from
 * lib/position-sim/curePath.ts — the SAME engine the per-address wallet simulator
 * runs (compare.ts drives the same DelayTimer state machine). An earlier version of
 * this builder was a hand-written Python port of that formula; two implementations of
 * one claim is how a marketing number silently drifts from the contract. Do not
 * reintroduce one.
 *
 * The Membrane side is NOT one repay. Each account's delay window is replayed minute
 * by minute against the real oracle grid: the band breaks it, a return under the line
 * re-arms it, expiry sells, and a sale restores the BORROW CAP rather than closing the
 * loan, so the position walks on and can be sold again.
 *
 * Source: 3,111 real Aave liquidation events from 10-11 Oct 2025, enriched with
 * pre-liquidation account state read at block_number-1.
 *
 * ---------------------------------------------------------------------------
 * THE BLOCK-1 REBASE (the defect this builder used to carry)
 * ---------------------------------------------------------------------------
 * Account state is read at `block_number - 1`, and each account's liquidation line is
 * inverted from the health factor in THAT snapshot (LT = hf x debt / coll). A fresh
 * oracle print landing between block-1 and the liquidating block is therefore invisible
 * to the snapshot: 599 accounts carried hf >= 1 there and were liquidated in the next
 * block anyway. Leaving their collateral at the block-1 value put them UNDER their own
 * line, so the model saw no breach, opened no window, closed ~$0 — and silently
 * credited Membrane with the whole $94.2M Aave closed on them.
 *
 * Every account is now REBASED to the liquidation-minute print before breach is
 * decided: the collateral leg (and the debt leg when the debt is not a stable) is
 * scaled by `p(t0) / p(t0-1)`, which is 1 whenever the t0 print was carried rather
 * than fresh. Accounts that are breached after the rebase walk normally. Accounts
 * STILL at or under their line after the rebase are a state/event mismatch this data
 * cannot resolve, so they are EXCLUDED from BOTH sides of every total (meta.excluded)
 * and kept in the cohort flagged `excluded: true`.
 *
 * Method note: each account is judged against ITS OWN liquidation line, inverted
 * from its measured health factor. The modelled per-asset MEMBRANE_ASSET_LTV is
 * deliberately NOT used — it is an assumption about a protocol with no mainnet
 * deployment, and leaning on it would make this a claim about our guess rather than
 * about our mechanism.
 *
 * Run: ./node_modules/.bin/tsx scripts/build-evidence.ts
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
  membraneCollateralRepayValue,
} from '../lib/position-sim/membrane'
import { cureWalk } from '../lib/position-sim/curePath'

const CSV = '/Users/EBmic/Downloads/oct10_data/aave_liquidations_enriched.csv'
const DATA_DIR = path.join(process.cwd(), 'public/data/oct10-2025')
const OUT = path.join(DATA_DIR, 'evidence.json')

/** Hard cap on sales per episode. The contract re-arms after every repay-to-cap. */
const MAX_SALES = 20

const STABLES = new Set([
  'USDC',
  'USDT',
  'USD₮0',
  'USDT0',
  'DAI',
  'GHO',
  'LUSD',
  'USDS',
  'sUSD',
  'FRAX',
  'USDC.e',
  'crvUSD',
  'MAI',
  'USDbC',
])
/**
 * ---------------------------------------------------------------------------
 * wstETH = ETH/USD x A CONSTANT WRAP RATE. THE MARKET STETH/ETH FEED IS NOT AAVE'S.
 * ---------------------------------------------------------------------------
 * Two wrong answers were given here in turn. The first proxied wstETH off raw ETH/USD on
 * the claim that staked-ETH assets "move less than 0.1%/day against ETH" - false for this
 * window. The second replaced that with (STETH/ETH market feed) x (ETH/USD), because that
 * feed really did collapse 0.99960 -> 0.95569 between 21:20 and 21:28 UTC. That fixed the
 * stated defect and introduced a bigger one: AAVE NEVER PRICED THROUGH THAT FEED.
 *
 * MEASURED, from Aave's own per-block prices. For a single-collateral account,
 * `total_collateral_base_usd / pre_collateral_normalized` IS the unit price Aave's oracle
 * returned at block N-1. Restricted to values agreed to 1e-6 by >= 2 distinct users in the
 * same (chain, block, asset), and pairing wstETH against WETH at the same block:
 *
 *   blk 23549967 4358.822389 / 3584.590591 = 1.21598891
 *   blk 23549982 4203.314443 / 3456.704609 = 1.21598890
 *   blk 23549989 4203.314443 / 3456.704600 = 1.21598891
 *   blk 23549993 4203.314443 / 3456.704600 = 1.21598891   (8 pairs in all, + arbitrum)
 *
 * Constant to 8 decimals across blocks over which the market feed moved 0.99960 ->
 * 0.99394 -> 0.96171. Aave priced wstETH as ETH/USD x the wstETH<->stETH WRAP RATE. The
 * market depeg never entered any Aave liquidation decision in this cohort.
 *
 * So every wstETH leg is ETH/USD in force x WSTETH_WRAP_RATE - for p_state, for p_liq and
 * for the minute grid. The wrap rate is a CONSTANT, so it cancels out of every ratio this
 * model reads: wstETH and WETH walk the identical path, which is the measured truth.
 *
 * The market-feed version is not deleted, it is PRICED: rebuilt as a full second cohort
 * and published as meta.sensitivity.wstethMarketFeedMembraneClosedUsd, so the dollars that
 * choice was worth are visible rather than buried in a pricing helper.
 */
const WSTETH = new Set(['wstETH'])
/**
 * THE REMAINING ETH PROXIES. weETH / rETH / cbETH / ETHx / osETH have no feed in this
 * dataset at all, so the raw ETH/USD path is still their ratio proxy — and the honest
 * statement is now the opposite of the old comment: each of these is a liquid-staking
 * receipt that CAN and did trade away from ETH during the Oct 10 depeg (the measured
 * stETH/ETH move was 4.4%), so pricing them off ETH/USD UNDER-states their breach. The
 * exposure is published under meta.collateralMapping.classes.proxied with its account
 * count and debt, and the headline is published both with and without the accounts the
 * model cannot fully price (doc.debt.priced vs doc.debt.allIncluded).
 */
const ETH_PROXY = new Set(['weETH', 'rETH', 'cbETH', 'ETHx', 'osETH'])
const ETH_LIKE = new Set(['WETH', 'ETH', ...ETH_PROXY])
const BTC_LIKE = new Set(['WBTC', 'BTC', 'cbBTC', 'tBTC', 'LBTC'])
/** Symbols with their OWN feed in force, rather than a stand-in for one. */
const EXACT_FEED = new Set(['WETH', 'ETH', 'WBTC', 'BTC', 'wstETH'])

// ---- price series --------------------------------------------------------
const px = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'prices-1m.json'), 'utf8'))
const P0: number = px.startTs
const STEP: number = px.stepSeconds
const ETH: number[] = px.columns.ethOracle
const BTC: number[] = px.columns.btcOracle
/** wstETH in USD: ethOracle x the measured wrap rate, minute-START. */
const WSTETH_USD: number[] = px.columns.wstethOracle
if (!Array.isArray(WSTETH_USD)) {
  throw new Error(
    'prices-1m.json has no wstethOracle column — rerun scripts/build-oct10-dataset.ts',
  )
}
/**
 * MEASURED wstETH<->stETH wrap rate, read from the dataset so the two builders cannot
 * drift. Its derivation is in prices-1m.json meta.wstethWrapRateDerivation.
 */
const WSTETH_WRAP_RATE: number = px.meta?.wstethWrapRate
if (!(WSTETH_WRAP_RATE > 1)) {
  throw new Error(
    'prices-1m.json has no meta.wstethWrapRate — rerun scripts/build-oct10-dataset.ts',
  )
}
/** The MARKET STETH/ETH feed. NOT Aave's. Used only to build the priced sensitivity. */
const STETH_ETH_MARKET: number[] = px.columns.stethEthOracle
const WSTETH_USD_MARKET: number[] = ETH.map((e, i) => e * STETH_ETH_MARKET[i])
/**
 * The wstETH pricing in force for the cohort being built. 'wrap' is the headline (what
 * Aave measurably did); 'market' rebuilds the whole census through the STETH/ETH market
 * feed so the difference can be published as a number.
 */
let WSTETH_MODE: 'wrap' | 'market' = 'wrap'
const NP = ETH.length
/** `carried[i] == 0` is a fresh oracle round at minute i. 183 of 2,880 for ETH. */
const FRESH_ETH = (px.carried?.ethOracle ?? []).filter((c: number) => !c).length
const FRESH_BTC = (px.carried?.btcOracle ?? []).filter((c: number) => !c).length
/** Fresh = at least ONE of the two composite legs printed into that minute. */
const FRESH_WSTETH = (px.carried?.wstethOracle ?? []).filter((c: number) => !c).length

const idx = (ts: number) => Math.max(0, Math.min(NP - 1, Math.floor((ts - P0) / STEP)))

/** A stable leg is a flat 1.0 series; that is a real series, not a missing one. */
const FLAT: number[] = new Array(NP).fill(1)
const seriesFor = (s: string): number[] | null =>
  STABLES.has(s)
    ? FLAT
    : WSTETH.has(s)
      ? WSTETH_MODE === 'market'
        ? WSTETH_USD_MARKET
        : WSTETH_USD
      : ETH_LIKE.has(s)
        ? ETH
        : BTC_LIKE.has(s)
          ? BTC
          : null

// ---- the Chainlink ROUND LOG: block-level in-force pricing ----------------
/**
 * ---------------------------------------------------------------------------
 * WHY THE MINUTE GRID CANNOT PRICE A LIQUIDATION
 * ---------------------------------------------------------------------------
 * prices-1m.json is a 1-minute grid. Breach is a BLOCK-level fact: the state is read at
 * block N-1 and the liquidation lands in block N, 12 seconds later. Pricing either one
 * from a minute cell puts a ±60 s error on a ±12 s question, and the error has a
 * direction — the old grid held each minute's LAST round, so an account liquidated 11 s
 * into a minute was rebased by a round that printed 40 s later, in a later block.
 *
 * So the rebase reads the ROUND LOG directly (chainlink_rounds.csv: feed, block_number,
 * log_index, updated_at_ts, answer):
 *
 *   p_state = the last round with block_number <= N-1   (what the snapshot could see)
 *   p_liq   = the last round with block_number <= N     (what the liquidation could see)
 *
 * A round in block N counts as in force at the liquidation ONLY IF IT CAME FIRST IN THE
 * BLOCK. Both logs carry a log_index: chainlink_rounds.csv has the AnswerUpdated's, and
 * aave_liquidations_enriched.csv has the LiquidationCall's. Within one block the EVM
 * orders logs by log_index, so a round with `log_index > the event's` executed AFTER the
 * liquidation and cannot have been what the liquidation read. The previous rule counted
 * every round in block N regardless of position, which back-dated same-block prints that
 * physically landed later in the block. The rule is now:
 *
 *   p_liq = last round with (block < N) or (block == N and round.log_index < event.log_index)
 *
 * The opposite corner — NO block-N round counted at all, so p_liq = p_state and nothing
 * is ever rebased — is still published as meta.sensitivity.alignment.
 *
 * NOT MAINNET: the round log is MAINNET Chainlink. Arbitrum / Base / Optimism carry
 * their own feeds on their own deviation clocks, and this dataset does not have them, so
 * their block numbers are not comparable to these. For those chains the same rule is
 * applied on TIMESTAMPS (p_liq = last round with updated_at_ts <= the event's ts;
 * p_state = last round strictly before it), which on mainnet is exactly equivalent to the
 * block form — mainnet block timestamps are strictly increasing, so "block <= N-1" and
 * "ts < ts(N)" select the same round. On an L2 it is a PROXY and is published as one.
 */
const ROUNDS_CSV = '/Users/EBmic/Downloads/oct10_data/chainlink_rounds.csv'
type Round = { ts: number; block: number; log: number; p: number }
type Feed = 'ETH/USD' | 'BTC/USD' | 'wstETH/ETH'
const FEEDS: Feed[] = ['ETH/USD', 'BTC/USD', 'wstETH/ETH']
const roundsByFeed = new Map<Feed, Round[]>()
{
  // chainlink_rounds.csv is CRLF (csv.DictWriter on macOS), so strip the \r.
  const rl = fs
    .readFileSync(ROUNDS_CSV, 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
  const rh = rl[0].split(',')
  const R = {
    feed: rh.indexOf('feed'),
    ts: rh.indexOf('updated_at_ts'),
    block: rh.indexOf('block_number'),
    log: rh.indexOf('log_index'),
    ans: rh.indexOf('answer_float'),
  }
  if (Object.values(R).some((i) => i < 0)) throw new Error('chainlink_rounds.csv: missing column')
  for (let i = 1; i < rl.length; i++) {
    const f = rl[i].split(',')
    const feed = f[R.feed] as Feed
    if (!FEEDS.includes(feed)) continue
    const a = roundsByFeed.get(feed) ?? []
    a.push({ ts: +f[R.ts], block: +f[R.block], log: +f[R.log], p: +f[R.ans] })
    roundsByFeed.set(feed, a)
  }
  for (const a of roundsByFeed.values()) {
    a.sort((x, y) => x.ts - y.ts || x.block - y.block || x.log - y.log)
  }
}
/**
 * The round in force at the window OPEN is older than the in-window round log, so it is
 * taken from the grid's minute 0 — which prices-1m.json now builds on the same
 * minute-START in-force rule (see its meta.oracleSemantics).
 */
const SEED: Record<Feed, number> = {
  'ETH/USD': ETH[0],
  'BTC/USD': BTC[0],
  // The ETH-denominated leg's own seed round, from the grid's minute 0.
  'wstETH/ETH': px.columns.stethEthOracle[0],
}

/** 'WSTETH' is a COMPOSITE leg: the ETH-denominated feed times ETH/USD. */
type Leg = Feed | 'WSTETH' | 'STABLE' | null
const feedFor = (s: string): Leg =>
  STABLES.has(s)
    ? 'STABLE'
    : WSTETH.has(s)
      ? 'WSTETH'
      : ETH_LIKE.has(s)
        ? 'ETH/USD'
        : BTC_LIKE.has(s)
          ? 'BTC/USD'
          : null

/** What a symbol's price series actually IS, published per class in meta. */
type PriceClass = 'exact' | 'stableFlat' | 'proxied' | 'unpriced'
const priceClass = (s: string): PriceClass =>
  STABLES.has(s)
    ? 'stableFlat'
    : EXACT_FEED.has(s)
      ? 'exact'
      : feedFor(s) !== null
        ? 'proxied'
        : 'unpriced'

/**
 * p in force at the SNAPSHOT block (N-1) and at the LIQUIDATING block (N).
 *
 * `log` is the LiquidationCall's own log_index. On mainnet a round in block N is in force
 * only if it came EARLIER in that block; on an L2 the mainnet round log is a timestamp
 * proxy and no log index is comparable, so the timestamp form stands.
 */
function inForcePair(feed: Feed, chain: string, block: number, ts: number, log: number) {
  const rs = roundsByFeed.get(feed) ?? []
  let state = SEED[feed]
  let liq = SEED[feed]
  for (const r of rs) {
    const seenByState = chain === 'mainnet' ? r.block <= block - 1 : r.ts < ts
    const seenByLiq =
      chain === 'mainnet' ? r.block < block || (r.block === block && r.log < log) : r.ts <= ts
    if (seenByState) state = r.p
    if (seenByLiq) liq = r.p
    // seenByState implies seenByLiq on both clocks, so nothing later can still be state.
    else if (!seenByState) break
  }
  return { state, liq }
}
/** Both legs of one event, with stables pinned at 1 and unpriceable symbols null. */
function legPrices(sym: string, chain: string, block: number, ts: number, log: number) {
  const f = feedFor(sym)
  if (f === 'STABLE') return { state: 1, liq: 1 }
  if (f === null) return null
  if (f === 'WSTETH') {
    const e = inForcePair('ETH/USD', chain, block, ts, log)
    // HEADLINE: a CONSTANT wrap rate, which cancels out of every ratio read from it.
    if (WSTETH_MODE !== 'market') {
      return { state: e.state * WSTETH_WRAP_RATE, liq: e.liq * WSTETH_WRAP_RATE }
    }
    // SENSITIVITY ONLY: the STETH/ETH market feed Aave measurably did not price through.
    const w = inForcePair('wstETH/ETH', chain, block, ts, log)
    return { state: e.state * w.state, liq: e.liq * w.liq }
  }
  return inForcePair(f, chain, block, ts, log)
}

// ---- csv -----------------------------------------------------------------
// CRLF (csv.DictWriter on macOS): strip the \r so the LAST column's name and values are
// not silently suffixed with it. position_read_ok is that last column.
const lines = fs
  .readFileSync(CSV, 'utf8')
  .trim()
  .split('\n')
  .map((l) => l.replace(/\r$/, ''))
const header = lines[0].split(',')
const col = (name: string) => {
  const i = header.indexOf(name)
  if (i < 0) throw new Error(`missing column: ${name}`)
  return i
}
const C = {
  ts: col('ts'),
  block: col('block_number'),
  seq: col('intra_block_seq'),
  /** The LiquidationCall's own log_index — the intra-block ordering key. */
  log: col('log_index'),
  chain: col('chain'),
  user: col('user'),
  coll: col('total_collateral_base_usd'),
  debt: col('total_debt_base_usd'),
  hf: col('health_factor'),
  cover: col('debt_to_cover_normalized'),
  csym: col('collateral_symbol'),
  dsym: col('debt_symbol'),
  casset: col('collateral_asset'),
  dasset: col('debt_asset'),
  preColl: col('pre_collateral_normalized'),
  preDebt: col('pre_debt_normalized'),
  readOk: col('position_read_ok'),
}

/**
 * ---------------------------------------------------------------------------
 * AAVE'S OWN PER-BLOCK ORACLE PRICE, RECOVERED FROM THE CSV.
 * ---------------------------------------------------------------------------
 * `getUserAccountData` returns totalCollateralBase in the pool's USD base currency, and
 * the enrichment read it at block N-1 alongside the user's aToken balance for the
 * liquidated reserve. For an account whose ONLY collateral is that reserve,
 *
 *     total_collateral_base_usd / pre_collateral_normalized
 *
 * IS the unit price Aave's oracle returned at block N-1 - not an estimate of it.
 *
 * Nothing in the CSV says which accounts are single-collateral, so the test is
 * AGREEMENT: two distinct users liquidated in the same block on the same asset whose
 * implied prices match to 1e-6 are both single-collateral, because a contaminated
 * numerator carries that user's own other collateral and cannot coincide with another
 * user's to six decimal places. Rows with intra_block_seq > 0 are excluded outright:
 * the enrichment subtracts prior same-block seizures from the DENOMINATOR
 * (enrich_aave_positions.py:155) and not from the numerator, so their ratio is mixed.
 *
 * This table is what meta.anchor is computed against, and what the aaveImplied anchor
 * mode prices p_state / p_liq from.
 */
interface ImpliedGroup {
  sym: string
  chain: string
  block: number
  ts: number
  /** Lowest LiquidationCall log_index in the group - the intra-block ordering key. */
  minLog: number
  byUser: Map<string, number>
}
const impliedCandidates = new Map<string, ImpliedGroup>()
/** Largest SINGLE Aave repay seen on each collateral symbol in the window, USD. */
const maxRepayByCollSymbol = new Map<string, number>()

interface Ev {
  ts: number
  block: number
  seq: number
  log: number
  chain: string
  coll: number
  debt: number
  hf: number
  csym: string
  dsym: string
  casset: string
  dasset: string
  repaidUsd: number
}
const accounts = new Map<string, Ev[]>()
/** Events whose DEBT symbol has no series at all — dropped at parse, published in meta. */
let unpricedDebtEvents = 0

for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split(',')
  const ts = +f[C.ts]
  const block = +f[C.block]
  const chain = f[C.chain]
  const coll = +f[C.coll]
  const debt = +f[C.debt]
  const hf = +f[C.hf]
  const dsym = f[C.dsym]

  // Aave's own implied collateral price at block N-1, before any other filter drops
  // the row - coverage of the anchor should not depend on the census's own cuts.
  if (+f[C.seq] === 0 && f[C.readOk] === 'True') {
    const lg = +f[C.log]
    const grab = (asset: string, sym: string, tag: string, v: number) => {
      const k = `${chain}|${block}|${asset}`
      let g = impliedCandidates.get(k)
      if (!g) {
        impliedCandidates.set(k, (g = { sym, chain, block, ts, minLog: lg, byUser: new Map() }))
      }
      if (lg < g.minLog) g.minLog = lg
      g.byUser.set(tag, v)
    }
    const preC = +f[C.preColl]
    if (coll > 0 && preC > 0) grab(f[C.casset], f[C.csym], f[C.user], coll / preC)
    const preD = +f[C.preDebt]
    if (debt > 0 && preD > 0) grab(f[C.dasset], dsym, `debt:${f[C.user]}`, debt / preD)
  }

  if (!(coll > 0 && debt > 0 && hf > 0)) continue
  // Aave's USD is valued at the debt price IN FORCE IN THE LIQUIDATING BLOCK, not at a
  // minute cell — the same clock the breach is decided on.
  const log = +f[C.log]
  const dp = legPrices(dsym, chain, block, ts, log)
  if (dp == null) {
    unpricedDebtEvents++
    continue
  }
  const repaidUsdHere = +f[C.cover] * dp.liq
  if (repaidUsdHere > (maxRepayByCollSymbol.get(f[C.csym]) ?? 0)) {
    maxRepayByCollSymbol.set(f[C.csym], repaidUsdHere)
  }

  const key = `${chain}:${f[C.user]}`
  if (!accounts.has(key)) accounts.set(key, [])
  accounts.get(key)!.push({
    ts,
    block,
    seq: +f[C.seq],
    log,
    chain,
    coll,
    debt,
    hf,
    csym: f[C.csym],
    dsym,
    casset: f[C.casset],
    dasset: f[C.dasset],
    repaidUsd: repaidUsdHere,
  })
}

/**
 * Resolve the candidates into `chain|block|asset -> Aave's price`, keeping only groups
 * where >= 2 distinct users agree to 1e-6. Debt-side and collateral-side observations of
 * the same asset in the same block are pooled: they are the same oracle read.
 */
const AAVE_PRICE = new Map<string, { p: number; users: number } & ImpliedGroup>()
for (const [k, g] of impliedCandidates) {
  const vals = [...g.byUser.values()]
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b)
  if (vals.length < 2) continue
  let best: number[] = []
  for (let i = 0; i < vals.length; i++) {
    const c = [vals[i]]
    for (let j = i + 1; j < vals.length; j++) {
      if (Math.abs(vals[j] / vals[i] - 1) < 1e-6) c.push(vals[j])
    }
    if (c.length > best.length) best = c
  }
  if (best.length < 2) continue
  AAVE_PRICE.set(k, {
    ...g,
    p: best.reduce((a, b) => a + b, 0) / best.length,
    users: best.length,
  })
}

// ---- per-account counterfactual -----------------------------------------
type WalkInput = Parameters<typeof cureWalk>[0]

/** Every knob a whole-cohort rebuild can turn. The headline is the default of each. */
interface CohortOpts {
  /**
   * The alignment knob. true (the headline) counts a round in the liquidating block N as
   * in force at the liquidation; false is the corner where it is not, so p_liq collapses
   * onto p_state and no account is ever rebased.
   */
  countBlockNRound?: boolean
  /**
   * 'wrap' (headline) prices wstETH as ETH/USD x the measured constant wrap rate, which
   * is what Aave measurably did. 'market' prices it through the STETH/ETH market feed,
   * which is the choice this builder used to make and which no Aave liquidation in this
   * cohort was decided on.
   */
  wsteth?: 'wrap' | 'market'
  /**
   * 'chainlink' (headline) takes p_state / p_liq from the Chainlink round log. 'aaveImplied'
   * replaces the LEVEL with Aave's own recovered price where one exists, keeping the round
   * log only for the block N-1 -> N change: p_state := implied, p_liq := implied x
   * (round in force at N / round in force at N-1).
   */
  anchor?: 'chainlink' | 'aaveImplied'
  /**
   * Per-collateral-symbol cap on what ONE Membrane sale may close, USD. Off by default.
   */
  repayCapBySymbol?: Map<string, number>
}

/** Walks every account once, under `opts`. */
function buildCohort(opts: CohortOpts = {}) {
  const countBlockNRound = opts.countBlockNRound ?? true
  WSTETH_MODE = opts.wsteth ?? 'wrap'
  const anchorMode = opts.anchor ?? 'chainlink'
  const cohort: any[] = []
  /** Kept so the band / floor / sale-cap can be re-swept without re-parsing the CSV. */
  const walkInputs: WalkInput[] = []
  /** Collateral-leg price class -> {accounts, debtUsd}, over INCLUDED rows only. */
  const classStats: Record<string, { accounts: number; debtUsd: number; symbols: Set<string> }> = {
    exact: { accounts: 0, debtUsd: 0, symbols: new Set() },
    stableFlat: { accounts: 0, debtUsd: 0, symbols: new Set() },
    proxied: { accounts: 0, debtUsd: 0, symbols: new Set() },
    unpriced: { accounts: 0, debtUsd: 0, symbols: new Set() },
  }
  let multiCollAccounts = 0
  let multiCollDebtUsd = 0
  let multiCollIncludedAccounts = 0
  let multiCollIncludedDebtUsd = 0
  let debtLegRatioAccounts = 0
  let debtLegRatioDebtUsd = 0

  for (const [key, evs] of accounts) {
    evs.sort((a, b) => a.ts - b.ts || a.seq - b.seq)
    const f = evs[0]
    const lt = (f.hf * f.debt) / f.coll // invert the measured health factor
    if (!(lt >= 0.3 && lt <= 0.95)) continue

    const i0 = idx(f.ts)
    const cs = seriesFor(f.csym)
    const ds = seriesFor(f.dsym)
    const collIsStable = STABLES.has(f.csym)
    const debtIsStable = STABLES.has(f.dsym)

    // --- rebase from the SNAPSHOT block to the LIQUIDATING block --------------
    // p_state is what block N-1 could see, p_liq what block N could. Both come from the
    // round log, so the rebase is exactly 1 unless a round actually landed in block N.
    const cp = legPrices(f.csym, f.chain, f.block, f.ts, f.log)
    const dp = legPrices(f.dsym, f.chain, f.block, f.ts, f.log)! // parse dropped unpriceable debt
    let pStateC = cp?.state ?? null
    let pLiqC = cp ? (countBlockNRound ? cp.liq : cp.state) : null
    let pStateD = dp.state
    let pLiqD = countBlockNRound ? dp.liq : dp.state

    // Aave's OWN price at this block, where two users' snapshots agree it is recoverable.
    const impliedC = AAVE_PRICE.get(`${f.chain}|${f.block}|${f.casset}`) ?? null
    const impliedD = AAVE_PRICE.get(`${f.chain}|${f.block}|${f.dasset}`) ?? null
    /** Aave's price over the Chainlink round in force at block N-1, minus 1. */
    const anchorResidual =
      impliedC && pStateC && pStateC > 0 ? impliedC.p / (cp?.state ?? pStateC) - 1 : null

    if (anchorMode === 'aaveImplied') {
      // Keep the round log for the CHANGE across the block, take the LEVEL from Aave.
      if (impliedC && cp && cp.state > 0) {
        const move = countBlockNRound ? cp.liq / cp.state : 1
        pStateC = impliedC.p
        pLiqC = impliedC.p * move
      }
      if (impliedD && dp.state > 0 && !STABLES.has(f.dsym)) {
        const move = countBlockNRound ? dp.liq / dp.state : 1
        pStateD = impliedD.p
        pLiqD = impliedD.p * move
      }
    }

    const rebaseColl = pStateC && pLiqC && pStateC > 0 ? pLiqC / pStateC : 1
    const rebaseDebt = !debtIsStable && pStateD > 0 ? pLiqD / pStateD : 1
    const collUsd = f.coll * rebaseColl
    const debtUsd = f.debt * rebaseDebt

    const ltv0 = debtUsd / collUsd
    /** Still not breached once rebased: a state/event mismatch the data cannot resolve. */
    const excluded = ltv0 <= lt

    const aaveUsd = Math.min(
      evs.reduce((s, e) => s + e.repaidUsd, 0),
      debtUsd,
    )
    // the shared engine, not a reimplementation
    // Collateral is the only payer: past L = 1 it closes at most its own value (the rest
    // is bad debt, LE:2361-2374), exactly as cureWalk books it.
    const oneRepayUsd = membraneCollateralRepayValue(
      debtUsd,
      collUsd,
      Math.max(0, lt - BORROW_LTV_GAP),
      LIQ_DEBT_MINIMUM_USD,
    )

    // The composite collateral/debt ratio series from this account's own t0 to the end
    // of the grid. Stable legs are a flat 1.0 series, so a stable-collateral /
    // volatile-debt account (USDC collateral, WETH debt) builds its ratio from the DEBT
    // leg instead of falling into the no-series bucket.
    //
    // ANCHOR: p_liq, not the grid cell at t0. Index 0 IS the liquidation, and the rebased
    // state is its state, so ratios[0] is 1 by construction. From index 1 the walk reads
    // grid minutes, which are the round in force at each minute START — so every later
    // minute is compared against the price that was actually in force when the account was
    // liquidated, with no minute of lookahead anywhere in the chain.
    let ratios: (number | null)[] | null = null
    if (cs && ds && pLiqC && NP - i0 > 1) {
      ratios = new Array(NP - i0)
      ratios[0] = 1
      for (let i = i0 + 1; i < NP; i++) {
        const cr = pLiqC > 0 ? cs[i] / pLiqC : null
        const dr = pLiqD > 0 ? ds[i] / pLiqD : null
        ratios[i - i0] = cr != null && dr != null && dr > 0 ? cr / dr : null
      }
    }

    const collClass = priceClass(f.csym)
    if (!excluded) {
      const cst = classStats[collClass]
      cst.accounts++
      cst.debtUsd += debtUsd
      cst.symbols.add(f.csym)
    }
    if (new Set(evs.map((e) => e.csym)).size > 1) {
      multiCollAccounts++
      multiCollDebtUsd += debtUsd
      // The subset that is actually WALKED. An excluded account is walked on no path at
      // all, so it cannot be mis-walked on the liquidated leg's; counting it would
      // overstate the exposure of the single-leg approximation.
      if (!excluded) {
        multiCollIncludedAccounts++
        multiCollIncludedDebtUsd += debtUsd
      }
    }
    if (collIsStable && !debtIsStable && ratios) {
      debtLegRatioAccounts++
      debtLegRatioDebtUsd += debtUsd
    }

    // The modelled delay window, per LiquidationEngine.sol. See lib/position-sim/curePath.ts
    // for the clause-by-clause contract citations.
    const walkInput: WalkInput = {
      debtUsd,
      collateralUsd: collUsd,
      line: lt,
      band: MAX_THRESHOLD_TO_DELAY,
      delaySeconds: CURE_WINDOW_SECONDS,
      stepSeconds: STEP,
      gap: BORROW_LTV_GAP,
      ratios,
      debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
      maxSales: MAX_SALES,
      maxRepayPerSaleUsd: opts.repayCapBySymbol?.get(f.csym),
    }
    const walk = cureWalk(walkInput)
    walkInputs.push(walkInput)
    const memUsd = walk.closedUsd

    let cure: any = null
    if (ratios) {
      const i1 = Math.min(ratios.length - 1, Math.round(CURE_WINDOW_SECONDS / STEP))
      if (i1 > 0) {
        let best = Infinity
        let bestMin = 0
        let last = 1
        for (let i = 0; i <= i1; i++) {
          const r = ratios[i] ?? last
          last = r
          const ltv = ltv0 / r
          if (ltv < best) {
            best = ltv
            bestMin = (i * STEP) / 60
          }
        }
        const end = ltv0 / (ratios[i1] ?? last)
        cure = {
          curedInWindow: best <= lt,
          healthyAt8h: end <= lt,
          minutesToCure: best <= lt ? bestMin : null,
          bestLtv: +best.toFixed(5),
          endLtv: +end.toFixed(5),
        }
      }
    }

    const [chain, user] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    cohort.push({
      chain,
      user,
      events: evs.length,
      /** Grid index of t0 in prices-1m.json. closedAtIndex is relative to this. */
      t0Index: i0,
      t0Ts: P0 + i0 * STEP,
      /** The liquidating block, and the two prices the rebase is the ratio of. */
      block: f.block,
      pStateColl: pStateC == null ? null : +pStateC.toFixed(6),
      pLiqColl: pLiqC == null ? null : +pLiqC.toFixed(6),
      pStateDebt: +pStateD.toFixed(6),
      pLiqDebt: +pLiqD.toFixed(6),
      /** Aave's OWN collateral price at block N-1, when >= 2 users' snapshots agree. */
      aaveImpliedColl: impliedC ? +impliedC.p.toFixed(8) : null,
      aaveImpliedCollUsers: impliedC ? impliedC.users : null,
      /** impliedColl / (Chainlink round in force at N-1) - 1. Null when unrecoverable. */
      anchorResidual: anchorResidual === null ? null : +anchorResidual.toFixed(6),
      // The MODELLED basis: block-1 state rebased to the liquidation-minute print.
      collateralUsd: +collUsd.toFixed(2),
      debtUsd: +debtUsd.toFixed(2),
      // What the enriched CSV actually read at block_number-1, kept for provenance.
      snapshotCollateralUsd: +f.coll.toFixed(2),
      snapshotDebtUsd: +f.debt.toFixed(2),
      rebaseColl: +rebaseColl.toFixed(6),
      rebaseDebt: +rebaseDebt.toFixed(6),
      healthFactor: +f.hf.toFixed(6),
      liqLine: +lt.toFixed(5),
      ltv0: +ltv0.toFixed(5),
      ltv0Snapshot: +(f.debt / f.coll).toFixed(5),
      excluded,
      collSymbol: f.csym,
      debtSymbol: f.dsym,
      /** What the collateral leg was priced through: exact / stableFlat / proxied / unpriced. */
      collClass,
      /**
       * TRUE when the whole cure model is applicable to this row: the collateral leg has a
       * series (exact, flat-$1 or proxied) so the walk can read a band, a cure and a
       * re-arm. FALSE rows get ONE repay and can never cure — they are the reason
       * doc.debt publishes `priced` and `allIncluded` side by side.
       */
      priced: ratios != null,
      aaveClosedUsd: +aaveUsd.toFixed(2),
      membraneClosedUsd: +memUsd.toFixed(2),
      membraneOneRepayUsd: +oneRepayUsd.toFixed(2),
      aaveClosedFrac: +(aaveUsd / debtUsd).toFixed(5),
      membraneClosedFrac: +(memUsd / debtUsd).toFixed(5),
      outcome: walk.outcome,
      closedAtIndex: walk.closedAtIndex,
      minutesToFirstCure: walk.minutesToFirstCure,
      breaches: walk.breaches,
      sales: walk.sales,
      cure,
    })
  }

  return {
    cohort,
    walkInputs,
    classStats,
    multiCollAccounts,
    multiCollDebtUsd,
    multiCollIncludedAccounts,
    multiCollIncludedDebtUsd,
    debtLegRatioAccounts,
    debtLegRatioDebtUsd,
  }
}

/** The headline model: a round in the liquidating block counts as in force. */
const built = buildCohort({ countBlockNRound: true })
const {
  cohort,
  walkInputs,
  classStats,
  multiCollAccounts,
  multiCollDebtUsd,
  multiCollIncludedAccounts,
  multiCollIncludedDebtUsd,
  debtLegRatioAccounts,
  debtLegRatioDebtUsd,
} = built

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const r2 = (x: number) => +x.toFixed(2)

// ---- included vs excluded ------------------------------------------------
/** Every summary number below is over INCLUDED rows. The cohort array keeps both. */
const included = cohort.filter((r) => !r.excluded)
const excludedRows = cohort.filter((r) => r.excluded)

const n = included.length
const aU = sum(included.map((r) => r.aaveClosedUsd))
const mU = sum(included.map((r) => r.membraneClosedUsd))
const mOne = sum(included.map((r) => r.membraneOneRepayUsd))

/**
 * THE ONE REMAINING ALIGNMENT SENSITIVITY. The headline counts a round in the
 * liquidating block N as in force at the liquidation; this corner does not, so p_liq
 * collapses onto p_state, nothing is ever rebased, and breach is decided on the raw
 * block-1 snapshot. It replaces the old t0±1 minute sweep, which is moot now that no
 * dollar is decided from a minute cell.
 */
const alt = buildCohort({ countBlockNRound: false })
const altIncluded = alt.cohort.filter((r: any) => !r.excluded)
const alignment = {
  countsBlockNRound: true,
  blockNMinus1: {
    accounts: altIncluded.length,
    excludedAccounts: alt.cohort.length - altIncluded.length,
    aaveClosedUsd: r2(sum(altIncluded.map((r: any) => r.aaveClosedUsd))),
    membraneClosedUsd: r2(sum(altIncluded.map((r: any) => r.membraneClosedUsd))),
  },
  note:
    'Headline: p_liq is the last round with block_number <= N, so a round in the ' +
    'liquidating block is in force at the liquidation (Aave liquidationCall reverts ' +
    'while HF >= 1, so a crash print in that block preceded the call). blockNMinus1 is ' +
    'the corner where it is not counted: p_liq = p_state, no account is ever rebased, ' +
    'and breach is read straight off the block-1 snapshot. Non-mainnet chains use the ' +
    'timestamp form of the same rule against the MAINNET round log, which is a proxy: ' +
    'their own feeds ran on their own deviation clocks and are not in this dataset.',
}

// ---- WHAT AAVE ACTUALLY PRICED: the anchor residual ----------------------
/**
 * ---------------------------------------------------------------------------
 * THE ANCHOR, AND WHY NO BLOCK RULE FIXES IT.
 * ---------------------------------------------------------------------------
 * `AAVE_PRICE` holds the unit price Aave's oracle returned at block N-1, recovered from
 * the CSV itself and confirmed by >= 2 users' snapshots agreeing to 1e-6. Comparing it to
 * the Chainlink round this builder selects is the only end-to-end check the pricing chain
 * has, so it is computed and published rather than assumed.
 *
 * MEASURED RESULT: the residual does not collapse under ANY block rule. Selecting the
 * round in force at N-2, N-1, N, or N-with-the-log-index-filter moves the mainnet WETH
 * median by hundredths of a percent and leaves the tail untouched, and NOT ONE of Aave's
 * recovered prices equals ANY round in the log to 1e-6 - at any block, anywhere in the
 * window. The round log is internally complete (agg_round_id is contiguous, one
 * aggregator, one phase), so this is not a fetch gap that a different selection could
 * recover: the ETH/USD series in this dataset is simply not the series Aave read.
 *
 * So the instruction's fallback applies and is implemented: `anchor: 'aaveImplied'`
 * rebuilds the whole cohort with p_state := Aave's own price and p_liq := that price x
 * (round at N / round at N-1), keeping the round log only for the CHANGE across the block.
 * Its total is published below. The reason it moves so little is worth stating: every
 * quantity this model reads is a RATIO - the rebase is p_liq/p_state, the walk is
 * grid[i]/p_liq, and the USD levels come from Aave's own totalCollateralBase - so a
 * constant level shift cancels almost everywhere. What does NOT cancel is grid[i]/p_liq,
 * where the numerator stays a Chainlink round while the denominator becomes Aave's price;
 * that mismatch is exactly the residual, and the published delta is its dollar size.
 */
const roundInForce = (
  feed: Feed,
  chain: string,
  block: number,
  ts: number,
  log: number,
  mode: string,
) => {
  const rs = roundsByFeed.get(feed) ?? []
  let v: number | null = SEED[feed]
  for (const r of rs) {
    const ok =
      chain !== 'mainnet'
        ? mode === 'N'
          ? r.ts <= ts
          : r.ts < ts
        : mode === 'N-2'
          ? r.block <= block - 2
          : mode === 'N-1'
            ? r.block <= block - 1
            : mode === 'N'
              ? r.block <= block
              : r.block < block || (r.block === block && r.log < log)
    if (ok) v = r.p
    else break
  }
  return v
}
const quant = (xs: number[], f: number) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(f * s.length))]
}
/** Every recovered price whose symbol has a feed, i.e. every point the check can run on. */
const anchorPoints = [...AAVE_PRICE.values()].filter((g) => {
  const f = feedFor(g.sym)
  return f !== null && f !== 'STABLE'
})
const residualsUnder = (mode: string, only?: PriceClass) =>
  anchorPoints
    .filter((g) => (only ? priceClass(g.sym) === only : true))
    .map((g) => {
      const f = feedFor(g.sym)
      const r =
        f === 'WSTETH'
          ? (roundInForce('ETH/USD', g.chain, g.block, g.ts, g.minLog, mode) ?? 0) *
            WSTETH_WRAP_RATE
          : roundInForce(f as Feed, g.chain, g.block, g.ts, g.minLog, mode)
      return r && r > 0 ? 100 * (g.p / r - 1) : null
    })
    .filter((x): x is number => x !== null)
const residualBlock = (mode: string, only?: PriceClass) => {
  const signed = residualsUnder(mode, only)
  const abs = signed.map(Math.abs)
  return {
    points: signed.length,
    medianAbsPct: +quant(abs, 0.5).toFixed(4),
    p90AbsPct: +quant(abs, 0.9).toFixed(4),
    maxAbsPct: +(abs.length ? Math.max(...abs) : 0).toFixed(4),
    over1Pct: abs.filter((x) => x > 1).length,
    medianSignedPct: +quant(signed, 0.5).toFixed(4),
  }
}
/** Does Aave's price equal ANY round in the log, at any block? */
const exactMatchAnyRound = anchorPoints.filter((g) => {
  const f = feedFor(g.sym)
  const feed: Feed = f === 'WSTETH' ? 'ETH/USD' : (f as Feed)
  const scale = f === 'WSTETH' ? WSTETH_WRAP_RATE : 1
  return (roundsByFeed.get(feed) ?? []).some((r) => Math.abs((r.p * scale) / g.p - 1) < 1e-6)
}).length
const anchorCoverage = (rows: any[]) => {
  const withAnchor = rows.filter((r) => r.anchorResidual !== null)
  return {
    accounts: rows.length,
    accountsAnchored: withAnchor.length,
    anchoredDebtUsd: r2(sum(withAnchor.map((r) => r.debtUsd))),
    anchoredShareOfDebt:
      sum(rows.map((r) => r.debtUsd)) > 0
        ? +(sum(withAnchor.map((r) => r.debtUsd)) / sum(rows.map((r) => r.debtUsd))).toFixed(4)
        : 0,
  }
}

// ---- whole-cohort rebuilds: the three choices that are worth a number ----
/** Sum a rebuilt cohort the same way the headline sets are summed. */
const rebuiltTotals = (built: { cohort: any[] }) => {
  const inc = built.cohort.filter((x: any) => !x.excluded)
  const pr = inc.filter((x: any) => x.priced)
  const tot = (rows: any[]) => ({
    accounts: rows.length,
    aaveClosedUsd: r2(sum(rows.map((x) => x.aaveClosedUsd))),
    membraneClosedUsd: r2(sum(rows.map((x) => x.membraneClosedUsd))),
    membraneOneRepayUsd: r2(sum(rows.map((x) => x.membraneOneRepayUsd))),
  })
  return {
    priced: tot(pr),
    allIncluded: tot(inc),
    excludedAccounts: built.cohort.length - inc.length,
  }
}

/**
 * SENSITIVITY: wstETH priced through the STETH/ETH MARKET feed instead of the wrap rate.
 * This is what this builder used to do. Aave's own per-block prices say it never happened,
 * so this is published as the size of that error, not as an alternative reading.
 */
const wstethMarketBuilt = buildCohort({ wsteth: 'market' })
WSTETH_MODE = 'wrap'
const wstethMarketTotals = rebuiltTotals(wstethMarketBuilt)
/** Accounts the market feed moves most - it breaks them out of the band on its own. */
const wstethMarketMovers = (() => {
  const base = new Map(cohort.map((r: any) => [`${r.chain}:${r.user}`, r]))
  return wstethMarketBuilt.cohort
    .map((r: any) => {
      const b = base.get(`${r.chain}:${r.user}`)
      return {
        account: `${r.chain}:${r.user}`,
        collSymbol: r.collSymbol,
        deltaUsd: r2(r.membraneClosedUsd - (b?.membraneClosedUsd ?? 0)),
        outcomeWrap: b?.outcome ?? null,
        outcomeMarketFeed: r.outcome,
      }
    })
    .filter((x) => Math.abs(x.deltaUsd) > 1_000_000)
    .sort((a, b) => b.deltaUsd - a.deltaUsd)
})()

/** SENSITIVITY: p_state / p_liq anchored to Aave's own recovered price. */
const anchoredBuilt = buildCohort({ anchor: 'aaveImplied' })
const anchoredTotals = rebuiltTotals(anchoredBuilt)

/**
 * SENSITIVITY: the EXECUTION BOUND, priced instead of only named.
 * Membrane's repay-to-cap is sized from the ORACLE value of the collateral. Cap what one
 * sale may close at the LARGEST SINGLE REPAY REAL AAVE LIQUIDATORS MANAGED on that
 * collateral asset that day - a measured number, not a modelled haircut. The remainder of
 * the position walks on and can be sold again at a later minute, so this bounds the
 * per-block clip, not the episode.
 */
const liquidityCapTable = [...maxRepayByCollSymbol.entries()]
  .map(([symbol, usd]) => ({ symbol, largestSingleAaveRepayUsd: r2(usd) }))
  .sort((a, b) => b.largestSingleAaveRepayUsd - a.largestSingleAaveRepayUsd)
const cappedBuilt = buildCohort({ repayCapBySymbol: maxRepayByCollSymbol })
const cappedTotals = rebuiltTotals(cappedBuilt)

/**
 * CONCENTRATION ON DISTINCT WALLETS. The cohort is keyed `chain:address`, so one address
 * liquidated on mainnet and on Base is two rows and a top-1 share computed over rows
 * UNDER-states how concentrated the result is on real counterparties. This dedupes on the
 * lowercased address and sums across chains.
 */
const walletConcentration = (rows: any[], valueOf: (r: any) => number, label: string) => {
  const byWallet = new Map<string, { usd: number; chains: Set<string> }>()
  for (const r of rows) {
    const k = String(r.user).toLowerCase()
    const w = byWallet.get(k) ?? { usd: 0, chains: new Set<string>() }
    w.usd += valueOf(r)
    w.chains.add(r.chain)
    byWallet.set(k, w)
  }
  const xs = [...byWallet.entries()]
    .map(([user, w]) => ({ user, usd: w.usd, chains: [...w.chains].sort() }))
    .sort((a, b) => b.usd - a.usd)
  const tot = sum(xs.map((x) => x.usd))
  return {
    label,
    rows: rows.length,
    distinctWallets: xs.length,
    crossChainWallets: xs.filter((x) => x.chains.length > 1).length,
    totalUsd: r2(tot),
    top1Share: tot > 0 ? +((xs[0]?.usd ?? 0) / tot).toFixed(4) : 0,
    top5Share: tot > 0 ? +(sum(xs.slice(0, 5).map((x) => x.usd)) / tot).toFixed(4) : 0,
    top1Wallet: xs[0]?.user ?? null,
    top1Usd: r2(xs[0]?.usd ?? 0),
    top5Wallets: xs.slice(0, 5).map((x) => x.user),
  }
}

/** The excluded set, characterised — a cohort this size cannot be dropped unexamined. */
const CRASH_FROM = 1760130000 // 2025-10-10 21:00 UTC
const CRASH_TO = 1760131800 // 2025-10-10 21:30 UTC
const excludedStats = {
  accounts: excludedRows.length,
  aaveClosedUsd: r2(sum(excludedRows.map((r) => r.aaveClosedUsd))),
  medianDebtUsd: r2(median(excludedRows.map((r) => r.debtUsd))),
  medianDebtUsdIncluded: r2(median(included.map((r) => r.debtUsd))),
  inCrashWindowAccounts: excludedRows.filter((r) => r.t0Ts >= CRASH_FROM && r.t0Ts < CRASH_TO)
    .length,
  inCrashWindowPct: excludedRows.length
    ? +(
        (100 * excludedRows.filter((r) => r.t0Ts >= CRASH_FROM && r.t0Ts < CRASH_TO).length) /
        excludedRows.length
      ).toFixed(2)
    : 0,
  crashWindowUtc: '2025-10-10T21:00Z to 21:30Z',
  byChain: excludedRows.reduce((m: Record<string, number>, r) => {
    m[r.chain] = (m[r.chain] ?? 0) + 1
    return m
  }, {}),
  healthFactorAtSnapshotAtLeast1: excludedRows.filter((r) => r.healthFactor >= 1).length,
  rebasedAtAll: excludedRows.filter(
    (r) => Math.abs(r.rebaseColl - 1) > 1e-9 || Math.abs(r.rebaseDebt - 1) > 1e-9,
  ).length,
  noCollateralSeries: excludedRows.filter((r) => r.pLiqColl === null).length,
  /**
   * MUTUALLY EXCLUSIVE, in priority order, so the shares sum to 1. The overlapping raw
   * counts above are kept because a row can fail for more than one reason at once.
   */
  byReason: (() => {
    const bucket = (r: any) =>
      r.chain !== 'mainnet'
        ? 'l2TimestampProxy'
        : r.pLiqColl === null
          ? 'collateralUnpriced'
          : r.healthFactor >= 1
            ? 'snapshotHealthyNoBlockNRound'
            : 'other'
    const out: Record<string, { accounts: number; aaveClosedUsd: number }> = {}
    for (const r of excludedRows) {
      const b = (out[bucket(r)] ??= { accounts: 0, aaveClosedUsd: 0 })
      b.accounts++
      b.aaveClosedUsd += r.aaveClosedUsd
    }
    for (const b of Object.values(out)) b.aaveClosedUsd = r2(b.aaveClosedUsd)
    return out
  })(),
  byReasonNote:
    'Priority order: l2TimestampProxy (the mainnet round log is only a timestamp proxy ' +
    'off mainnet, so the block rule cannot be applied at all) > collateralUnpriced (no ' +
    'series, so no rebase could be computed) > snapshotHealthyNoBlockNRound (Aave read ' +
    'hf >= 1 at block N-1 and no earlier-in-block N round exists to rebase it into a ' +
    'breach) > other.',
}
const cur = included.filter((r) => r.cure)
const cured = cur.filter((r) => r.cure.curedInWindow)
const healthy = cur.filter((r) => r.cure.healthyAt8h)

const byAsset: Record<string, any> = {}
for (const r of included) (byAsset[r.collSymbol] ??= []).push(r)
const byAssetOut: Record<string, any> = {}
for (const [sym, g] of Object.entries(byAsset) as [string, any[]][]) {
  if (g.length < 20) continue
  const gc = g.filter((r) => r.cure)
  byAssetOut[sym] = {
    accounts: g.length,
    aaveMedianFrac: +median(g.map((r) => r.aaveClosedFrac)).toFixed(5),
    membraneMedianFrac: +median(g.map((r) => r.membraneClosedFrac)).toFixed(5),
    curedPct: gc.length
      ? +((100 * gc.filter((r) => r.cure.curedInWindow).length) / gc.length).toFixed(2)
      : null,
  }
}

// ---- delay-window diagnostics -------------------------------------------
const outcomes: Record<string, number> = {}
for (const r of included) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1

/**
 * How much of the delay window's credit comes from how fast the price came back.
 * "Credit" is the debt a one-repay engine would have closed and the delay engine
 * did not, on accounts that actually got back under their line at least once.
 */
const curedRows = included.filter((r) => r.minutesToFirstCure != null)
const creditOf = (r: any) => Math.max(0, r.membraneOneRepayUsd - r.membraneClosedUsd)
const cureCreditTotal = sum(curedRows.map(creditOf))
const creditWithin = (mins: number) =>
  sum(curedRows.filter((r) => r.minutesToFirstCure <= mins).map(creditOf))
const shareWithin = (mins: number) =>
  cureCreditTotal > 0 ? +((100 * creditWithin(mins)) / cureCreditTotal).toFixed(2) : 0

/** Gross / counter decomposition of the NET delay credit, over included rows. */
const cureCreditGrossUsd = sum(included.map(creditOf))
const counterCreditUsd = sum(
  included.map((r) => Math.max(0, r.membraneClosedUsd - r.membraneOneRepayUsd)),
)
const counterCreditAccounts = included.filter(
  (r) => r.membraneClosedUsd > r.membraneOneRepayUsd + 0.01,
).length

/** Aave minus Membrane, per outcome bucket. Where the headline gap actually lives. */
const gapByOutcome: Record<string, any> = {}
for (const r of included) {
  const g = (gapByOutcome[r.outcome] ??= {
    accounts: 0,
    aaveClosedUsd: 0,
    membraneClosedUsd: 0,
    gapUsd: 0,
  })
  g.accounts++
  g.aaveClosedUsd += r.aaveClosedUsd
  g.membraneClosedUsd += r.membraneClosedUsd
  g.gapUsd += r.aaveClosedUsd - r.membraneClosedUsd
}
for (const g of Object.values(gapByOutcome) as any[]) {
  g.aaveClosedUsd = r2(g.aaveClosedUsd)
  g.membraneClosedUsd = r2(g.membraneClosedUsd)
  g.gapUsd = r2(g.gapUsd)
}

/**
 * How concentrated the gap is. One account can carry a marketing number, so this has to
 * be published. The NET gap is small and can be negative, which makes it a useless
 * denominator, so the shares are taken against the POSITIVE side of the gap — the total
 * across accounts where Aave closed more than Membrane — and the negative side is
 * published next to it.
 */
const gapRows = [...included]
  .map((r) => ({ user: r.user, chain: r.chain, gap: r.aaveClosedUsd - r.membraneClosedUsd }))
  .sort((a, b) => b.gap - a.gap)
const gapPositive = sum(gapRows.filter((g) => g.gap > 0).map((g) => g.gap))
const gapNegative = sum(gapRows.filter((g) => g.gap < 0).map((g) => g.gap))
const concentration = {
  netGapUsd: r2(aU - mU),
  gapPositiveUsd: r2(gapPositive),
  gapNegativeUsd: r2(gapNegative),
  shareDenominator: 'gapPositiveUsd',
  top1Share: gapPositive > 0 ? +((gapRows[0]?.gap ?? 0) / gapPositive).toFixed(4) : 0,
  top5Share:
    gapPositive > 0 ? +(sum(gapRows.slice(0, 5).map((g) => g.gap)) / gapPositive).toFixed(4) : 0,
  top1Account: gapRows[0] ? `${gapRows[0].chain}:${gapRows[0].user}` : null,
  top1GapUsd: r2(gapRows[0]?.gap ?? 0),
}
/**
 * The same concentration against the ABSOLUTE gap — sum |Aave - Membrane| over the
 * included rows, ranked by |gap|. The positive-side view above answers "who carries the
 * debt Aave closed and Membrane did not"; this one answers "how few accounts decide the
 * headline at all", which is the question a single big row can quietly win.
 */
const absRows = [...included]
  .map((r) => ({
    user: r.user,
    chain: r.chain,
    abs: Math.abs(r.aaveClosedUsd - r.membraneClosedUsd),
  }))
  .sort((a, b) => b.abs - a.abs)
const gapAbsolute = sum(absRows.map((g) => g.abs))
const absoluteConcentration = {
  shareDenominator: 'gapAbsoluteUsd',
  gapAbsoluteUsd: r2(gapAbsolute),
  top1Share: gapAbsolute > 0 ? +((absRows[0]?.abs ?? 0) / gapAbsolute).toFixed(4) : 0,
  top5Share:
    gapAbsolute > 0 ? +(sum(absRows.slice(0, 5).map((g) => g.abs)) / gapAbsolute).toFixed(4) : 0,
  top1Account: absRows[0] ? `${absRows[0].chain}:${absRows[0].user}` : null,
  top1AbsGapUsd: r2(absRows[0]?.abs ?? 0),
}

// ---- the shapes the headline is made of ----------------------------------
/** Never sold across the whole window. The delay window's clearest outcome. */
const heldRows = included.filter((r) => r.closedAtIndex === null)
const heldWholeDay = {
  accounts: heldRows.length,
  debtUsd: r2(sum(heldRows.map((r) => r.debtUsd))),
  aaveClosedUsd: r2(sum(heldRows.map((r) => r.aaveClosedUsd))),
  medianDebtUsd: r2(median(heldRows.map((r) => r.debtUsd))),
}
/** Already past line x (1+band) at t0: no delay is ever granted, so Membrane sells too. */
const t0Rows = included.filter((r) => r.outcome === 'sold-at-t0')
const soldAtT0 = {
  accounts: t0Rows.length,
  debtUsd: r2(sum(t0Rows.map((r) => r.debtUsd))),
  membraneClosedUsd: r2(sum(t0Rows.map((r) => r.membraneClosedUsd))),
  aaveClosedUsd: r2(sum(t0Rows.map((r) => r.aaveClosedUsd))),
  /** How far past its own line the position already was, as a fraction of the line. */
  medianDistancePastLinePct: +(100 * median(t0Rows.map((r) => r.ltv0 / r.liqLine - 1))).toFixed(3),
  bandPct: 100 * MAX_THRESHOLD_TO_DELAY,
}
/**
 * PER-ACCOUNT MEDIANS. The all-included median is a dust artefact: the $2,000 floor
 * closes any position whose repay-to-cap lands under it WHOLE, and the median included
 * account is small enough for that to bind, so the Membrane median prints 100%. The
 * >= $2,000 subset is the one that describes the accounts the mechanism is for.
 */
const medianBlock = (rows: any[]) => ({
  accounts: rows.length,
  aaveMedianFrac: +median(rows.map((r) => r.aaveClosedFrac)).toFixed(5),
  membraneMedianFrac: +median(rows.map((r) => r.membraneClosedFrac)).toFixed(5),
  medianDebtUsd: r2(median(rows.map((r) => r.debtUsd))),
})
const medians = {
  allIncluded: medianBlock(included),
  debtAtLeastFloor: medianBlock(included.filter((r) => r.debtUsd >= LIQ_DEBT_MINIMUM_USD)),
  floorUsd: LIQ_DEBT_MINIMUM_USD,
  note:
    'allIncluded.membraneMedianFrac is a FLOOR artefact, not a result: the median ' +
    `included account is small enough that the $${LIQ_DEBT_MINIMUM_USD} liqDebtMinimum ` +
    'closes it whole. debtAtLeastFloor is the honest per-account read.',
}
/**
 * ---------------------------------------------------------------------------
 * TWO HEADLINE SETS, BECAUSE REPAY-TO-CAP ASSUMES FULL EXECUTION.
 * ---------------------------------------------------------------------------
 * The engine's repay-to-cap is sized from the ORACLE value of the collateral. It does
 * not ask whether that collateral could actually be sold at that price in that minute,
 * so on an illiquid leg the modelled close is an UPPER BOUND, not a forecast. The
 * clearest measured instance is mainnet 0x372cae7f (AAVE collateral): Aave's real
 * liquidators absorbed $3.69M across the episode, and this model closes $25.74M in one
 * block. Nothing in this dataset prices AAVE, so nothing here can say what the true
 * execution bound was.
 *
 * The response is NOT to silently cap the repay — an invented haircut is a second
 * unmeasured assumption stacked on the first. It is to publish both sets and name the
 * difference:
 *
 *   priced      — the collateral leg has a series (exact, flat-$1, or proxied), so the
 *                 whole model applies: band, walk, cure, re-arm. These are the rows the
 *                 mechanism claim is actually about.
 *   allIncluded — priced PLUS the accounts whose collateral has no series at all. Those
 *                 get one repay at t0 and can never cure, so they import the full
 *                 upper-bound repay with none of the delay window that is the point.
 *
 * Both carry the same fields, so the reader can see exactly what the unpriced tail does
 * to the number rather than being handed one of the two.
 */
const absConcentrationOf = (rows: any[]) => {
  const xs = rows
    .map((r) => ({
      user: r.user,
      chain: r.chain,
      abs: Math.abs(r.aaveClosedUsd - r.membraneClosedUsd),
    }))
    .sort((a, b) => b.abs - a.abs)
  const tot = sum(xs.map((x) => x.abs))
  return {
    shareDenominator: 'gapAbsoluteUsd',
    gapAbsoluteUsd: r2(tot),
    top1Share: tot > 0 ? +((xs[0]?.abs ?? 0) / tot).toFixed(4) : 0,
    top5Share: tot > 0 ? +(sum(xs.slice(0, 5).map((x) => x.abs)) / tot).toFixed(4) : 0,
    top1Account: xs[0] ? `${xs[0].chain}:${xs[0].user}` : null,
    top1AbsGapUsd: r2(xs[0]?.abs ?? 0),
    top5Accounts: xs.slice(0, 5).map((x) => `${x.chain}:${x.user}`),
  }
}

/** One complete headline set. Every field recomputes from `rows` and nothing else. */
const headlineSet = (rows: any[], label: string, note: string) => {
  const a = sum(rows.map((r) => r.aaveClosedUsd))
  const m = sum(rows.map((r) => r.membraneClosedUsd))
  const o = sum(rows.map((r) => r.membraneOneRepayUsd))
  const above = rows.filter((r) => r.debtUsd >= LIQ_DEBT_MINIMUM_USD)
  return {
    label,
    note,
    accounts: rows.length,
    aaveClosedUsd: r2(a),
    membraneOneRepayUsd: r2(o),
    membraneClosedUsd: r2(m),
    gapUsd: r2(a - m),
    gapPct: a > 0 ? +((100 * (a - m)) / a).toFixed(2) : 0,
    delayCreditUsd: r2(o - m),
    membraneClosesLess: rows.filter((r) => r.membraneClosedFrac < r.aaveClosedFrac).length,
    membraneClosesMore: rows.filter((r) => r.membraneClosedFrac >= r.aaveClosedFrac).length,
    aaveMedianFrac: +median(rows.map((r) => r.aaveClosedFrac)).toFixed(5),
    membraneMedianFrac: +median(rows.map((r) => r.membraneClosedFrac)).toFixed(5),
    medians: {
      allAccounts: medianBlock(rows),
      debtAtLeastFloor: medianBlock(above),
      floorUsd: LIQ_DEBT_MINIMUM_USD,
    },
    concentration: absConcentrationOf(rows),
    /** The same |gap| concentration, deduped onto DISTINCT WALLETS across chains. */
    walletConcentration: walletConcentration(
      rows,
      (r) => Math.abs(r.aaveClosedUsd - r.membraneClosedUsd),
      `${label} · |Aave - Membrane| per wallet`,
    ),
  }
}

const pricedRows = included.filter((r) => r.priced)
const unpricedCollRows = included.filter((r) => !r.priced)
const priced = headlineSet(
  pricedRows,
  'priced',
  'Included accounts whose collateral leg has a price series — exact (ETH, BTC, wstETH), ' +
    'flat-$1 stable, or ETH-proxied. The full cure model applies to every one of them: ' +
    'break band, minute-by-minute walk, cure, re-arm after a sale. This is the primary ' +
    'set and it is what the Debt lens leads with.',
)
const allIncluded = headlineSet(
  included,
  'allIncluded',
  `priced plus the ${unpricedCollRows.length} included accounts whose collateral has no ` +
    'series in this dataset. Those cannot be walked: they take ONE repay at t0 and can ' +
    'never cure, so they carry the full repay-to-cap upper bound with none of the delay ' +
    'window it is supposed to be compared against. Published beside `priced` rather than ' +
    'dropped, because they are real debt Aave really closed.',
)
/** The repay-to-cap execution bound, named with its measured counter-example. */
const liquidityBound = {
  rule: 'not capped in the headline; priced as meta.sensitivity.liquidityBound',
  cappedRule:
    'ONE Membrane sale may close at most the LARGEST SINGLE REPAY real Aave liquidators ' +
    'managed on that collateral symbol in this window. Measured, not modelled: the cap ' +
    'table is meta.sensitivity.liquidityBound.capTable. The remainder of the position ' +
    'walks on and can be sold again at a later minute, so it bounds the per-block clip ' +
    'rather than the episode.',
  note:
    "Membrane's repay-to-cap is sized from the ORACLE value of the collateral and assumes " +
    'the sale executes at that price. On an illiquid leg it is therefore an UPPER BOUND on ' +
    'what could be closed in one block, not a forecast. It is deliberately NOT capped here: ' +
    'a modelled haircut would be a second unmeasured assumption on top of the first. The ' +
    'exposure is published instead — as the priced / allIncluded split, and as this ' +
    'worked counter-example.',
  workedExample: (() => {
    const row = included.find((r) => r.user.toLowerCase().startsWith('0x372cae7f'))
    return row
      ? {
          account: `${row.chain}:${row.user}`,
          collSymbol: row.collSymbol,
          debtSymbol: row.debtSymbol,
          collClass: row.collClass,
          aaveClosedUsd: row.aaveClosedUsd,
          membraneClosedUsd: row.membraneClosedUsd,
          note:
            "Aave's real liquidators absorbed the Aave figure across the whole episode; " +
            'the model closes the Membrane figure in one block. This dataset prices no ' +
            'AAVE series, so it cannot state the true execution bound — only that one ' +
            'exists and that this row is where it bites hardest.',
        }
      : null
  })(),
}

/**
 * Who carries the accounts that were NEVER sold — the delay window's clearest outcome,
 * and therefore the easiest place for one account to quietly become the claim. Two
 * denominators, because they answer different questions: held DEBT is "whose position is
 * this result about", held CURE CREDIT is "whose dollars is the delay window earning".
 */
const heldConcentration = (() => {
  const byDebt = [...heldRows].sort((a, b) => b.debtUsd - a.debtUsd)
  const totDebt = sum(heldRows.map((r) => r.debtUsd))
  const byCredit = [...heldRows]
    .map((r) => ({ ...r, credit: creditOf(r) }))
    .sort((a, b) => b.credit - a.credit)
  const totCredit = sum(byCredit.map((r) => r.credit))
  const name = (r: any) => `${r.chain}:${r.user}`
  return {
    accounts: heldRows.length,
    debtUsd: r2(totDebt),
    cureCreditUsd: r2(totCredit),
    debtTop1Share: totDebt > 0 ? +((byDebt[0]?.debtUsd ?? 0) / totDebt).toFixed(4) : 0,
    debtTop5Share:
      totDebt > 0 ? +(sum(byDebt.slice(0, 5).map((r) => r.debtUsd)) / totDebt).toFixed(4) : 0,
    debtTop1Account: byDebt[0] ? name(byDebt[0]) : null,
    debtTop5Accounts: byDebt.slice(0, 5).map(name),
    cureCreditTop1Share: totCredit > 0 ? +((byCredit[0]?.credit ?? 0) / totCredit).toFixed(4) : 0,
    cureCreditTop5Share:
      totCredit > 0 ? +(sum(byCredit.slice(0, 5).map((r) => r.credit)) / totCredit).toFixed(4) : 0,
    cureCreditTop1Account: byCredit[0] ? name(byCredit[0]) : null,
    cureCreditTop5Accounts: byCredit.slice(0, 5).map(name),
    /** Deduped onto distinct wallets, which is what a counterparty actually is. */
    byWalletDebt: walletConcentration(heldRows, (r) => r.debtUsd, 'held · debt per wallet'),
    byWalletCureCredit: walletConcentration(heldRows, creditOf, 'held · cure credit per wallet'),
  }
})()

/** The headline, assembled once so every surface quotes the same four numbers. */
const headline = {
  accounts: n,
  aaveClosedUsd: r2(aU),
  membraneOneRepayUsd: r2(mOne),
  membraneClosedUsd: r2(mU),
  gapUsd: r2(aU - mU),
  gapPct: +((100 * (aU - mU)) / aU).toFixed(2),
}
/** The same four numbers with the excluded rows kept on BOTH sides, for the before/after. */
const withExcludedKept = {
  accounts: cohort.length,
  aaveClosedUsd: r2(sum(cohort.map((r) => r.aaveClosedUsd))),
  membraneOneRepayUsd: r2(sum(cohort.map((r) => r.membraneOneRepayUsd))),
  membraneClosedUsd: r2(sum(cohort.map((r) => r.membraneClosedUsd))),
  gapUsd: r2(sum(cohort.map((r) => r.aaveClosedUsd - r.membraneClosedUsd))),
  gapPct: +(
    (100 * sum(cohort.map((r) => r.aaveClosedUsd - r.membraneClosedUsd))) /
    sum(cohort.map((r) => r.aaveClosedUsd))
  ).toFixed(2),
  note:
    'An excluded row closes membraneOneRepayUsd on the Membrane side (the conservative ' +
    'one-repay figure kept for display), so this is NOT a $0-credit comparison. It is ' +
    'published because dropping 20%+ of the events must be visible in both directions.',
}

/**
 * What a "2-minute cure" physically was. The up-move a breached position needed on its
 * collateral leg to get back under its own line is `ltv0 / line - 1`; the ETH oracle
 * printed a fresh round in only 183 of the window's 2,880 minutes, so a fast cure is a
 * position that was a fraction of a percent over its line when one of those landed.
 */
const fastCures = included.filter((r) => r.minutesToFirstCure != null && r.minutesToFirstCure <= 2)
const requiredUpMove = (r: any) => r.ltv0 / r.liqLine - 1
const medianRequiredUpMoveFastCurePct = +(100 * median(fastCures.map(requiredUpMove))).toFixed(4)
const medianRequiredUpMoveAllPct = +(
  100 * median(included.filter((r) => r.ltv0 > r.liqLine).map(requiredUpMove))
).toFixed(4)

// ---- sweeps --------------------------------------------------------------
const sweep = (over: Partial<WalkInput>) =>
  walkInputs.reduce(
    (s, w, i) => (cohort[i]?.excluded ? s : s + cureWalk({ ...w, ...over }).closedUsd),
    0,
  )

/**
 * The same sweep over the PRICED set only — the accounts whose collateral leg has a real
 * price series, so the delay window actually applies to them. `sweep` above runs over
 * every INCLUDED account, and roughly 1,000 of those are unpriced: they take one repay at
 * t0 and can never cure, so their dollars are identical at every band and they dilute the
 * band's measured effect toward zero. The priced sweep is the one that says what the band
 * is worth where the band can do anything at all.
 */
const sweepPriced = (over: Partial<WalkInput>) =>
  walkInputs.reduce(
    (s, w, i) =>
      cohort[i]?.excluded || !cohort[i]?.priced ? s : s + cureWalk({ ...w, ...over }).closedUsd,
    0,
  )

// walkInputs and cohort are pushed in lockstep, so index i is the same account.
const BANDS = [0.02, 0.04, 0.08]
const bandSensitivity = BANDS.map((band) => ({
  band,
  membraneClosedUsd: r2(sweep({ band })),
}))
const bandSensitivityPriced = BANDS.map((band) => ({
  band,
  membraneClosedUsd: r2(sweepPriced({ band })),
}))

/** The floor: how many accounts and how many USD `liqDebtMinimum` moves. */
const noFloorTotal = sweep({ debtMinimumUsd: 0 })
let floorAccountsChanged = 0
let floorOneRepayChanged = 0
for (let i = 0; i < walkInputs.length; i++) {
  if (cohort[i].excluded) continue
  const w = walkInputs[i]
  if (
    Math.abs(cureWalk({ ...w, debtMinimumUsd: 0 }).closedUsd - cohort[i].membraneClosedUsd) > 0.01
  ) {
    floorAccountsChanged++
  }
  const bare = membraneCollateralRepayValue(
    w.debtUsd,
    w.collateralUsd,
    Math.max(0, w.line - BORROW_LTV_GAP),
    0,
  )
  if (Math.abs(bare - cohort[i].membraneOneRepayUsd) > 0.01) floorOneRepayChanged++
}

/** Repeat sales: the contract re-arms after a repay-to-cap. */
const oneSaleTotal = sweep({ maxSales: 1 })
const repeatSaleAccounts = included.filter((r) => r.sales > 1).length
const maxSalesSeen = included.reduce((m, r) => Math.max(m, r.sales), 0)

/** Timer clearing needs a CALL. The corner where nobody ever makes it. */
const noEarlyClearTotal = sweep({ noEarlyClear: true })

const doc0 = {
  exactMedian: residualBlock('N-1', 'exact').medianAbsPct,
}

const doc = {
  meta: {
    window: '2025-10-10T00:00Z to 2025-10-11T23:59Z',
    sourceEvents: lines.length - 1,
    accounts: n,
    cohortRows: cohort.length,
    unpricedEventsDropped: unpricedDebtEvents,
    provenance: 'onchain',
    method:
      'Each account is judged against its OWN liquidation line, inverted from its ' +
      'measured health factor (LT = hf x debt / coll), after its block-1 state is ' +
      'REBASED to the liquidation-minute oracle print. No modelled per-asset LTV is ' +
      "used anywhere. Aave's side is its ENTIRE multi-hit episode; Membrane's is the " +
      "delay window walked minute by minute, with the contract's repay-to-cap, its " +
      'liqDebtMinimum floor, and re-arming after a sale. Accounts that are still not ' +
      'breached after the rebase are excluded from BOTH sides.',
    realConstants: {
      borrowLtvGap: BORROW_LTV_GAP,
      borrowLtvGapSource: 'lib/Constants.sol:39',
      repayFormulaSource:
        'membrane-solidity master 10626e40 LiquidationEngine.sol:2663-2710; at L >= 1 the target is the ' +
        'full debt (:2673-2688) but collateral repays at most what is held, and the uncovered rest ' +
        'is bad debt (:2361-2374), so the census books min(target, collateral value)',
      cureWindowSeconds: CURE_WINDOW_SECONDS,
      cureWindowSource:
        'script/DeployFullSystem.s.sol:199 LIQUIDATION_DELAY_S = 8 hours (engine constructor :481)',
      liqDebtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
      liqDebtMinimumSource:
        'script/DeployFullSystem.s.sol:486 setLiqDebtMinimum(2000e18); the constructor ' +
        'default is MembraneDeploymentDefaults.DEBT_MINIMUM = 100e18 ' +
        '(contracts/lib/DeploymentDefaults.sol:51), which DeployLiquidationCore.s.sol leaves in place',
      debtMinimumRuleSource:
        'membrane-solidity master 10626e40 LiquidationEngine.sol:2718-2729 (the floor), plus the remainder guard the owner ruled on 2026-10-04: no liquidation leaves 0 < debt < the minimum, it repays all (master does not have the guard yet; a fix is tracked)',
    },
    /** The rebase, and what it could not resolve. */
    excluded: {
      ...excludedStats,
      membraneOneRepayUsd: r2(sum(excludedRows.map((r) => r.membraneOneRepayUsd))),
      reason:
        'Still at or under their own inverted liquidation line after the block-1 state ' +
        'is rebased to the liquidation-minute oracle print. Aave liquidated them, so ' +
        'either the snapshot, the health factor, or the minute-resolution price is ' +
        'wrong for these rows. No breach can be located, so no delay window can be ' +
        'started, and crediting Membrane with closing $0 on them would be an artefact ' +
        'of the data rather than a property of the mechanism. They are removed from ' +
        "BOTH Aave's total and Membrane's, and kept in the cohort flagged excluded.",
      rebasedIntoBreach: cohort.filter((r) => !r.excluded && r.ltv0Snapshot <= r.liqLine).length,
      rebasedOutOfBreach: excludedRows.filter((r) => r.ltv0Snapshot > r.liqLine).length,
    },
    /**
     * AAVE'S OWN PRICE vs THE ROUND THIS BUILDER SELECTS. The only end-to-end check the
     * pricing chain has, published whether or not it is flattering.
     */
    anchor: {
      method:
        'For a single-collateral account, total_collateral_base_usd / ' +
        'pre_collateral_normalized IS the unit price Aave returned at block N-1. Nothing ' +
        'in the CSV flags single-collateral accounts, so the test is AGREEMENT: two ' +
        'distinct users liquidated in the same (chain, block, asset) whose implied prices ' +
        'match to 1e-6 are both single-collateral. Rows with intra_block_seq > 0 are ' +
        'dropped - the enrichment subtracts prior same-block seizures from the ' +
        'denominator and not the numerator, so their ratio is mixed.',
      recoveredPrices: AAVE_PRICE.size,
      pointsWithAFeed: anchorPoints.length,
      /** Residual = Aave's own price / the Chainlink round selected, minus 1. */
      residualByBlockRule: {
        'N-2': residualBlock('N-2'),
        'N-1': residualBlock('N-1'),
        N: residualBlock('N'),
        'N-logIndexFilter': residualBlock('N-logfilter'),
      },
      /**
       * SPLIT BY PRICE CLASS, because the two halves measure different things. `exact` is
       * WETH / WBTC / wstETH, each against ITS OWN feed: that residual is a pure
       * feed-mismatch measurement. `proxied` is weETH / rETH / cbBTC / LBTC etc. read off
       * ETH/USD or BTC/USD, where most of the residual is the real asset spread the proxy
       * is already known to discard, so it is NOT evidence about the round selection.
       */
      residualByPriceClass: {
        exact: residualBlock('N-1', 'exact'),
        proxied: residualBlock('N-1', 'proxied'),
      },
      headlineRule: 'N-1 for p_state, N-with-log-index-filter for p_liq',
      exactMatchToAnyRound: exactMatchAnyRound,
      finding:
        'NO BLOCK RULE FIXES IT. N-2, N-1, N and N-with-the-log-index-filter all leave ' +
        `the same distribution, and ${exactMatchAnyRound} of ${anchorPoints.length} ` +
        'recovered prices equal ANY round in the log to 1e-6 at ANY block. The round log ' +
        'is internally complete (contiguous agg_round_id, one aggregator, one phase), so ' +
        'this is not a fetch gap a different selection could recover: the ETH/USD series ' +
        'in this dataset is not the series Aave read. The residual is therefore published ' +
        'as an uncertainty on the PATH, and the anchored rebuild ' +
        '(meta.sensitivity.aaveAnchored) prices what believing Aave\u2019s level instead ' +
        'is worth.',
      coverage: {
        priced: anchorCoverage(included.filter((r) => r.priced)),
        allIncluded: anchorCoverage(included),
      },
      note:
        'Every dollar in the headline is read through a RATIO - the rebase is ' +
        'p_liq/p_state, the walk is grid[i]/p_liq, and the USD levels are Aave\u2019s own ' +
        'totalCollateralBase - so a pure level shift cancels almost everywhere. The one ' +
        'place it does not is grid[i]/p_liq, where a Chainlink numerator would meet an ' +
        'Aave denominator. That mismatch IS the residual, and the anchored total is its ' +
        'size in dollars.',
    },
    /** What each collateral symbol was priced through, and the exposure of each class. */
    collateralMapping: {
      /** The measured wrap rate every wstETH leg is priced through, and its derivation. */
      wsteth: {
        wrapRate: WSTETH_WRAP_RATE,
        rule: 'wstETH(USD) = ETH/USD in force x wrapRate. Constant, so it cancels in ratios.',
        derivation:
          "MEASURED from Aave's own per-block prices. Pairing the recovered wstETH and " +
          'WETH prices at the same block gives wstETH/WETH = 1.21598891 to 8 decimal ' +
          'places on 8 of 9 pairs (mainnet blocks 23549967 / 23549982 / 23549983 / ' +
          '23549986 / 23549987 / 23549989 / 23549991 / 23549993 and arbitrum 388184135); ' +
          'the 9th pairs blocks one apart and so measures a price change, not the rate.',
        marketFeedRejected:
          'The STETH/ETH market feed (0x86392dC19c0b719886221c78AB11eb8Cf5c52812, ' +
          'description() = "STETH / ETH") really did collapse 0.99960 -> 0.95569 between ' +
          '21:20 and 21:28 UTC. Aave never saw it: the ratio above is constant across ' +
          'blocks spanning that collapse. prices-1m.json still ships the column, flagged ' +
          'meta.feedIdentity.stethEthOracle.notAaveOracle = true. What pricing wstETH ' +
          'through it was worth is meta.sensitivity.wstethMarketFeed.',
      },
      /**
       * EXACT / STABLE-FLAT / PROXIED / UNPRICED, over the INCLUDED rows, with counts and
       * debt USD. Every account falls in exactly one class and the four partition the set.
       */
      classes: {
        exact: {
          symbols: [...classStats.exact.symbols].sort(),
          accounts: classStats.exact.accounts,
          debtUsd: r2(classStats.exact.debtUsd),
          note:
            'Priced from their OWN Chainlink feed in force at the block: ETH/USD for ' +
            'WETH/ETH, BTC/USD for WBTC/BTC, and for wstETH the composite ' +
            '(ETH-denominated feed in force) x (ETH/USD in force). The ETH-denominated ' +
            'proxy answers description() = "STETH / ETH": it carries the Oct 10 staked-ETH ' +
            'depeg (0.99960 -> 0.95569 between 21:20 and 21:28 UTC) but not the ' +
            'wstETH<->stETH wrap accrual, which cancels out of every ratio read here.',
        },
        stableFlat: {
          symbols: [...classStats.stableFlat.symbols].sort(),
          accounts: classStats.stableFlat.accounts,
          debtUsd: r2(classStats.stableFlat.debtUsd),
          note: 'Held at a flat $1.00 across the window. That is a real series, not a missing one.',
        },
        proxied: {
          symbols: [...classStats.proxied.symbols].sort(),
          accounts: classStats.proxied.accounts,
          debtUsd: r2(classStats.proxied.debtUsd),
          note:
            'No feed in this dataset, so the nearest major path carries the ratio: ' +
            'weETH/rETH/cbETH/ETHx/osETH on ETH/USD, cbBTC/tBTC/LBTC on BTC/USD. The old ' +
            'justification for this ("each moves under 0.1%/day against ETH") was WRONG for ' +
            'this window and has been removed: the measured stETH/ETH move was 4.4% in ' +
            'eight minutes, so an ETH-proxied staked-ETH leg UNDER-states its own breach. ' +
            'wstETH was in this bucket and is not any more.',
        },
        unpriced: {
          symbols: [...classStats.unpriced.symbols].sort(),
          accounts: classStats.unpriced.accounts,
          debtUsd: r2(classStats.unpriced.debtUsd),
          note:
            'No series of any kind. These accounts take ONE repay at t0 and can never ' +
            'cure, so the whole delay window is inapplicable to them. They are the only ' +
            'difference between doc.debt.priced and doc.debt.allIncluded.',
        },
      },
      multiCollateral: {
        accounts: multiCollAccounts,
        debtUsd: r2(multiCollDebtUsd),
        /** The walked subset — the only accounts the approximation can actually bite. */
        includedAccounts: multiCollIncludedAccounts,
        includedDebtUsd: r2(multiCollIncludedDebtUsd),
        note:
          "The liquidated leg's symbol is applied to the whole basket. For an account " +
          "whose collateral is mixed, the modelled path is the liquidated leg's path. " +
          'accounts/debtUsd count every such account in the dataset; ' +
          'includedAccounts/includedDebtUsd count only the ones the census actually ' +
          'walks, which is where the single-leg approximation has any effect.',
      },
      debtLegRatio: {
        accounts: debtLegRatioAccounts,
        debtUsd: r2(debtLegRatioDebtUsd),
        note:
          'Stable collateral with volatile debt (e.g. USDC collateral, WETH debt). A ' +
          'stable leg is a flat 1.0 series, so LTV_t / LTV_0 = p_debt(t) / p_debt(0): the ' +
          'ratio is built from the DEBT leg. These used to fall into the no-series bucket.',
      },
      freshOraclePrints: {
        ethOracle: FRESH_ETH,
        btcOracle: FRESH_BTC,
        wstethOracle: FRESH_WSTETH,
        minutes: NP,
      },
    },
    cureModel: {
      engine: 'lib/position-sim/curePath.ts cureWalk — shared with the per-address simulator',
      delaySeconds: CURE_WINDOW_SECONDS,
      band: MAX_THRESHOLD_TO_DELAY,
      borrowLtvGap: BORROW_LTV_GAP,
      debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
      maxSales: MAX_SALES,
      stepSeconds: STEP,
      semantics: [
        'The break line is line x (1 + band), not line + band — LiquidationEngine.sol:2554-2557, tested strictly at :1576.',
        'A position back under its LINE clears the timer (SavedByDelay, LiquidationEngine.sol:1666-1685 and clearRecoveredTimer :926-949), so a later breach gets a FULL fresh delay. The delay is not one-shot.',
        'MODELLED SEMANTICS, stated: clearRecoveredTimer / saveByDelay are permissionless and cost only gas, but somebody must CALL them. This model clears instantly on a return under the line. meta.sensitivity.noEarlyClearMembraneClosedUsd prices the opposite corner, where nobody ever calls, the original expiry stands, and a later breach does not restart it.',
        'Past the band while a timer runs is BrokeWindow — immediate sale (LiquidationEngine.sol:1695-1696). Past the band with no timer is Immediate (:1697-1698). Neither gets a delay.',
        'At expiry still over the line is DelayExpired — sale at that minute, sized to restore the borrow cap at that minute’s collateral value (:1699-1700, :2663-2710).',
        `A sale restores the BORROW CAP, not zero, and deletes the timer (:1724-1727), so the position stays live: the reduced debt and collateral walk on and a later breach re-arms. Up to ${MAX_SALES} sales per episode.`,
        `Every repay passes through the liqDebtMinimum floor (master LiquidationEngine.sol:2718-2729) at the deployed $${LIQ_DEBT_MINIMUM_USD}, and a repay that would leave less than that behind closes the whole loan instead — the intended rule (owner ruling 2026-10-04); master does not apply that remainder guard yet. The contract also gas-indexes the floor upward; gas is not modelled, so this can only UNDER-state the escalation.`,
        'Past insolvency (LTV >= 100%) the contract targets the FULL debt (master LiquidationEngine.sol:2673-2688), but collateral can only repay what is held: the census books the collateral value as closed, and the uncovered rest is bad debt (:2361-2374), not a repay.',
        'Conservative choices: a grid that ends inside an unresolved delay SELLS at the last price; a recovery only re-arms on a return under the line, never merely back inside the band; accounts whose breach cannot be located even after the rebase are excluded from both sides rather than handed a free cure.',
      ],
      outcomes,
      bandSensitivity,
      /** The same three bands over the PRICED set only. See `sweepPriced`. */
      bandSensitivityPriced,
      bandSensitivityNote:
        'bandSensitivity runs over every INCLUDED account; bandSensitivityPriced runs ' +
        'over the priced subset only. The unpriced accounts take one repay at t0 and can ' +
        'never cure, so they carry the same dollars at every band and flatten the ' +
        'measured effect of the band in the all-included figure.',
      membraneOneRepayUsd: r2(mOne),
      /** NET: one-repay minus with-delay, over INCLUDED accounts. */
      delayCreditUsd: r2(mOne - mU),
      cureCreditGrossUsd: r2(cureCreditGrossUsd),
      counterCreditUsd: r2(counterCreditUsd),
      counterCreditAccounts,
      cureCreditUsd: r2(cureCreditTotal),
      cureCreditShareWithin2min: shareWithin(2),
      cureCreditShareWithin1h: shareWithin(60),
      cureCreditShareWithin8h: shareWithin(480),
      medianRequiredUpMoveFastCurePct,
      medianRequiredUpMoveAllPct,
      fastCureAccounts: fastCures.length,
      freshEthPrints: FRESH_ETH,
      gridMinutes: NP,
      gapByOutcome,
      concentration,
      absoluteConcentration,
      /**
       * THE TWO HEADLINE SETS. `priced` is primary (the model fully applies); the
       * difference between them is exactly the unpriced-collateral tail, which imports a
       * one-repay upper bound with no delay window attached.
       */
      priced,
      allIncluded,
      liquidityBound,
      heldConcentration,
      headline,
      withExcludedKept,
      medians,
      heldWholeDay,
      soldAtT0,
      alignment,
      /** After the rebase these ARE the headline: every included row has a located line. */
      locatedLineOnly: {
        accounts: n,
        aaveClosedUsd: r2(aU),
        membraneOneRepayUsd: r2(mOne),
        membraneClosedUsd: r2(mU),
      },
    },
    sensitivity: {
      /**
       * THE ONE ALIGNMENT SENSITIVITY. The old t0±1-minute sweep is gone: no dollar is
       * decided from a minute cell any more, so sliding the grid a minute either way
       * moves nothing that matters. What is still a judgement call is whether a round in
       * the LIQUIDATING block was in force at the liquidation.
       */
      alignment,
      /** Nobody ever calls the permissionless clear: the first expiry stands. */
      noEarlyClearMembraneClosedUsd: r2(noEarlyClearTotal),
      noEarlyClearDeltaUsd: r2(noEarlyClearTotal - mU),
      /** The liqDebtMinimum floor switched off entirely. */
      noDebtFloorMembraneClosedUsd: r2(noFloorTotal),
      debtFloorDeltaUsd: r2(mU - noFloorTotal),
      debtFloorAccountsChanged: floorAccountsChanged,
      debtFloorOneRepayAccountsChanged: floorOneRepayChanged,
      /** One sale per episode, the old cap. */
      singleSaleMembraneClosedUsd: r2(oneSaleTotal),
      repeatSaleDeltaUsd: r2(mU - oneSaleTotal),
      repeatSaleAccounts,
      maxSalesSeen,
      /** What the headline would be if the excluded rows were kept on both sides. */
      withExcludedAaveClosedUsd: r2(sum(cohort.map((r) => r.aaveClosedUsd))),
      withExcludedMembraneClosedUsd: r2(sum(cohort.map((r) => r.membraneClosedUsd))),
      /**
       * wstETH priced through the STETH/ETH MARKET feed rather than the measured wrap
       * rate. This is what this builder used to do; Aave's own prices say it never
       * happened. Published as the size of that error.
       */
      wstethMarketFeedMembraneClosedUsd: {
        priced: wstethMarketTotals.priced.membraneClosedUsd,
        allIncluded: wstethMarketTotals.allIncluded.membraneClosedUsd,
        pricedDeltaUsd: r2(wstethMarketTotals.priced.membraneClosedUsd - priced.membraneClosedUsd),
        allIncludedDeltaUsd: r2(
          wstethMarketTotals.allIncluded.membraneClosedUsd - allIncluded.membraneClosedUsd,
        ),
        pricedAccounts: wstethMarketTotals.priced.accounts,
        allIncludedAccounts: wstethMarketTotals.allIncluded.accounts,
        movers: wstethMarketMovers,
        note:
          'The market feed moves wstETH ~4.4% against ETH inside eight minutes, which ' +
          'pushes wstETH accounts past line x (1 + band) that the wrap-rate path leaves ' +
          'inside it. `movers` lists every account it moves by more than $1M. Aave saw ' +
          'none of this: see meta.collateralMapping.wsteth.',
      },
      /** p_state / p_liq anchored to Aave's own recovered price. */
      aaveAnchored: {
        priced: anchoredTotals.priced,
        allIncluded: anchoredTotals.allIncluded,
        pricedDeltaUsd: r2(anchoredTotals.priced.membraneClosedUsd - priced.membraneClosedUsd),
        allIncludedDeltaUsd: r2(
          anchoredTotals.allIncluded.membraneClosedUsd - allIncluded.membraneClosedUsd,
        ),
        rule:
          'p_state := the price Aave itself returned at block N-1 where >= 2 users agree ' +
          'it is recoverable; p_liq := that price x (round in force at N / round in force ' +
          'at N-1), so the round log supplies only the CHANGE across the block. Accounts ' +
          'with no recoverable price keep the round-log level.',
        note:
          'The delta is the dollar size of the anchor residual in meta.anchor. It is ' +
          'small because the rebase and the USD levels are already Aave\u2019s own and ' +
          'the walk is a ratio; it is not zero because grid[i]/p_liq then reads a ' +
          'Chainlink numerator against an Aave denominator.',
      },
      /** The execution bound, capped at what real liquidators measurably absorbed. */
      liquidityBound: {
        priced: cappedTotals.priced,
        allIncluded: cappedTotals.allIncluded,
        liquidityBoundMembraneClosedUsd: {
          priced: cappedTotals.priced.membraneClosedUsd,
          allIncluded: cappedTotals.allIncluded.membraneClosedUsd,
        },
        pricedDeltaUsd: r2(cappedTotals.priced.membraneClosedUsd - priced.membraneClosedUsd),
        allIncludedDeltaUsd: r2(
          cappedTotals.allIncluded.membraneClosedUsd - allIncluded.membraneClosedUsd,
        ),
        rule: liquidityBound.cappedRule,
        capTable: liquidityCapTable,
      },
    },
    engine: 'lib/position-sim/membrane.ts — shared with the per-address simulator',
    caveats: [
      'Account state is read at block_number-1 (genuine pre-liquidation), then REBASED ' +
        'to the liquidation-minute oracle print — collateral by p(t0)/p(t0-1), and debt ' +
        'too when the debt is not a stable — before any breach is decided. Without that ' +
        'rebase a fresh print landing between block-1 and the liquidating block is ' +
        'invisible, and the account looks healthy at the moment it was liquidated.',
      `${excludedRows.length} accounts are still not breached after the rebase, and are ` +
        `EXCLUDED from both sides of every total. Aave closed $${(sum(excludedRows.map((r) => r.aaveClosedUsd)) / 1e6).toFixed(1)}M ` +
        'on them. Something in the snapshot, the health factor or the minute-resolution ' +
        'price is wrong for those rows; the honest treatment is to drop them from both ' +
        'sides rather than count a $0 Membrane close as a win. They stay in the cohort ' +
        'flagged excluded so the table can still show them.',
      'debt_fraction_repaid is per-RESERVE; Aave’s USD figure is valued from ' +
        'debt_to_cover_normalized x price instead.',
      'wstETH is priced as (ETH/USD in force) x 1.215989, the MEASURED wstETH<->stETH wrap ' +
        'rate. It is NOT priced through the STETH/ETH market feed, which is what this ' +
        "builder did until this revision. Aave's own per-block prices, recovered from the " +
        'liquidation CSV and agreed to 1e-6 by >= 2 users, give wstETH/WETH = 1.21598891 to ' +
        '8 decimal places across blocks over which that market feed moved 0.99960 -> ' +
        '0.96171: Aave never saw the depeg and no liquidation in this cohort was decided ' +
        'on it. The market-feed version added ' +
        `$${((wstethMarketTotals.priced.membraneClosedUsd - priced.membraneClosedUsd) / 1e6).toFixed(2)}M ` +
        'to the priced Membrane total on its own, almost all of it two wstETH accounts it ' +
        'pushed past the band. See meta.sensitivity.wstethMarketFeedMembraneClosedUsd.',
      "The pricing chain is CHECKED against Aave's own oracle, and it does not reconcile. " +
        `${anchorPoints.length} per-block prices with a feed are recoverable from the CSV; ` +
        `the median |residual| against the round this builder selects is ` +
        `${doc0.exactMedian}% and ${exactMatchAnyRound} of them equal ANY round in the log ` +
        'at ANY block. No block rule (N-2 / N-1 / N / N-with-log-index-filter) changes ' +
        'that, and the round log is internally complete, so the ETH/USD series in this ' +
        'dataset is not the series Aave read. meta.anchor publishes the distribution and ' +
        'meta.sensitivity.aaveAnchored rebuilds the whole cohort off Aave\u2019s own level.',
      `${classStats.proxied.accounts} accounts (debt $${(classStats.proxied.debtUsd / 1e6).toFixed(1)}M) still ` +
        'hold weETH, rETH, cbETH, ETHx, osETH, cbBTC, tBTC or LBTC, for which this dataset ' +
        'ships no feed at all. The nearest major path (ETH/USD or BTC/USD) carries their ' +
        'ratio. Given the measured 4.4% staked-ETH depeg, that proxy UNDER-states their ' +
        'breach rather than over-stating it. Counts and debt are in ' +
        'meta.collateralMapping.classes.proxied.',
      `${classStats.unpriced.accounts} included accounts (debt $${(classStats.unpriced.debtUsd / 1e6).toFixed(1)}M) have ` +
        'no collateral series of any kind. They cannot be walked: one repay at t0, no ' +
        'band, no cure. They are excluded from doc.debt.priced and added back in ' +
        'doc.debt.allIncluded, never silently blended into one figure.',
      'The repay-to-cap is sized from the ORACLE value of the collateral and assumes the ' +
        'sale executes at that price, so on an illiquid leg it is an UPPER BOUND, not a ' +
        'forecast. It is deliberately not capped — a modelled haircut would be a second ' +
        'unmeasured assumption. See meta.cureModel.liquidityBound for the worked ' +
        'counter-example, where real liquidators absorbed a small fraction of what the ' +
        'model closes in one block.',
      'A round in the liquidating block counts as in force ONLY if its log_index is below ' +
        "the LiquidationCall's own. Within a block the EVM orders logs by log_index, so a " +
        'round that printed later in the block cannot be what the liquidation read. The ' +
        'previous rule counted every round in the block regardless of position.',
      `${multiCollAccounts} accounts (debt $${(multiCollDebtUsd / 1e6).toFixed(1)}M) were liquidated ` +
        'against more than one collateral symbol. The liquidated leg’s path is applied to ' +
        'the whole basket, which is an approximation for those accounts.',
      'Cure analysis covers the assets the Oct 10 oracle series prices — ETH-like, ' +
        'BTC-like and stables. A stable leg is a flat 1.0 series, so a stable-collateral / ' +
        'volatile-debt account builds its ratio from the debt leg instead of being dropped.',
      'The cure result is PATH-DEPENDENT. Oct 10 was a sharp wick with partial ' +
        'recovery. A window that keeps falling would not cure.',
      'Membrane has no mainnet deployment. This models a protocol that is not live, ' +
        'run against real prices.',
      'The timer is cleared INSTANTLY on a return under the line here, but both ' +
        'clearing paths (clearRecoveredTimer, saveByDelay) are permissionless calls that ' +
        'somebody has to make. meta.sensitivity.noEarlyClearMembraneClosedUsd is the ' +
        'corner where nobody ever does.',
      'The venue recall is credited to no closed-debt total here — recall depends on a ' +
        'deployment that does not exist, so crediting it would be an assumption, not a ' +
        'measurement. Every account also carries membraneOneRepayUsd, so the delay ' +
        'window’s contribution is visible as a subtraction rather than asserted.',
      'The cure field on each account remains the earlier BEST-LTV diagnostic over a ' +
        'fixed 8h look-ahead. It is not the walk: it ignores the band, ignores re-arming ' +
        'and is not what any dollar here is computed from. Read outcome / closedAtIndex / ' +
        'minutesToFirstCure / sales for the modelled result.',
    ],
  },
  /**
   * THE DEBT LENS READS THIS. The top-level fields ARE the `priced` set — the accounts
   * whose collateral has a series, so the band / walk / cure / re-arm model fully
   * applies. `allIncluded` sits beside it with the unpriced-collateral tail added back,
   * and the two are published together because the difference between them is not a
   * rounding detail: an unpriced account takes one repay at t0 and can never cure, so it
   * imports the repay-to-cap upper bound with none of the delay window it exists to show.
   */
  debt: {
    accounts: priced.accounts,
    aaveClosedUsd: priced.aaveClosedUsd,
    membraneClosedUsd: priced.membraneClosedUsd,
    differenceUsd: priced.gapUsd,
    differencePct: priced.gapPct,
    aaveMedianFrac: priced.aaveMedianFrac,
    membraneMedianFrac: priced.membraneMedianFrac,
    /** The same two medians over accounts the $2,000 floor does not swallow whole. */
    medians: priced.medians,
    membraneClosesLess: priced.membraneClosesLess,
    membraneClosesMore: priced.membraneClosesMore,
    priced,
    allIncluded,
    /** Kept so nothing downstream has to recompute the >=$2,000 cut for the old shape. */
    legacyMedians: medians,
  },
  time: {
    accountsAnalysed: cur.length,
    curedInWindow: cured.length,
    curedPct: +((100 * cured.length) / cur.length).toFixed(2),
    healthyAt8h: healthy.length,
    healthyAt8hPct: +((100 * healthy.length) / cur.length).toFixed(2),
    medianMinutesToCure: median(cured.map((r) => r.cure.minutesToCure)),
    aaveSecondsGranted: 0,
    membraneSecondsGranted: CURE_WINDOW_SECONDS,
  },
  byAsset: byAssetOut,
  cohort: cohort.sort((a, b) => b.debtUsd - a.debtUsd),
}

fs.writeFileSync(OUT, JSON.stringify(doc))
const m = (x: number) => '$' + (x / 1e6).toFixed(2) + 'M'
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`)
console.log(
  `  included ${n}  excluded ${excludedRows.length} (aave ${m(sum(excludedRows.map((r) => r.aaveClosedUsd)))})`,
)
console.log(
  `  PRICED    aave ${m(priced.aaveClosedUsd)}  one-repay ${m(priced.membraneOneRepayUsd)}  with-delay ${m(priced.membraneClosedUsd)}  gap ${m(priced.gapUsd)} (${priced.gapPct}%)  n=${priced.accounts}`,
)
console.log(
  `  ALLINCL   aave ${m(allIncluded.aaveClosedUsd)}  one-repay ${m(allIncluded.membraneOneRepayUsd)}  with-delay ${m(allIncluded.membraneClosedUsd)}  gap ${m(allIncluded.gapUsd)} (${allIncluded.gapPct}%)  n=${allIncluded.accounts}`,
)
console.log(
  `  classes ` +
    Object.entries(doc.meta.collateralMapping.classes)
      .map(([k, v]: any) => `${k}=${v.accounts}/${m(v.debtUsd)}`)
      .join('  '),
)
console.log(
  `  priced conc top1 ${(100 * priced.concentration.top1Share).toFixed(1)}% top5 ${(100 * priced.concentration.top5Share).toFixed(1)}% (${priced.concentration.top1Account})`,
)
console.log(
  `  allIncl conc top1 ${(100 * allIncluded.concentration.top1Share).toFixed(1)}% top5 ${(100 * allIncluded.concentration.top5Share).toFixed(1)}% (${allIncluded.concentration.top1Account})`,
)
console.log(
  `  held conc: debt top1 ${(100 * heldConcentration.debtTop1Share).toFixed(1)}% top5 ${(100 * heldConcentration.debtTop5Share).toFixed(1)}% (${heldConcentration.debtTop1Account}) · credit top1 ${(100 * heldConcentration.cureCreditTop1Share).toFixed(1)}% top5 ${(100 * heldConcentration.cureCreditTop5Share).toFixed(1)}% (${heldConcentration.cureCreditTop1Account})`,
)
console.log(
  `  excluded byReason ` +
    Object.entries(doc.meta.excluded.byReason)
      .map(([k, v]: any) => `${k}=${v.accounts}/${m(v.aaveClosedUsd)}`)
      .join('  '),
)
console.log(
  `  HEADLINE  aave ${m(aU)}  one-repay ${m(mOne)}  with-delay ${m(mU)}  gap ${m(aU - mU)} (${doc.debt.differencePct}%)`,
)
console.log(
  `  with excluded kept: aave ${m(doc.meta.sensitivity.withExcludedAaveClosedUsd)}  membrane ${m(doc.meta.sensitivity.withExcludedMembraneClosedUsd)}`,
)
console.log(
  `  delay credit NET ${m(mOne - mU)} = gross ${m(cureCreditGrossUsd)} - counter ${m(counterCreditUsd)} (${counterCreditAccounts} accts)`,
)
console.log(
  '  outcomes ' +
    Object.entries(outcomes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join('  '),
)
console.log(
  '  gap by outcome ' +
    Object.entries(gapByOutcome)
      .sort((a: any, b: any) => b[1].gapUsd - a[1].gapUsd)
      .map(([k, v]: any) => `${k}=${m(v.gapUsd)}`)
      .join('  '),
)
console.log(
  `  floor: ${floorAccountsChanged} accounts, ${m(mU - noFloorTotal)}   repeat sales: ${repeatSaleAccounts} accounts (max ${maxSalesSeen}), ${m(mU - oneSaleTotal)}`,
)
console.log(`  no-early-clear ${m(noEarlyClearTotal)} (${m(noEarlyClearTotal - mU)})`)
console.log(
  `  concentration top1 ${(100 * concentration.top1Share).toFixed(1)}%  top5 ${(100 * concentration.top5Share).toFixed(1)}%  (${concentration.top1Account})`,
)
console.log(
  `  |gap| concentration top1 ${(100 * absoluteConcentration.top1Share).toFixed(1)}%  top5 ${(100 * absoluteConcentration.top5Share).toFixed(1)}%  of ${m(absoluteConcentration.gapAbsoluteUsd)}`,
)
console.log(
  `  excluded: ${excludedStats.accounts}  aave ${m(excludedStats.aaveClosedUsd)}  median debt $${excludedStats.medianDebtUsd.toLocaleString()}  in 21:00-21:30 ${excludedStats.inCrashWindowPct}%  hf>=1 at block-1 ${excludedStats.healthFactorAtSnapshotAtLeast1}  rebased at all ${excludedStats.rebasedAtAll}  no coll series ${excludedStats.noCollateralSeries}`,
)
console.log(
  `  excluded by chain ${Object.entries(excludedStats.byChain)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')}`,
)
console.log(
  `  alignment (block N-1, nothing rebased): included ${alignment.blockNMinus1.accounts}  excluded ${alignment.blockNMinus1.excludedAccounts}  aave ${m(alignment.blockNMinus1.aaveClosedUsd)}  membrane ${m(alignment.blockNMinus1.membraneClosedUsd)}`,
)
console.log(
  `  medians all: aave ${medians.allIncluded.aaveMedianFrac} membrane ${medians.allIncluded.membraneMedianFrac} (debt $${medians.allIncluded.medianDebtUsd.toLocaleString()})`,
)
console.log(
  `  medians >=$2,000 (${medians.debtAtLeastFloor.accounts}): aave ${medians.debtAtLeastFloor.aaveMedianFrac} membrane ${medians.debtAtLeastFloor.membraneMedianFrac} (debt $${medians.debtAtLeastFloor.medianDebtUsd.toLocaleString()})`,
)
console.log(
  `  held whole day ${heldWholeDay.accounts} accounts, debt ${m(heldWholeDay.debtUsd)}   sold-at-t0 ${soldAtT0.accounts}, median ${soldAtT0.medianDistancePastLinePct}% past the line (band ${soldAtT0.bandPct}%)`,
)
console.log(
  `  cure credit ${m(cureCreditTotal)}  within 2min ${shareWithin(2)}%  1h ${shareWithin(60)}%  8h ${shareWithin(480)}%   median up-move needed (fast) ${medianRequiredUpMoveFastCurePct}%  fresh ETH prints ${FRESH_ETH}/${NP}`,
)
console.log(
  '  band sensitivity ' +
    bandSensitivity.map((b) => `${b.band}=${m(b.membraneClosedUsd)}`).join('  '),
)
console.log(
  `  ANCHOR recovered ${AAVE_PRICE.size} prices, ${anchorPoints.length} with a feed; residual |%| ` +
    Object.entries(doc.meta.anchor.residualByBlockRule)
      .map(
        ([k, v]: any) =>
          `${k}: med ${v.medianAbsPct} p90 ${v.p90AbsPct} max ${v.maxAbsPct} >1%:${v.over1Pct}`,
      )
      .join('  |  ') +
    `  exact-match-any-round ${exactMatchAnyRound}`,
)
console.log(
  '  ANCHOR by class (N-1) ' +
    Object.entries(doc.meta.anchor.residualByPriceClass)
      .map(
        ([k, v]: any) =>
          `${k}: n=${v.points} med ${v.medianAbsPct}% p90 ${v.p90AbsPct}% max ${v.maxAbsPct}% >1%:${v.over1Pct} signedMed ${v.medianSignedPct}%`,
      )
      .join('   '),
)
console.log(
  `  anchored to Aave price: priced ${m(anchoredTotals.priced.membraneClosedUsd)} (${m(anchoredTotals.priced.membraneClosedUsd - priced.membraneClosedUsd)})  allIncl ${m(anchoredTotals.allIncluded.membraneClosedUsd)} (${m(anchoredTotals.allIncluded.membraneClosedUsd - allIncluded.membraneClosedUsd)})`,
)
console.log(
  `  wstETH on the MARKET feed: priced ${m(wstethMarketTotals.priced.membraneClosedUsd)} (${m(wstethMarketTotals.priced.membraneClosedUsd - priced.membraneClosedUsd)})  allIncl ${m(wstethMarketTotals.allIncluded.membraneClosedUsd)} (${m(wstethMarketTotals.allIncluded.membraneClosedUsd - allIncluded.membraneClosedUsd)})  movers ${wstethMarketMovers.length}`,
)
for (const mv of wstethMarketMovers)
  console.log(
    `      ${mv.account} ${mv.collSymbol} ${m(mv.deltaUsd)}  ${mv.outcomeWrap} -> ${mv.outcomeMarketFeed}`,
  )
console.log(
  `  liquidity bound: priced ${m(cappedTotals.priced.membraneClosedUsd)} (${m(cappedTotals.priced.membraneClosedUsd - priced.membraneClosedUsd)})  allIncl ${m(cappedTotals.allIncluded.membraneClosedUsd)} (${m(cappedTotals.allIncluded.membraneClosedUsd - allIncluded.membraneClosedUsd)})  caps ${liquidityCapTable.length} symbols, largest ${m(liquidityCapTable[0]?.largestSingleAaveRepayUsd ?? 0)} (${liquidityCapTable[0]?.symbol})`,
)
console.log(
  `  WALLETS priced: ${priced.walletConcentration.distinctWallets} distinct (${priced.walletConcentration.crossChainWallets} cross-chain) top1 ${(100 * priced.walletConcentration.top1Share).toFixed(1)}% top5 ${(100 * priced.walletConcentration.top5Share).toFixed(1)}% (${priced.walletConcentration.top1Wallet})`,
)
console.log(
  `  WALLETS allIncl: ${allIncluded.walletConcentration.distinctWallets} distinct (${allIncluded.walletConcentration.crossChainWallets} cross-chain) top1 ${(100 * allIncluded.walletConcentration.top1Share).toFixed(1)}% top5 ${(100 * allIncluded.walletConcentration.top5Share).toFixed(1)}% (${allIncluded.walletConcentration.top1Wallet})`,
)
console.log(
  `  WALLETS held: ${heldConcentration.byWalletDebt.distinctWallets} distinct, debt top1 ${(100 * heldConcentration.byWalletDebt.top1Share).toFixed(1)}% top5 ${(100 * heldConcentration.byWalletDebt.top5Share).toFixed(1)}% (${heldConcentration.byWalletDebt.top1Wallet})`,
)
console.log(
  `  cure diagnostic ${doc.time.curedPct}%  healthy@8h ${doc.time.healthyAt8hPct}%  median ${doc.time.medianMinutesToCure} min`,
)
