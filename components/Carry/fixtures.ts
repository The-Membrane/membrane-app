// Typed mock data ported verbatim from public/proto/carry.html. In production
// these blocks are reconstructed by an indexer / the gauntlet; until real
// sources are wired they render under MockStamp / measured stamps.
import {
  Board,
  Collateral,
  OracleInfo,
  Preset,
  RedemptionVenue,
  Route,
} from './types'

/**
 * Window absorption at max draw, % — how much price fall the 4%-LTV window
 * absorbs. Measured from the lending scan (collateral_rank.json).
 */
export const ABSORB = 5.41

/** Leverage rungs offered on the ladder. */
export const LEV = [2, 3, 5, 7]

/** +/- % that fills a full route bar. */
export const ROUTE_SCALE = 12

/**
 * Measured 8h-drawdown tails from the lending scan (~2,950 windows per asset,
 * 2019-2026). Yields are today's, marked as such.
 */
export const COLL: Collateral[] = [
  { sym: 'sUSDS', yld: 6.5, p999: 0.41, worst: 6.26, maxLtv: 0.86, n: 2950 },
  { sym: 'syrupUSDC', yld: 7.8, p999: 0.18, worst: 0.2, maxLtv: 0.86, n: 2101 },
  { sym: 'scrvUSD', yld: 9.2, p999: 0.92, worst: 0.92, maxLtv: 0.8, n: 2986 },
]

/**
 * One dial. Each preset commits a full, NAMED vector — the confirm enumerates
 * every choice the default made (attribution rule). Index 3 is reserved for a
 * board loaded from the leaderboard.
 */
export const PRESETS: Preset[] = [
  {
    id: 'steady',
    nm: 'Steady',
    lev: 2,
    coll: 'syrupUSDC',
    yld: 7.8,
    venues: 'Aave V3 + VaultV2',
    room: 1,
    pd: '2× · deep venues · the 1-in-1000 move uses 1% of your room',
  },
  {
    id: 'balanced',
    nm: 'Balanced',
    lev: 3,
    coll: 'sUSDS',
    yld: 6.5,
    venues: 'Aave V3 + VaultV2 + sUSDe',
    room: 2,
    pd: '3× · mixed venues · 62× covered',
  },
  {
    id: 'reaching',
    nm: 'Reaching',
    lev: 5,
    coll: 'sUSDS',
    yld: 6.5,
    venues: 'sUSDe + VaultV2 + PT',
    room: 4,
    pd: '5× · yield venues · 26× covered · slower recall',
  },
]

/** Default preset selection (Balanced). */
export const DEFAULT_PRESET = 1

/**
 * Boards leaderboard (mock): ranked by floors survived, then net made — the
 * gauntlet's own scoring order. Losers stay on the board; survival grades them
 * down.
 */
export const BOARDS: Board[] = [
  {
    rk: 1,
    nm: 'quiet compounding',
    coll: 'sUSDS',
    lev: 3,
    yld: 6.5,
    venues: 'Aave V3 + VaultV2 + sUSDe',
    room: 2,
    surv: 'cleared 15/15 floors',
    cov: '62× covered',
  },
  {
    rk: 2,
    nm: 'syrup steady',
    coll: 'syrupUSDC',
    lev: 2,
    yld: 7.8,
    venues: 'Aave V3 + VaultV2',
    room: 1,
    surv: 'cleared 15/15 floors',
    cov: 'the 1-in-1000 move uses 1% of room',
  },
  {
    rk: 3,
    nm: 'reach with a rope',
    coll: 'sUSDS',
    lev: 5,
    yld: 6.5,
    venues: 'sUSDe + VaultV2 + PT',
    room: 4,
    surv: 'cleared 13/15 floors',
    cov: '26× covered · slower recall',
  },
  {
    rk: 4,
    nm: 'scrv hot',
    coll: 'scrvUSD',
    lev: 5,
    yld: 9.2,
    venues: 'PT + sUSDe + VaultV2',
    room: 9,
    surv: 'cleared 9/15 floors',
    cov: 'thin — died to the rate spiral twice',
  },
  {
    rk: 5,
    nm: 'full send',
    coll: 'scrvUSD',
    lev: 7,
    yld: 9.2,
    venues: 'PT + PT + sUSDe',
    room: 18,
    surv: 'died on floor 6',
    cov: 'wiped — partial liq took the board',
    dead: true,
  },
]

const LY = 'https://defillama.com/yields?token='
const LP = 'https://defillama.com/protocol/'

/**
 * The measured Aug 2026 carry-route table (A+B evidence, 1,245 positions).
 * Each side is a quiet link: token sides → DefiLlama yields filter, product
 * sides → the protocol's DefiLlama page.
 */
export const ROUTES: Route[] = [
  { proto: 'Morpho Blue', src: 'AUSD', su: LY + 'AUSD', dst: 'Staked USDat', du: LY + 'USDAT', pos: 15, net: 11.53 },
  { proto: 'Morpho Blue', src: 'apxUSD', su: LY + 'APXUSD', dst: 'ApyUSD', du: LY + 'APYUSD', pos: 19, net: 9.01 },
  { proto: 'Aave V3', src: 'USDT', su: LY + 'USDT', dst: 'Fluid', du: LP + 'fluid', pos: 15, net: 3.91 },
  { proto: 'Morpho Blue', src: 'USDC', su: LY + 'USDC', dst: 'VaultV2', du: LP + 'morpho', pos: 182, net: 3.44, big: true },
  { proto: 'Spark', src: 'USDS', su: LY + 'USDS', dst: 'StUsds', du: LY + 'SUSDS', pos: 21, net: 2.59 },
  { proto: 'Morpho Blue', src: 'PYUSD', su: LY + 'PYUSD', dst: 'StakingVault', du: LY + 'PYUSD', pos: 26, net: 1.98 },
  { proto: 'Aave V3', src: 'USDe', su: LY + 'USDE', dst: 'Staked USDe', du: LY + 'SUSDE', pos: 25, net: 0.62 },
  { proto: 'Compound v3', src: 'USDC', su: LY + 'USDC', dst: 'USD3', du: LY + 'USD3', pos: 78, net: 0.22 },
  { proto: 'Aave V3', src: 'RLUSD', su: LY + 'RLUSD', dst: 'VaultV2', du: LP + 'morpho', pos: 37, net: -0.36 },
  { proto: 'Aave V3', src: 'USDC', su: LY + 'USDC', dst: 'Compound', du: LP + 'compound-finance', pos: 20, net: -0.78 },
  { proto: 'Morpho Blue', src: 'PYUSD', su: LY + 'PYUSD', dst: 'VaultV2', du: LP + 'morpho', pos: 54, net: -2.43 },
  { proto: 'Aave V3', src: 'GHO', su: LY + 'GHO', dst: 'UmbrellaStakeToken', du: LP + 'aave', pos: 21, net: -3.75, note: 'confirmed 0% module' },
]

/**
 * Redemption history per venue: "if I get liquidated, does this venue give the
 * capital back in time?" Fill = served/requested (VaultServed); VaultSlashed is
 * the strongest negative; VenueRecalled counts real liquidations. Deliberately
 * NOT framed as lender flight; no premium column (redemption is 1:1 at peg).
 */
export const RH: RedemptionVenue[] = [
  {
    v: 'Aave V3',
    sub: 'money market',
    req: 412000,
    srv: 412000,
    slash: 0,
    slashAmt: 0,
    rec: 34,
    recOk: 34,
    ban: false,
    noteSegments: [{ t: 'every liquidation recall served in full' }],
  },
  {
    v: 'VaultV2',
    sub: '4626 vault',
    req: 268400,
    srv: 267300,
    slash: 0,
    slashAmt: 0,
    rec: 41,
    recOk: 41,
    ban: false,
    noteSegments: [{ t: 'one partial fill re-served next block' }],
  },
  {
    v: 'sUSDe',
    sub: 'ethena cooldown',
    req: 151200,
    srv: 131600,
    slash: 1,
    slashAmt: 12400,
    rec: 11,
    recOk: 9,
    ban: false,
    noteSegments: [
      { t: '2 recalls fell inside the cooldown', tone: 'gold' },
      { t: ' — served after the liquidation had already closed' },
    ],
  },
  {
    v: 'PT (fixed maturity)',
    sub: 'pendle',
    req: 96800,
    srv: 96800,
    slash: 0,
    slashAmt: 0,
    rec: 8,
    recOk: 6,
    ban: false,
    oracle: 'PT',
    noteSegments: [{ t: '2 pre-maturity recalls sold at market: full size, −0.9% price' }],
  },
]

// ── Oracle info cards ───────────────────────────────────────────────────────
// Written in DEPLOYED VOICE (owner ruling): each card describes the oracle path
// as live. Facts sourced from membrane-solidity (Oracle.sol, Adapter4626Base.sol,
// AUTONOMOUS-ORACLE-RISK-REGISTER.md), read Aug 26 2026 — line numbers drift, the
// code is the truth. LAUNCH GATE: before this ships publicly each asset named
// here must actually be wired (Oracle.setAdapterSource / route config) and the PT
// template registered; tracked in docs/GAME_LAUNCH_PLAN.md P3.

const TIMELOCK =
  'Three numeric risk params (fallback window, max deviation, breaker threshold) sit behind a <b class="mut">14-day timelock</b>; listing powers <b class="mut">die permanently at renounceOwnership()</b>. The circuit breaker is permissionless — deviation math, not a key.'
const NOSIG =
  'No committee reports this price: <b class="not">no signer set or multisig attestation exists</b> anywhere in the oracle stack — only pool math.'

const ADAPTER_SUM =
  'Priced as the vault’s own share rate × the underlying’s on-chain Uniswap TWAP. No Chainlink anywhere in this stack — feeds that cannot stand alone are barred from being primary.'
const ADAPTER_BULLETS = [
  'The vault’s <b class="does">share rate does affect</b> the price — instantly on the way down, growth-capped on the way up (max-yield-per-second clamp; under-pricing collateral is the safe direction).',
  'The underlying’s <b class="does">1-hour Uniswap TWAP does affect</b> the price.',
  'The wrapper’s own <b class="not">market quote does not affect</b> it — the oracle reads the vault’s exchange rate, not a pool price of the wrapper.',
  'The price <b class="does">can float above $1</b> as yield accrues — adapter assets are deliberately exempt from the USD-par clamp.',
  NOSIG,
  TIMELOCK,
]

const TWAP_SUM =
  'Two-tier Uniswap V3 TWAP: a 1-hour window primary, and a 10-minute read of the same pool as fallback. If both fail, the price REVERTS — borrows halt rather than running on a stale number.'
const TWAP_BULLETS = [
  'The pool’s <b class="does">1h TWAP does affect</b> your liquidation line; the fallback is a <b class="does">shorter read of the same pool</b> — never a number someone typed.',
  'A <b class="not">stale price is never served</b>: both windows failing halts pricing (PriceStale) instead of freezing a value.',
  'Both tiers readable but diverging beyond the deviation cap also <b class="not">refuses to price</b> (OracleSourcesDisagree).',
  NOSIG,
  TIMELOCK,
]

export const ORACLE_PROV =
  'Sources: Oracle.sol · Adapter4626Base.sol · OracleTemplateFactory.sol · AUTONOMOUS-ORACLE-RISK-REGISTER.md (membrane-solidity, read Aug 26 2026 — line numbers drift, the code is the truth). Written to the best of our ability; for exact behavior, read the oracle code itself.'

export const ORACLE: Record<string, OracleInfo> = {
  sUSDS: { tag: ['med', 'medium (AOR-3/5 · share-rate)'], sum: ADAPTER_SUM, li: ADAPTER_BULLETS },
  syrupUSDC: { tag: ['med', 'medium (AOR-3/5 · share-rate)'], sum: ADAPTER_SUM, li: ADAPTER_BULLETS },
  scrvUSD: { tag: ['med', 'medium (AOR-3/5 · share-rate)'], sum: ADAPTER_SUM, li: ADAPTER_BULLETS },
  WBTC: {
    tag: ['med', 'medium (AOR-2 · route depth)'],
    sum: TWAP_SUM,
    li: TWAP_BULLETS.concat([
      'Register’s live residual for TWAP assets: <b class="mut">thin or self-created pools</b> (AOR-2, medium) — no minimum-liquidity floor exists on autonomous routes today.',
    ]),
  },
  wstETH: { tag: ['med', 'medium (AOR-2 · route depth)'], sum: TWAP_SUM, li: TWAP_BULLETS },
  PT: {
    tag: ['med', 'medium (AOR-6 · basis risk)'],
    pt: true,
    sum: 'Takes the LOWER of two prices: the PT’s own market TWAP, and a linear discount curve that rises to one dollar at maturity. Whichever is lower is what your liquidation line is measured against — the oracle never pays you for optimism in the PT market.',
    li: [
      'The market’s <b class="does">implied APY does affect</b> the price — rates up, PT price down, hardest early in the term.',
      '<b class="does">Time to maturity does affect</b> it: the pull to par shrinks duration risk every day.',
      'The <b class="not">redemption value at maturity is not the risk</b> — held to term, the PT redeems at the underlying’s value. The path BETWEEN now and then is what can liquidate you.',
      'At the 90% LTV hard cap the <b class="mut">6.4% recovery margin is below the worst observed ~7% PT clearing discount</b> (AOR-8, high) — oracle-correct bad debt is possible at max LTV.',
      NOSIG,
    ],
    wire: 'The chart is a model, not history: 6%/yr discount over a 180-day term, drawn to show how the price behaves through the life of the position. Your PT’s own curve is set by its term and listing discount.',
  },
}
