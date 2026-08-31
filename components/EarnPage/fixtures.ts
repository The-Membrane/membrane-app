// Mock data ported 1:1 from public/proto/supply.html's inline <script> (lines ~239-334, ~424-465).
// Every figure here is a MockStamp-labeled placeholder until real reads are wired.

import {
  CapacityBand,
  PoolAsset,
  RevenueEntry,
  SeatOption,
  ShopOption,
  VenueLiquidity,
  WaterfallSeat,
  ExecRequest,
} from './types'

/** Sect 00 — the seat picker options (proto :172-176). */
export const SEAT_OPTIONS: SeatOption[] = [
  { value: 'sUSDS senior', label: 'sUSDS · senior' },
  { value: 'sUSDS junior', label: 'sUSDS · junior — first staked loss, higher share' },
  { value: 'scrvUSD junior', label: 'scrvUSD · junior' },
]

export const DEFAULT_STAKE_SEAT = SEAT_OPTIONS[0].value
export const DEFAULT_STAKE_AMOUNT = '5000'

/** Sect 01 — pool composition (proto :244-249). */
export const POOL_COMPOSITION: PoolAsset[] = [
  { sym: 'sUSDS', grp: 'yield-$', share: 46 },
  { sym: 'syrupUSDC', grp: 'yield-$', share: 31 },
  { sym: 'scrvUSD', grp: 'yield-$', share: 14 },
  { sym: 'WBTC', grp: 'BTC', share: 9 },
]

export const COMPOSITION_STAMP = 'composition measured 2026-08-11 · block 21,889,120'

/** Sect 02 — withdrawal capacity bands (proto :424-428). Order matters: instant, cooling, stranded — never reordered or folded. */
export const CAPACITY_BANDS: CapacityBand[] = [
  { key: 'instant', label: 'INSTANT — exits now', amountUsd: 2_950_000 },
  { key: 'cooling', label: 'COOLING — lands Aug 22, 04:10 UTC', amountUsd: 640_000 },
  { key: 'stranded', label: 'STRANDED — needs an operator crank', amountUsd: 1_570_000 },
]

export const YOUR_MAX_WITHDRAW_USD = 11_730

/** Sect 02 — per-venue breakdown (proto :429-440). */
export const VENUE_LIQUIDITY: VenueLiquidity[] = [
  {
    venue: 'idle + buffer',
    sub: 'vault layer',
    instantUsd: 730_000,
    coolingUsd: 0,
    strandedUsd: 0,
    note: [{ text: 'always instant', bold: true }, { text: ' · bufferBalance() + idle' }],
  },
  {
    venue: 'Aave V3',
    sub: 'no cooldown',
    instantUsd: 1_240_000,
    coolingUsd: 0,
    strandedUsd: 0,
    note: [
      { text: 'cooling is ' },
      { text: 'zero by construction', bold: true },
      { text: ' · recalls synchronously inside every withdraw' },
    ],
  },
  {
    venue: 'VaultV2',
    sub: '4626 · no cooldown',
    instantUsd: 980_000,
    coolingUsd: 0,
    strandedUsd: 0,
    note: [{ text: 'buffer self-heals one layer down (_refillBuffer on every withdraw)' }],
  },
  {
    venue: 'sUSDe',
    sub: 'ethena cooldown',
    instantUsd: 0,
    coolingUsd: 640_000,
    strandedUsd: 1_570_000,
    note: [
      { text: '$1.57M stranded', tone: 'danger', bold: true },
      {
        text:
          ": Ethena's global cooldown makes _venueLiquid() read 0, and nothing in the withdraw path starts a cooldown — recall needs the operator. ",
      },
      { text: '$0.64M cooling', tone: 'warning', bold: true },
      { text: ' from the crank on Aug 15, unlocks in 4d 11h' },
    ],
  },
]

export const CAPACITY_READS_STAMP =
  'mock values shaped to the real reads: instantLiquidity() · bufferBalance() · maxWithdraw(you) · ' +
  "coolingAssets · the cooling ETA is reconstructed from Ethena's live cooldownDuration() and is wrong if " +
  'that parameter changes mid-cooldown — a start-time snapshot is being added on-chain'

/** Sect 03 — per-collateral loss order (proto :262-269). No reserve exists; disco stake on that
 * collateral's slots is the first capital at risk. */
export const WATERFALL_SEATS: Record<string, WaterfallSeat> = {
  sUSDS: {
    sym: 'sUSDS',
    seat: 'senior',
    discoUsd: '$1.6M',
    discoWidth: 16,
    juniorUsd: '$1.9M',
    juniorWidth: 18,
    seniorUsd: '$6.2M',
    seniorWidth: 44,
    caption:
      'You hold senior sUSDS. Two layers stand in front of you: $1.6M of disco stake on sUSDS slots, ' +
      'then $1.9M junior. A haircut reaches you only after both are gone.',
  },
  scrvUSD: {
    sym: 'scrvUSD',
    seat: 'junior',
    discoUsd: '$0.4M',
    discoWidth: 14,
    juniorUsd: '$0.6M',
    juniorWidth: 20,
    seniorUsd: '$1.4M',
    seniorWidth: 44,
    caption:
      'You hold junior scrvUSD. One layer stands in front of you: $0.4M of disco stake on scrvUSD slots. ' +
      'Your tranche is the first staked capital to take a loss.',
  },
}

export const DEFAULT_WATERFALL_ASSET = 'sUSDS'

/** Sect 04 — realized revenue feed (proto :293-299). */
export const REVENUE_FEED: RevenueEntry[] = [
  { amountUsd: 28.4, source: 'borrow fees from sUSDS positions, senior share', ago: '2d ago' },
  { amountUsd: 9.15, source: 'borrow fees from syrupUSDC positions, senior share', ago: '2d ago' },
  { amountUsd: 6.1, source: 'liquidation fee, sUSDS retrieval in the Aug 12 wick', ago: '12d ago' },
  { amountUsd: 26.85, source: 'borrow fees from sUSDS positions, senior share', ago: '9d ago' },
  { amountUsd: 8.9, source: 'borrow fees from scrvUSD positions, senior share', ago: '9d ago' },
]

export const UNCLAIMED_FEES_USD = 97.35

export const CLAIM_FEES_REQUEST: ExecRequest = {
  title: 'Claim fees',
  rows: [
    { label: 'Unclaimed', value: '$97.35' },
    { label: 'From', value: 'sUSDS senior · scrvUSD junior' },
    { label: 'To', value: '0x9a41…c2e0' },
  ],
  cta: 'Sign & claim',
  done: 'Claimed',
}

/** Sect 05 — shop window: unlisted candidates from the lending scan (proto :308-311). */
export const SHOP_OPTIONS: ShopOption[] = [
  { sym: 'sDAI', p999: 0.35, mcap: '$171M', band: '4–9%', windowCount: 2950, src: '145.1M supply @ $1.179' },
  { sym: 'USDY', p999: 2.82, mcap: '$1.11B', band: '3–8%', windowCount: 2986, src: '971.6M supply @ $1.140' },
  { sym: 'cbBTC', p999: 5.1, mcap: '$3.13B', band: '6–14%', windowCount: 2992, src: '48.3k supply @ $64,895' },
]

export const SHOP_STAMP =
  'candidates and tails from the lending scan · 2,950+ eight-hour windows per asset · projected revenue is ' +
  'a band because it depends on borrow demand nobody controls'

/** Sect 05 — every listing offer stakes a fixed $25,000 junior tranche (proto :331). */
export const LIST_STAKE_USD = 25_000
