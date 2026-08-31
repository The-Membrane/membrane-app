// Typed mock data ported verbatim from public/proto/dash.html. Every figure here
// is the "measured mock" the proto ships; wallet-scoped blocks render these under
// the DemoBanner until real sources are wired. Do not invent numbers — these are
// the proto's exact values.

import {
  Band,
  CompSlice,
  Delivery,
  Encounter,
  FeedRow,
  Intent,
  LifeItem,
  PointsClass,
  Seat,
  TourStep,
  Venue,
} from './types'

/** Belt deliveries — arrive NET (the loan's interest is subtracted upstream). */
export const FEED: Delivery[] = [
  { amt: 3.55, venue: 'sUSDe', cls: 'synth', eff: '0.35 days of debt burned', ago: '2h ago' },
  { amt: 2.6, venue: 'Aave V3', cls: 'stable', eff: '0.26 days of debt burned', ago: '9h ago' },
  { amt: 4.05, venue: 'VaultV2', cls: 'stable', eff: '0.40 days of debt burned', ago: '17h ago' },
  { amt: 3.6, venue: 'sUSDe', cls: 'synth', eff: '0.35 days of debt burned', ago: 'yesterday' },
  { amt: 2.45, venue: 'Aave V3', cls: 'stable', eff: '0.24 days of debt burned', ago: 'yesterday' },
  { amt: 3.95, venue: 'VaultV2', cls: 'stable', eff: '0.38 days of debt burned', ago: 'yesterday' },
  { amt: 3.3, venue: 'sUSDe', cls: 'synth', eff: '0.32 days of debt burned', ago: '2 days ago' },
  { amt: 2.55, venue: 'Aave V3', cls: 'stable', eff: '0.25 days of debt burned', ago: '2 days ago' },
]

/** The venues, measured. Per-lane rate (del14) also drives the belt animation. */
export const VENUES: Venue[] = [
  {
    nm: 'sUSDe', cls: 'synth', dep: 12667, share: '33.4%', del14: '$4.11 / day', recall: '30%',
    state: 'cooldown idle — no unstake pending', home: 'ethena.fi',
    addr: '0x9d39…c2f1', measured: '2026-08-10 · block 21,882,404',
  },
  {
    nm: 'Aave V3', cls: 'stable', dep: 12667, share: '33.3%', del14: '$2.87 / day', recall: '97%',
    state: 'reserve 61% unborrowed', home: 'aave.com',
    addr: '0x8787…11ab', measured: '2026-08-10 · block 21,882,404',
  },
  {
    nm: 'VaultV2', cls: 'stable', dep: 12666, share: '33.3%', del14: '$3.19 / day', recall: '90%',
    state: '182 positions share this vault', home: 'membrane.money',
    addr: '0x4c2e…9d07', measured: '2026-08-10 · block 21,882,404',
  },
]

/** Measured per-lane $/day for the belt (matches VENUES.del14). */
export const LANE_RATE = [4.11, 2.87, 3.19]

/** Cumulative settled deliveries, per range. Flat runs draw flat (reality). */
export const SERIES: Record<'life' | '90d' | '30d', number[]> = {
  life: [0, 9, 21, 34, 49, 58, 71, 86, 99, 112, 131, 150, 163, 178, 196, 214, 228, 241, 241, 241, 241, 244, 259, 276, 290, 308, 325, 344, 362, 381, 402],
  '90d': [0, 12, 26, 41, 55, 68, 84, 98, 98, 98, 101, 117, 133, 150, 164, 181, 199, 214, 229, 247, 262],
  '30d': [0, 10, 21, 33, 33, 36, 49, 62, 74, 88, 101, 112],
}

/** Benchmark ghost endpoints for the "sold in January" line. */
export const BENCH_SOLD: Record<'life' | '90d' | '30d', number> = { life: 118, '90d': 62, '30d': 21 }

/** Per-intent countdown cards. */
export const INTENTS: Intent[] = [
  {
    id: 0, name: 'Repay', tag: 'Running', active: true,
    lead: '2,024–2,948', leadUnit: 'days', leadBand: 'days', badge: 'venue rates',
    desc:
      'until the debt is gone. The yield pays it off, so you keep the deployed stack as well as the bitcoin. A range, because the harvest rate is venue rates — the same rates every other projection on this page depends on.',
    bar: { type: 'hp', fill: 71, mark: 100 },
    notes: ['$26,980 left', 'of $38,000 borrowed'],
    mini: [
      { label: 'Burned so far', value: '$11,020' },
      { label: 'Burn rate today', value: '$10.17 / day' },
      { label: 'Since you added Fluid', value: '−694 days', color: 'phos' },
      { label: 'Stack at the end', value: '$38,000 — yield repaid, not principal' },
      { label: 'LTV path', value: 'falls every day', color: 'phos' },
      { label: 'Breach odds, next 12 mo', value: '1–12%' },
    ],
  },
  {
    id: 1, name: 'Compound', tag: 'Available', active: false,
    lead: '1,761–2,613', leadUnit: 'days to 2×', leadBand: 'days', badge: 'venue rates',
    desc:
      'until the stack has earned its own size back and can clear the loan by itself. Same end state as Repay. A range, because it is next year’s venue rates and nobody has those.',
    wico: {
      title: 'Use it wisely',
      body:
        'Compounding increases risk and reward. Your LTV rises every day this runs. Breach odds next 12 months: 19–43%, against 1–12% on Repay.',
    },
    bar: { type: 'rng', bandLeft: 38, bandWidth: 36, edges: [38, 74], pt: 9 },
    notes: ['break-even, day 148 (realised)', '2× — centre 2,104'],
    mini: [
      { label: 'Deployed stack', value: '$41,900' },
      { label: 'Surplus realised so far', value: '$1,244' },
      { label: 'Compounds LTV upward', value: 'yes', color: 'gold' },
      { label: 'Breach odds, next 12 mo', value: '19–43%', color: 'blood' },
    ],
  },
  {
    id: 2, name: 'Distribute', tag: 'Available', active: false,
    lead: '$470–710', leadUnit: '/ mo', leadBand: 'vgold', badge: 'projected',
    desc:
      'to your wallet, paid out rather than reinvested. A range because it is next month’s venue rates, not last month’s receipts.',
    bar: { type: 'rng', gold: true, bandLeft: 47, bandWidth: 24, edges: [47, 71], goal: 100 },
    notes: ['47–71% of goal', '$1,000 / mo goal'],
    mini: [
      { label: 'Paid out to date', value: '$3,940' },
      {
        label: 'Withdrawable now', value: '$208',
        claim: {
          title: 'Claim distributed yield',
          rows: [['Withdrawable', '$208.14'], ['To', '0x9a41…c2e0'], ['Debt untouched', 'yes']],
          cta: 'Sign & claim', done: 'Claimed',
        },
      },
      { label: 'Leaves debt untouched', value: 'yes', color: 'gold' },
    ],
  },
]

/** Named market encounters, scored after the fact. */
export const ENCOUNTERS: Encounter[] = [
  {
    when: 'Aug 12, 2026', bad: false, title: 'Survived the Aug 12 wick',
    body:
      'Bitcoin fell 14.2% in 90 minutes. Your headroom bottomed at **3.1 hours** before recovering, and no venue was ever asked for capital. You were drawn at 40% when the same position at 52% would have been recalled — **your sizing is why**.',
    stamp: 'price data measured 2026-08-12 · block 21,904,118',
  },
  {
    when: 'Jul 29, 2026', bad: false, title: 'sUSDe cooldown coincided with a 9% slide',
    body:
      'The one venue that could not have answered was locked for four days. It never mattered, because **Aave and VaultV2 covered the whole requirement** on their own. Two liquid venues did the work of three.',
    stamp: 'price data measured 2026-07-29 · block 21,712,455',
  },
  {
    when: 'Jun 04, 2026', bad: true, title: 'You paid for a lesson here',
    body:
      'A 6% drift crossed the line because the position was drawn at 57% that week. **{neg}$418 of bitcoin was sold{/neg}** to bring it back to the cap. You reduced the draw four days later and it has not happened since.',
    stamp: 'price data measured 2026-06-04 · block 21,204,901',
  },
]

/** Calibration confidence bands. */
export const BANDS: Band[] = [
  { k: '50–60%', ideal: 55, hit: 52, n: 9 },
  { k: '60–70%', ideal: 65, hit: 61, n: 11 },
  { k: '70–80%', ideal: 75, hit: 78, n: 12 },
  { k: '80–90%', ideal: 85, hit: 80, n: 9 },
  { k: '90–100%', ideal: 95, hit: 86, n: 5 },
]

/** Spread dial axis + the today / spiked scenarios. */
export const SPREAD_AXIS = { LO: -10, HI: 14 }
export const SPREAD_TODAY = { apr: 11.9, borrow: 3.0 }
export const SPREAD_SPIKED = { apr: 6.1, borrow: 10.3 }

/** Points & sacrifice classes. */
export const POINTS_CLASSES: PointsClass[] = [
  { c: 'Borrower', sub: 'loan interest', fee: 84.1, r: 0, synced: 0, pend: 121.4, closed: 96.2, active: true },
  { c: 'Lender', sub: 'tranche fees', fee: 97.35, r: 50, synced: 25, pend: 158.9, closed: 112.0, active: true },
  { c: 'RiskManager', sub: 'curator fees', fee: 0, r: 0, synced: 0, pend: 0, closed: 0, active: false },
]

/** Lifestyle-equivalence catalogue (measured rate priced in things). */
export const MEASURED_DAILY = 10.17
export const RATE_MO = MEASURED_DAILY * 30.4
export const LIFE: LifeItem[] = [
  { nm: 'Claude Max (20x)', mo: 200 },
  { nm: 'Claude Pro', mo: 20 },
  { nm: 'Netflix', mo: 18 },
  { nm: 'a Porsche 718 lease', mo: 1200, approx: true },
  { nm: 'the median US mortgage payment', mo: 2700, approx: true },
  { nm: 'a median Manhattan 1BR', mo: 4500, approx: true },
]

/** Lend role: realized fee feed. */
export const LEND_FEED: FeedRow[] = [
  { amt: 28.4, src: 'borrow fees, sUSDS positions — senior share', ago: '2d ago' },
  { amt: 31.1, src: 'borrow fees, scrvUSD positions — junior share', ago: '6d ago' },
  { amt: 6.1, src: 'liquidation fee, sUSDS retrieval in the Aug 12 wick', ago: '12d ago' },
  { amt: 26.85, src: 'borrow fees, sUSDS positions — senior share', ago: '16d ago' },
]

/** Lend role: the two tranche seats. */
export const SEATS: Seat[] = [
  {
    name: 'sUSDS · senior', staked: '$12,000 staked',
    lossOrder: [
      { width: 16, tone: 'teal' },
      { width: 18, tone: 'gold' },
      { width: 44, tone: 'phos', me: true },
      { width: 22, tone: 'blood' },
    ],
    mini: [
      { label: 'In front of you', value: '$3.5M — disco + junior' },
      { label: 'Fees, last 30d', value: '$64.40' },
      { label: 'Withdrawable', value: 'now' },
    ],
  },
  {
    name: 'scrvUSD · junior', staked: '$2,300 staked',
    lossOrder: [
      { width: 14, tone: 'teal' },
      { width: 20, tone: 'gold', me: true },
      { width: 44, tone: 'phos' },
      { width: 22, tone: 'blood' },
    ],
    mini: [
      { label: 'In front of you', value: '$0.4M — disco only' },
      { label: 'Fees, last 30d', value: '$31.10' },
      { label: 'Withdrawable', value: 'in 34 days — listing lock', color: 'gold' },
    ],
  },
]

/** Curate role: realized fee feed. */
export const CURATE_FEED: FeedRow[] = [
  { amt: 112.6, src: 'your 8% of vault fees, epoch settled', ago: '2d ago' },
  { amt: 98.2, src: 'your 8% of vault fees, epoch settled', ago: '9d ago' },
  { amt: 104.75, src: 'your 8% of vault fees, epoch settled', ago: '16d ago' },
]

/** Curate role: where the vault deploys, measured. */
export const CURATE_COMP: CompSlice[] = [
  { label: 'sUSDS lending', pct: 46, tone: 'bone' },
  { label: 'syrupUSDC lending', pct: 31, tone: 'bone' },
  { label: 'scrvUSD lending', pct: 14, tone: 'gold' },
  { label: 'Transmuter LP', pct: 9, tone: 'teal' },
]

/** Demo tour steps (shown only in forced-demo mode). */
export const TOUR_STEPS: TourStep[] = [
  { key: 'poshead', title: 'The whole position', body: 'Collateral, the LTV window, headroom in hours, and the debt. One row, always first.' },
  { key: 'beltlist', title: 'Throughput', body: '$10.17 a day, measured from settled deliveries. Nothing here is projected without a visible range.' },
  { key: 'chartCard', title: 'Deliveries, cumulative', body: 'Every point is money that arrived. Flat weeks draw flat. The chart is allowed to disappoint.' },
  { key: 'intents', title: 'What the yield is doing', body: 'Repay is running. The menu previews the intents you did not pick. Nothing switches unless you switch it.' },
  { key: 'cal2', title: 'Is it luck?', body: 'Call outcomes before they happen and the score measures you, not the position.' },
]
