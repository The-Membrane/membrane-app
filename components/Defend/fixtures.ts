// Mock data ported verbatim from public/proto/defend.html's inline JS.
// These are the illustrative/measured mocks driving every fixture-backed block.

import {
  Baseline,
  DecisionParams,
  LeaderboardRow,
  RegimeBleedRow,
  RegimeKey,
  RegimeSpec,
} from './types'

/** Measured p99.9 8h move, BTC class (percent). */
export const VOL8H = 5.1
/** Clearable depth, $M, measured. */
export const DEPTH = 28
/** Junior coverage (measured mock). */
export const JUNIOR = 0.35
/** Vol stress (measured mock). */
export const VOLSTRESS = 0.31

/** Initial decision-surface lever values (proto `P`). */
export const INITIAL_PARAMS: DecisionParams = {
  M: 0.86,
  g: 0.03,
  cap: 30,
  delay: 8,
  stale: 15,
}

/** Pinned venue baselines shown as ticks under the decision-surface axis. */
export const BASE: Baseline[] = [
  { nm: 'Aave BTC', m: 0.78 },
  { nm: 'Aave ETH', m: 0.83 },
  { nm: 'Morpho', m: 0.86 },
  { nm: 'Liquity', m: 0.9091 },
]

/** Leaderboard rows; regs = edge by hidden regime [calm, vol, depth, cascade]. */
export const ROWS: LeaderboardRow[] = [
  { rk: 1, who: '0x7a41…9c2e', nm: 'Depth-Led Adaptive v2', edge: 3.86, att: 14, regs: [3.2, 4.1, 4.4, 3.7] },
  { rk: 2, who: 'membrane', nm: 'B = M − g (house controller)', edge: 3.41, att: null, house: true, regs: [3.0, 3.6, 3.8, 3.3] },
  { rk: 3, who: '0x22b0…1f77', nm: 'Vol-Gated Caps', edge: 3.12, att: 31, regs: [3.4, 3.9, 2.4, 2.7] },
  { rk: 4, who: 'you', nm: 'submission #3', edge: 2.48, att: 3, you: true, regs: [3.1, 3.3, 2.2, -1.6] },
  { rk: 5, who: 'morpho (static)', nm: '86% fixed', edge: 2.21, att: null, house: true, regs: [3.5, 2.6, 1.4, -0.9] },
  { rk: 6, who: 'aave (static)', nm: '78% BTC / 83% ETH fixed', edge: 1.74, att: null, house: true, regs: [2.2, 1.9, 1.6, 1.2] },
  { rk: 7, who: 'liquity-style', nm: '90.91%, ETH only', edge: 1.32, att: null, house: true, regs: [3.8, 1.9, 0.4, -2.3] },
]

/** Per-regime breakdown of the last submission ("where you bled"). */
export const REG: RegimeBleedRow[] = [
  { nm: 'Calm drift · 412 sims', v: 3.1, why: 'held with the pack' },
  { nm: 'Vol spike · 305 sims', v: 3.3, why: 'your caps tightened in time' },
  { nm: 'Depth shock · 178 sims', v: 2.2, why: 'edge thinned — caps lagged the depth draw' },
  { nm: 'Cascade · 105 sims', v: -1.6, why: 'bad debt: LTV held high into forced flow. This regime alone cost you rank 2.' },
]

/** Max magnitude used to scale the regime-bleed bars. */
export const MAXV = 4.5

/** Sandbox regime specs. */
export const REGIMES: Record<RegimeKey, RegimeSpec> = {
  calm: { vol: 0.012, jump: 0 },
  stress: { vol: 0.03, jump: 0 },
  cascade: { vol: 0.05, jump: 0.12 },
}

/** Live vault performance points (12 weeks) drawn against the sim band. */
export const VAULT_LIVE = [3.7, 3.9, 3.5, 3.2, 3.4, 2.9, 3.1, 2.8, 2.6, 2.9, 2.7, 2.5]
