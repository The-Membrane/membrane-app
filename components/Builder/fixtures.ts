// Mock data ported verbatim from public/proto/builder.html.
// Every venue, template, scenario, and doctrine below is fixture data — stamp
// blocks driven by it with <MockStamp/>.

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { Scenario, Template, Tile, VenueClass } from './types'

// Engine constants (proto :612, :1208, :1458).
export const BTC_PX = 95000
export const BORROW = 0.03
export const MAX_LTV = 0.73
export const MAX_BORROW = 0.6
export const DIVEST_LOSS = 0.18 // what a force-crystallised venue gives back short
export const CAL_MIN = 20 // no calibration score shown below this many resolved calls

// localStorage keys (proto :1440, :2335, :2547).
export const CAL_KEY = 'membrane.calls.v1'
export const SEEDS_KEY = 'membrane.seeds.v1'
export const VIEW_KEY = 'membrane.view'

// Shocks travel by what a venue HOLDS, so class is the unit of shared risk. Colour is
// redundant with the written label on purpose. Proto used raw hex #ece6d8/#46d39a/#d8b24a;
// mapped to the nearest semantic tokens (bone / teal-info / gold-warning).
export const CLASS_COLOR: Record<VenueClass, string> = {
  stable: SEMANTIC_COLORS.textPrimary, // bone — "plain" is the honest read for stables
  lst: SEMANTIC_COLORS.info, // cyber teal
  synth: SEMANTIC_COLORS.warning, // gold
}
export const CLASS_NM: Record<VenueClass, string> = {
  stable: 'stablecoin',
  lst: 'liquid staking',
  synth: 'synthetic dollar',
}

// Belt colours for the factory-floor canvas (proto COL :738).
export const BELT_COLOR = {
  teal: SEMANTIC_COLORS.info,
  phos: SEMANTIC_COLORS.success,
  gold: SEMANTIC_COLORS.warning,
  bone: SEMANTIC_COLORS.textSecondary,
}

export const TEMPLATES: Template[] = [
  {
    nm: 'Max draw',
    slots: ['ptoken'],
    ltv: 0.5,
    doc: 'Borrows near the cap and puts all of it in the best fixed rate on the board. What it leaves out is an exit: a principal token cannot be redeemed before maturity, so when the crash calls for capital there is a market to sell into and nothing else. The rate was never the problem.',
  },
  {
    nm: 'Depth-led',
    slots: ['ptoken', 'vault', 'fluid'],
    ltv: 0.48,
    doc: 'Two of the deepest venues on the board, plus the best rate, sized on the strength of that vetting. What it leaves out is headroom. The deep venues really are deep and they really do pay out — they are just answering for a position that was already too large while everything was still fine.',
  },
  {
    nm: 'Yield stack',
    slots: ['ptoken', 'susde', 'wsteth'],
    ltv: 0.46,
    doc: 'The three highest rates, spread across three different assets, which looks like diversification and is. What it leaves out is anything that actually comes back: a fixed maturity, a cooldown and an unstaking queue return about a third of what they hold between them, so when the bar moves underneath there is nothing to answer with.',
  },
  {
    nm: 'One basket',
    slots: ['wsteth', 'reth'],
    ltv: 0.42,
    doc: 'Two venues, both liquid staking. It reads as diversified because there are two of them, but they answer to the same asset — one bet wearing two names. What it leaves out is decorrelation, and the fortnight that broke the staking peg took bitcoin down with it, so the freeze and the margin call arrive together.',
  },
]

export const TILES: Tile[] = [
  { id: 'aave', nm: 'Aave V3', cls: 'stable', apr: 0.042, liq: 0.97, spd: 1, note: 'lending, holds USDC' },
  { id: 'vault', nm: 'VaultV2', cls: 'stable', apr: 0.076, liq: 0.9, spd: 1, note: '182 real positions run this' },
  { id: 'fluid', nm: 'Fluid', cls: 'stable', apr: 0.075, liq: 0.85, spd: 1, note: 'lending, holds USDC' },
  { id: 'usd3', nm: 'USD3', cls: 'stable', apr: 0.068, liq: 0.8, spd: 0.9, note: '' },
  { id: 'yearn', nm: 'Yearn V2', cls: 'stable', apr: 0.082, liq: 0.62, spd: 0.3, note: 'unwinds on a lag' },
  { id: 'wsteth', nm: 'wstETH vault', cls: 'lst', apr: 0.094, liq: 0.7, spd: 0.55, note: 'staking yield, depeg risk' },
  { id: 'reth', nm: 'rETH vault', cls: 'lst', apr: 0.088, liq: 0.66, spd: 0.55, note: 'staking yield, depeg risk' },
  { id: 'ptoken', nm: 'PT (fixed)', cls: 'synth', apr: 0.145, liq: 0.12, spd: 0, note: 'best rate on the board, no exit until maturity' },
  { id: 'susde', nm: 'sUSDe', cls: 'synth', apr: 0.118, liq: 0.3, spd: 0, note: 'funding rate, 7-day cooldown' },
]

// The fifteen floors: real episodes first, then the mechanisms that only exist because
// the contracts do. Each declares HOW it reaches you (coll / hair / freeze / fail /
// rate / ltvCut / stale / timer / bleed / closed / divest). Proto BASE_SCENARIOS :1084.
export const BASE_SCENARIOS: Scenario[] = [
  {
    n: 'Calm drift', era: 'baseline', days: 90, coll: 0.06, hair: {}, freeze: [], fail: 0,
    mech: 'Nothing breaks. Bitcoin drifts, the venues pay, and the position simply accrues. This floor exists so you can see the machine running before anything is done to it.',
  },
  {
    n: 'Black Thursday', era: 'Mar 2020', days: 1, coll: 0.5, hair: {}, freeze: [], fail: 0,
    mech: 'A pure collateral shock. Bitcoin halves inside a day and your LTV nearly doubles. Nothing is frozen here and no venue fails — but not frozen is not the same as returns everything. Each venue still hands back only its own share, so this floor is decided by two things at once: how much you drew, and how much of what you deployed can actually come back on the day. A board of shallow venues loses bitcoin here even though every one of them is working perfectly.',
  },
  {
    n: 'FTX', era: 'Nov 2022', days: 5, coll: 0.25, hair: {}, freeze: [], fail: 1,
    mech: 'Collateral falls 25%, and separately one venue simply stops existing — a counterparty failure, not a price move. The engine loses that slot entirely and recalls from what remains. It takes your largest position first, because that is how these actually land.',
  },
  {
    n: 'May capitulation', era: 'May 2021', days: 21, coll: 0.53, hair: {}, freeze: [], fail: 0,
    mech: 'A slow bleed rather than a wick — 53% over three weeks, with no single candle to survive. Nothing freezes, so every venue returns its ordinary share and nothing more; on a shallow board that is still most of the damage. What this floor asks is whether you were sized for the destination rather than for the path.',
  },
  {
    n: 'Rate spiral', era: '2022-23 regime', days: 365, coll: 0.12, rate: 0.22, hair: {}, freeze: [], fail: 0,
    mech: 'Nothing breaks and nothing depegs. The adaptive borrow rate climbs to 22% and stays there for a year, and the excess over baseline compounds into the debt instead of being paid out of carry. Bitcoin only slips 12%. Your LTV rises anyway — because the numerator grew, not because the denominator fell. This is the floor that kills a position whose owner never saw a bad price. The only defences are a venue spread wider than the borrow rate, or less debt to compound.',
  },
  {
    n: 'stETH depeg', era: 'Jun 2022', days: 14, coll: 0.42, hair: { lst: 0.02 }, freeze: ['lst'], fail: 0,
    mech: 'The depeg did not arrive alone. Celsius and 3AC went down in the same fortnight and bitcoin fell 42% with them, so the collateral move and the freeze land together — which is the only reason this floor is dangerous. Liquid-staking venues trade slightly under peg and, far more importantly, stop redeeming while the exit queue clears. The peg itself recovered, so holding through it costs almost nothing; being asked for capital while the queue is shut is what costs you. Stablecoin and synthetic venues are not frozen — though they still return only their usual share, which is the part people forget.',
  },
  {
    n: 'The line moves', era: 'governance', days: 30, coll: 0.1, ltvCut: 0.12, hair: {}, freeze: [], fail: 0,
    mech: 'No shock at all. The Disco-averaged max LTV for bitcoin is voted down and your liquidation line drops from 73% to 61% — the bar moves under a position that did not. Every sizing decision you made was measured against the old line. Headroom you never spent is the only thing that survives this, and it is the cheapest insurance available on this board.',
  },
  {
    n: 'USDC depeg', era: 'Mar 2023', days: 4, coll: 0.0, hair: { stable: 0.01 }, freeze: ['stable'], fail: 0,
    mech: 'The mirror image of the last floor. Bitcoin is flat, but stablecoin venues stop paying out: the panic drains the lending reserves, utilisation pins at 100%, and there is simply no unborrowed USDC left to withdraw. It recovered, so simply waiting costs you a rounding error — the trap is being liquidated during the window and eating the discount for real. LST and synthetic venues are not frozen, which is not the same as being able to hand back everything they hold.',
  },
  {
    n: 'Cure or die', era: 'mechanism', days: 3, coll: 0.5, timer: 1, hair: {}, freeze: ['synth'], fail: 0,
    mech: 'You breach, but not far enough past the line for an instant liquidation — the engine starts a timer and gives you one window to cure it. Only capital that can actually arrive inside that window counts: instant lending positions land in full, staking wrappers land slowly, anything in cooldown does not land at all. This is the only floor that grades venue SPEED rather than venue depth. Cure it and the position is saved outright with nothing sold; miss and you are liquidated from further underwater than you started.',
  },
  {
    n: 'Funding flip', era: 'adversarial', days: 7, coll: 0.15, hair: {}, bleed: { synth: 0.1 }, freeze: ['synth'], fail: 0,
    mech: 'Perpetual funding goes deeply negative. Synthetic-dollar venues bleed 10% of principal — this one is a real loss, not a dislocation that mean-reverts — and enter cooldown at the same moment, so the capital is both worth less and unreachable. Bitcoin only slips 15% — the damage is in the venue, not the collateral.',
  },
  {
    n: 'Blacklisted', era: 'mechanism', days: 12, coll: 0.46, hair: {}, freeze: ['stable'], fail: 0,
    mech: 'A venue that fails to deliver on a recall does not simply disappoint. The engine marks it failed and bans it from every subsequent liquidation until the ban expires — and the ban outlives the venue’s own recovery, because it is punitive rather than diagnostic. So a venue that goes quiet here is still absent on the next floor even after it is healthy again. Redundancy answers this. Re-tuning does not, because the ban follows the venue, not the slot.',
  },
  {
    n: 'Bad data', era: 'mechanism', days: 20, coll: 0.47, stale: 0.45, hair: {}, freeze: [], fail: 0,
    mech: 'Every venue is healthy and every number you are looking at is wrong. The live NAV read reverts, so the vault quietly serves its last cached value instead of failing loudly — the receipt below shows what was REPORTED beside what actually arrived. You sized against the reported figure, and the gap is the whole floor. A number with no timestamp is a rumour. This is the one floor you cannot beat by being clever, only by leaving room for the reading itself to be wrong.',
  },
  {
    n: 'Doors locked', era: 'mechanism', days: 9, coll: 0.48, closed: 1, rate: 0.09, hair: {}, freeze: [], fail: 0,
    mech: 'The oracle trips its circuit breaker, so isPriceSafe() returns false and liquidate() reverts outright. You breach the line and nothing happens — the protocol cannot sell you. It also cannot let you deposit, withdraw or borrow, so you cannot cure it either, and interest keeps compounding the whole time the doors are shut. This floor never takes a single satoshi. It hands you to the next one already underwater, which is the entire point: being un-liquidatable is not the same as being safe.',
  },
  {
    n: 'Forced exit', era: 'mechanism', days: 26, coll: 0.44, divest: 1, hair: {}, freeze: [], fail: 0,
    mech: 'Any venue that has been unresponsive since an earlier floor has now been unresponsive long enough to trip the divest window, and that trigger is permissionless — anyone at all can pull it. Whatever is left in that venue is force-crystallised at whatever it happens to be worth. Capital that was merely stuck becomes capital that is realised at a loss. Bitcoin also falls 44% while this happens, so the floor is never free — but the crystallisation part of it only bills you if you were already carrying a venue that had gone quiet.',
  },
  {
    n: 'Everything', era: 'adversarial', days: 2, coll: 0.6, hair: { lst: 0.05, stable: 0.02 }, bleed: { synth: 0.08 }, freeze: ['lst', 'synth', 'stable'], fail: 1,
    mech: 'All four channels at once: a 60% collateral crash, haircuts across every asset class, every class frozen, and one venue gone. Nothing is recallable in time. This floor cannot be beaten by picking venues — only by never having borrowed enough to need them.',
  },
]

// Why a frozen slot returns nothing (proto FREEZE_WHY :1225).
export const FREEZE_WHY: Record<VenueClass, string> = {
  lst: 'the unstaking queue is shut — your money is fine, it just cannot come out until the queue clears',
  synth: 'in its cooldown — this venue pays the most precisely because it makes you wait to leave',
  stable: 'the lending pool is empty — everyone withdrew at once and there is nothing left to hand you',
}

// Why a healthy venue still only hands back part of what it holds (proto LIQ_WHY :1232).
export const LIQ_WHY: Record<string, string> = {
  aave: 'you can only take out what other people have not already borrowed',
  fluid: 'you can only take out what other people have not already borrowed',
  yearn: 'most of the money is out working in strategies and has to be unwound first',
  susde: 'only the part not sitting in a cooldown can leave today',
  ptoken: 'it cannot be redeemed until it matures, so the only way out is selling it to someone',
  wsteth: 'staked ETH has to be unwrapped and queued before it is cash again',
  reth: 'staked ETH has to be unwrapped and queued before it is cash again',
  usd3: 'you can only take out what has not already been lent on to someone else',
}

// Reference doctrines re-run against the drawn floors (proto DOCTRINE_DEFS :2250).
export const DOCTRINE_DEFS = [
  { who: 'Reference — sized to depth', build: 'borrow capped to absorbable size', slots: ['aave', 'vault', 'fluid'], ltv: 0.44 },
  { who: 'Reference — narrow list', build: 'few vetted venues, sized larger', slots: ['aave', 'vault'], ltv: 0.55 },
]

// Net-made equivalences for the share card (proto EQUIV :2116).
export const EQUIV = [
  { nm: 'Claude Max', mo: 200 },
  { nm: 'Claude Pro', mo: 20 },
  { nm: 'Netflix', mo: 18 },
]

// Short floor names for seed-experience labels (proto SHORT :2347).
export const SHORT_NAMES = [
  'calm drift', 'Thursday', 'FTX', 'capitulation', 'rate year', 'stETH depeg',
  'the vote', 'USDC freeze', 'cure window', 'funding flip', 'blacklist',
  'bad data', 'locked doors', 'forced exit', 'everything',
]
