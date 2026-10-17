/**
 * COLLECT DUST. The tiny supply leftovers an address holds on the supported venues, and the
 * one slip that sweeps them all. Pure functions: what the reader read in, the calls the
 * wallet signs and the slip's figures out. tests/unit/positionDust.test.ts covers which
 * positions qualify and when the gas costs more than the dust returns.
 *
 *   Morpho Blue   withdraw(marketParams, 0, supplyShares, owner, owner)   by SHARES, so the
 *                 position is cleared exactly; it pays toAssetsDown(shares), often 0
 *   Aave V3       Pool.withdraw(asset, type(uint256).max, owner)          the whole aToken
 *   (and Spark)   balance, whatever it has accrued to when the call lands
 *
 * DUST. A supply position qualifies when it pays out nothing (assets 0: shares that round
 * to no asset), or when it is PRICED and worth under DUST_USD. A position with assets but
 * no price read is not called dust: an unpriced half-WBTC is not a leftover. Nothing here
 * defaults a price.
 *
 * Gas against value: the slip says what the sweep returns in dollars and what its gas
 * costs at today's fee. It does not block: clearing a position is a reason of its own.
 * It warns: 'nothing' when nothing is returned, 'gas-exceeds' when the gas costs more.
 */

import { formatEther, maxUint256 } from 'viem'

import type { EvmCall } from '@/services/chain/types'

import { aavePoolAbi, morphoAbi } from './abis'
import { fmtUnits } from './amount'
import type { Address, MorphoMarketParams } from './builders'
import type { Gate } from './gates'
import { sheetView, type PrepState, type SheetView, type TxState, type WalletState } from './sheet'
import { buffered, type SimResult } from './simulate'

/** Under this many dollars a priced supply position is dust (owner, 2026-10-17: "under $1"). */
export const DUST_USD = 1

export type DustVenue = 'morpho-blue' | 'aave-v3' | 'spark'

interface DustBase {
  /** "Morpho · WBTC/USDC 86%", "Aave V3 · USDC" */
  label: string
  /** The token you receive. */
  symbol: string
  token: Address
  decimals: number
  /** What the withdraw pays out as read, in token units (Morpho: rounded down). */
  assets: bigint
  /** USD per whole token; null when no price was read. */
  priceUsd: number | null
}

export type DustCandidate =
  | (DustBase & {
      venue: 'morpho-blue'
      morpho: Address
      marketId: `0x${string}`
      params: MorphoMarketParams
      shares: bigint
    })
  | (DustBase & {
      venue: 'aave-v3' | 'spark'
      pool: Address
      /** The reserve's paused bit: a paused reserve refuses withdraw. */
      paused: boolean
    })

export type DustVerdict =
  | { dust: true; why: 'zero' | 'under' }
  | { dust: false; why: 'empty' | 'unpriced' | 'worth' }

const held = (c: DustCandidate) => (c.venue === 'morpho-blue' ? c.shares > 0n : c.assets > 0n)

/** Value in USD of `units` at `priceUsd`; exact enough for a sub-dollar comparison. */
export const unitsUsd = (units: bigint, decimals: number, priceUsd: number): number =>
  (Number(units) / 10 ** decimals) * priceUsd

export function dustVerdict(c: DustCandidate): DustVerdict {
  if (!held(c)) return { dust: false, why: 'empty' }
  if (c.assets === 0n) return { dust: true, why: 'zero' }
  if (c.priceUsd === null) return { dust: false, why: 'unpriced' }
  return unitsUsd(c.assets, c.decimals, c.priceUsd) < DUST_USD
    ? { dust: true, why: 'under' }
    : { dust: false, why: 'worth' }
}

/** The candidates that qualify, in the order read, and the held ones that do not. */
export function splitDust(cands: readonly DustCandidate[]): {
  dust: DustCandidate[]
  kept: { c: DustCandidate; why: 'unpriced' | 'worth' }[]
} {
  const dust: DustCandidate[] = []
  const kept: { c: DustCandidate; why: 'unpriced' | 'worth' }[] = []
  for (const c of cands) {
    const v = dustVerdict(c)
    if (v.dust) dust.push(c)
    else if (v.why !== 'empty') kept.push({ c, why: v.why })
  }
  return { dust, kept }
}

const tupleOf = (m: MorphoMarketParams) => ({
  loanToken: m.loanToken,
  collateralToken: m.collateralToken,
  oracle: m.oracle,
  irm: m.irm,
  lltv: m.lltv,
})

/** One withdraw per dust position, to the owner. Throws on a candidate that is not dust. */
export function dustCalls(owner: Address, dust: readonly DustCandidate[]): EvmCall[] {
  return dust.map((c) => {
    if (!dustVerdict(c).dust) throw new Error(`collect dust: ${c.label} is not dust`)
    return c.venue === 'morpho-blue'
      ? {
          address: c.morpho,
          abi: morphoAbi,
          functionName: 'withdraw',
          args: [tupleOf(c.params), 0n, c.shares, owner, owner],
        }
      : {
          address: c.pool,
          abi: aavePoolAbi,
          functionName: 'withdraw',
          args: [c.token, maxUint256, owner],
        }
  })
}

/** Decimals that show a dust amount: never fewer than 2, enough to show the first digit. */
export function dustShown(units: bigint, decimals: number): number {
  if (units === 0n) return 2
  const digits = units.toString().length
  return Math.min(decimals, Math.max(2, decimals - digits + 2))
}

export interface DustRow {
  label: string
  venue: DustVenue
  /** "0 USDC", "0.000041 WETH" */
  receive: string
  /** "you receive 0 USDC · this clears the position" */
  line: string
  /** Dollars returned; 0 when nothing is, null never (dust is zero or priced). */
  usd: number
  /** What the withdraw takes: "1,204,551 shares", "all of 0.000041 aWETH". */
  takes: string
}

export function dustRow(c: DustCandidate): DustRow {
  const v = dustVerdict(c)
  if (!v.dust) throw new Error(`collect dust: ${c.label} is not dust`)
  const amount = fmtUnits(c.assets, c.decimals, dustShown(c.assets, c.decimals))
  const receive = `${c.assets === 0n ? '0' : amount} ${c.symbol}`
  const usd = c.assets === 0n || c.priceUsd === null ? 0 : unitsUsd(c.assets, c.decimals, c.priceUsd)
  const line =
    c.assets === 0n
      ? `You receive 0 ${c.symbol}: the shares round to nothing. This clears the position`
      : `You receive ${receive}, ${aboutUsd(usd)}${c.assets < 10n ** BigInt(c.decimals) ? ', under 1 unit' : ''}. This clears the position`
  const takes =
    c.venue === 'morpho-blue'
      ? `${fmtUnits(c.shares, 0, 0)} supply shares`
      : `the whole balance, ${amount} ${c.symbol} as read`
  return { label: c.label, venue: c.venue, receive, line, usd, takes }
}

export type DustWarning = 'nothing' | 'gas-exceeds' | null

export interface DustTotals {
  rows: DustRow[]
  /** Dollars the sweep returns, in all. */
  receiveUsd: number
  /** Gas at today's fee, null until simulated (or when the fee read failed). */
  gasEth: number | null
  gasUsd: number | null
  warning: DustWarning
}

/**
 * The slip's figures. `ethUsd` is the ETH price read with the positions (Aave's oracle);
 * the gas is the simulation's buffered gas at its fee cap: an estimate, not a ceiling.
 */
export function dustTotals(
  dust: readonly DustCandidate[],
  sim: SimResult | null,
  ethUsd: number | null,
): DustTotals {
  const rows = dust.map(dustRow)
  const receiveUsd = rows.reduce((a, r) => a + r.usd, 0)
  const gasEth =
    sim && sim.ok && sim.maxFeePerGas !== null
      ? Number(formatEther(sim.bufferedGas * sim.maxFeePerGas))
      : null
  const gasUsd = gasEth !== null && ethUsd !== null ? gasEth * ethUsd : null
  const warning: DustWarning =
    rows.length === 0
      ? null
      : receiveUsd === 0
        ? 'nothing'
        : gasUsd !== null && gasUsd > receiveUsd
          ? 'gas-exceeds'
          : null
  return { rows, receiveUsd, gasEth, gasUsd, warning }
}

/** Dollars at dust scale: "$0.43", "under $0.01", "$0". */
export function fmtDustUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return 'under $0.01'
  return `$${usd.toFixed(2)}`
}

/**
 * An estimate in words: "about $0.43". A bound is already a bound, so it takes no
 * "about": "under $0.01", "$0".
 */
export function aboutUsd(usd: number): string {
  const f = fmtDustUsd(usd)
  return f.startsWith('$') && usd !== 0 ? `about ${f}` : f
}

/** The warning's one line, or null. */
export function dustWarningText(t: DustTotals): string | null {
  if (t.warning === 'nothing')
    return `You receive nothing. This only clears ${t.rows.length === 1 ? 'the position' : `${t.rows.length} positions`}${t.gasUsd !== null ? `, for ${aboutUsd(t.gasUsd)} of gas` : ' and costs gas'}`
  if (t.warning === 'gas-exceeds' && t.gasUsd !== null)
    return `Gas costs more than you receive: ${aboutUsd(t.gasUsd)} of gas for ${fmtDustUsd(t.receiveUsd)} back`
  return null
}

/**
 * The venue gates the sweep must pass: an Aave reserve's paused bit refuses withdraw;
 * Morpho Blue has no pause switch. Shown as the slip's checks, before the wallet's.
 */
export function dustGates(dust: readonly DustCandidate[]): Gate[] {
  const gates: Gate[] = []
  if (dust.some((c) => c.venue === 'morpho-blue'))
    gates.push({
      id: 'dust:morpho',
      ok: true,
      text: 'Morpho Blue: withdraw by shares; the market has no pause switch',
    })
  for (const c of dust) {
    if (c.venue === 'morpho-blue') continue
    gates.push({
      id: `dust:${c.venue}:${c.token.toLowerCase()}`,
      ok: !c.paused,
      text: c.paused
        ? `${c.label} reserve paused: withdraw refused`
        : `${c.label} reserve not paused`,
    })
  }
  return gates
}

/** "dust from 4 positions" */
export const dustWhat = (n: number) => `dust from ${n} position${n === 1 ? '' : 's'}`

/** The slip's prep for the state machine (lib/position-exec/sheet.ts). */
export function dustPrep(dust: readonly DustCandidate[], sim: SimResult | null): PrepState {
  const gates = dustGates(dust)
  return {
    status: 'ready',
    gates,
    sim: gates.every((g) => g.ok)
      ? sim
        ? { status: 'done', result: sim }
        : { status: 'running' }
      : { status: 'skipped' },
    verb: 'Collect',
    what: dustWhat(dust.length),
    steps: dust.length,
  }
}

// ------------------------------------------------------------------ choosing rows
// Owner, Q27 round 5: the reader can untick positions. A row that pays nothing (receives 0)
// only clears the position, so it starts OFF; a row that pays something starts ON. The
// totals and the gas follow the ticks; nothing ticked is "Nothing selected".

/**
 * Why a row starts unticked: it pays nothing ('zero'), or what it pays is worth less than
 * its own call's gas at today's fee ('gas'; owner, Q27 round 5: nobody bothers with a row
 * that costs more than it returns). Null: it starts ticked. A row whose gas is unknown
 * (no simulation, no fee, no ETH price) is judged on what it pays alone.
 */
export function offReason(
  c: DustCandidate,
  i: number,
  sim: SimResult | null,
  ethUsd: number | null,
): 'zero' | 'gas' | null {
  if (c.assets === 0n) return 'zero'
  const g = sim && sim.ok ? sim.gas[i] : null
  if (g === null || g === undefined || !sim || !sim.ok || sim.maxFeePerGas === null || ethUsd === null)
    return null
  const gasUsd = Number(formatEther(buffered(g) * sim.maxFeePerGas)) * ethUsd
  return dustRow(c).usd < gasUsd ? 'gas' : null
}

/** The opening ticks: off for a row that pays nothing or less than its gas, on otherwise. */
export const defaultPicks = (
  dust: readonly DustCandidate[],
  sim: SimResult | null = null,
  ethUsd: number | null = null,
): boolean[] => dust.map((c, i) => offReason(c, i, sim, ethUsd) === null)

/** The ticked positions, in the order read. */
export const picked = <T>(xs: readonly T[], picks: readonly boolean[]): T[] =>
  xs.filter((_, i) => picks[i] === true)

/**
 * The simulated batch cut to the ticked calls: each call's own gasUsed, summed and
 * buffered again. The withdraws are independent, so the cut batch's gas is the sum of its
 * calls'; the wallet estimates the real batch when it signs. A failed simulation, or one
 * with a call's gas unknown, is returned as it was (null when nothing is ticked).
 */
export function pickedSim(sim: SimResult | null, picks: readonly boolean[]): SimResult | null {
  if (!sim || !sim.ok) return sim
  if (!picks.some(Boolean)) return null
  const gas = picked(sim.gas, picks)
  if (gas.some((g) => g === null)) return sim
  const sum = (gas as bigint[]).reduce((a, g) => a + g, 0n)
  return { ...sim, gas, bufferedGas: buffered(sum) }
}

/** The dust slip's sheet for the ticked rows: "Nothing selected", disabled, when none are. */
export function dustSheet(
  chosen: readonly DustCandidate[],
  sim: SimResult | null,
  wallet: WalletState,
  tx: TxState,
  owner: string,
): SheetView {
  const sheet = sheetView(dustPrep(chosen, sim), wallet, tx, owner)
  if (chosen.length > 0 || tx.phase !== 'idle') return sheet
  return {
    ...sheet,
    checks: sheet.checks.filter((c) => !c.id.startsWith('sim')),
    button: { kind: 'wait', label: 'Nothing selected', enabled: false },
    notice: null,
  }
}
