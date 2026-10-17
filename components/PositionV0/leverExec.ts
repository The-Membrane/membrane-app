// The lever, prepared for signing. On open the sheet re-reads the position on its venue,
// re-solves the levers on the same model and horizon (viewModel.buildPositionView), finds
// the lever the reader clicked, and reads the chain for its gates and calls
// (lib/position-exec). Every figure on the slip comes from this re-read; nothing is
// carried over from the page except which lever was clicked.
//
// Pure helpers first (tests/unit/positionExecLever.test.ts), the async prepare last.

import type { PublicClient } from 'viem'

import type { EvmCall } from '@/services/chain/types'
import { fmtUnits, leverUnits } from '@/lib/position-exec/amount'
import { leverCalls, type Address } from '@/lib/position-exec/builders'
import { amountLimit, leverGates, type AmountLimit, type Gate } from '@/lib/position-exec/gates'
import { namedRevert, revertReason } from '@/lib/position-exec/revert'
import {
  capFigures,
  readLeverChain,
  type ExecProtocol,
  type LeverChainRead,
} from '@/lib/position-exec/read'
import { fmtAmount, fmtMove, fmtUsd } from '@/lib/position/format'
import { priceDecimals, roundTowardRisk } from '@/lib/position/liquidation'
import { distanceAfter, type ActionRow } from '@/lib/position/reverseSolve'
import {
  floorPct,
  formatBand,
  formatChance,
  touchAtLevel,
  type TouchFrequency,
} from '@/lib/position/touch'
import { HORIZON_WORDS, type HorizonId, type TouchTable } from '@/lib/position/touchHistory'
import { getMainnetClient } from '@/lib/position-sim/rpc'
import type { AdapterResult, ProtocolPosition } from '@/lib/position-sim/types'

import { PROTOCOL_SHORT, buildPositionView, type PositionView } from './viewModel'

/** What a click on a lever row hands the sheet. */
export interface LeverIntent {
  owner: Address
  /** PositionView.key: `${protocol}:${marketId ?? label}`. */
  positionKey: string
  protocol: ExecProtocol
  title: string
  kind: 'repay' | 'add'
  targetPct: number
  level: number
  horizon: HorizonId
  /** The forecast is STALE: the slip withholds its chances too. */
  stale: boolean
  /** The row as clicked, shown until the re-read lands. */
  row: ActionRow
  /** Each open re-reads. */
  openedAt: number
  /**
   * The reader's own amount, typed in the slip (or a one-tap "use the room left"): the
   * slip re-reads at it instead of the solved amount. Absent: the solved amount.
   */
  amount?: { value: number; decimals: number } | null
}

/**
 * The lever as the slip shows it: the solved row, or the reader's own amount on it. An
 * amount of the reader's can land past the forecast table's last level, where there is
 * no chance to read: `history` is then null and the slip says so.
 */
export type LeverRow = Omit<ActionRow, 'history'> & { history: TouchFrequency | null }

export interface LegRef {
  symbol: string
  address: Address
  decimals: number
}

export interface PreparedLever {
  kind: 'ready'
  view: PositionView
  row: LeverRow
  /** The re-solved amount differs from the one clicked. */
  changed: boolean
  /** The amount is the reader's own (LeverIntent.amount), not the solve's. */
  custom: boolean
  /** The solved row's amount, for "the lever solved 20 USDT" beside a custom amount. */
  solved: { amount: number; amountDecimals: number }
  leg: LegRef
  amount: bigint
  read: LeverChainRead
  gates: Gate[]
  calls: EvmCall[]
  block: number | null
  /** Epoch ms of the re-read. */
  at: number
  /** Epoch ms of the re-read's block; null when the block time could not be read. */
  blockTime: number | null
  source: string
}

export type Prepared = PreparedLever | { kind: 'gone'; reason: string }

// ------------------------------------------------------------------ pure

export const positionKeyOf = (p: ProtocolPosition): string =>
  `${p.protocol}:${p.marketId ?? p.label}`

/**
 * The clicked lever in a fresh solve: the same kind and target; else the same kind and
 * level (two targets that solve to one amount keep only the first, reverseSolve dedupe).
 */
export function findFreshRow(
  rows: readonly ActionRow[],
  intent: Pick<LeverIntent, 'kind' | 'targetPct' | 'level'>,
): ActionRow | null {
  return (
    rows.find((r) => r.kind === intent.kind && r.targetPct === intent.targetPct) ??
    rows.find((r) => r.kind === intent.kind && r.level === intent.level) ??
    null
  )
}

/**
 * The leg a row moves, by symbol: a repay pays a debt leg, a top-up adds to a collateral
 * leg. The row carries only the symbol, so two legs with one symbol cannot be told apart
 * and are refused.
 */
export function legFor(p: ProtocolPosition, row: Pick<ActionRow, 'kind' | 'symbol'>): LegRef {
  const legs = row.kind === 'repay' ? p.debt : p.collateral
  const hits = legs.filter((l) => l.symbol === row.symbol && l.amount > 0)
  if (hits.length !== 1) {
    throw new Error(
      `${hits.length === 0 ? 'no' : 'more than one'} ${row.kind === 'repay' ? 'debt' : 'collateral'} leg named ${row.symbol}`,
    )
  }
  const l = hits[0]
  if (!/^0x[0-9a-fA-F]{40}$/.test(l.address))
    throw new Error(`the ${row.symbol} leg has no token address`)
  return { symbol: l.symbol, address: l.address as Address, decimals: l.decimals }
}

/** Why a fresh solve has no row for the lever. */
export function goneReason(
  view: PositionView,
  intent: Pick<LeverIntent, 'kind' | 'horizon'>,
): string {
  const what = intent.kind === 'repay' ? 'repay' : 'top-up'
  if (view.hero.kind === 'no-debt') return 'This position has no debt now.'
  if (!view.forecast) return view.forecastAbsent ?? 'No forecast for this position now.'
  const s = view.forecast.byHorizon[intent.horizon].solve
  if (s.reason === 'met' || (s.met.length > 0 && s.reason !== 'ok'))
    return `Already at this lever's target within ${HORIZON_WORDS[intent.horizon]}.`
  return `No ${what} reaches this lever's line now.`
}

export interface SlipRow {
  label: string
  before: string | null
  after: string
}

/**
 * The slip's brought forward → carried forward lines, from the page's own computations:
 * the hero's line price and distance, the forecast at the reader's line, and the row's Y
 * with its forecast. The new price is the row's floored distance from now, rounded toward
 * risk the way the hero rounds, so "line −22%" and its price say the same thing.
 */
export function slipRows(
  view: PositionView,
  row: LeverRow,
  horizon: HorizonId,
  stale: boolean,
): SlipRow[] {
  const hero = view.hero
  const out: SlipRow[] = []
  if (!Number.isFinite(row.newDistancePct)) {
    out.push({ label: 'Distance from now', before: null, after: 'no line: no debt left' })
    return out
  }
  if (hero.kind === 'line' && hero.unit.kind === 'usd') {
    const y = row.newDistancePct / 100
    const raw = hero.direction === 'fall' ? hero.priceNow * (1 - y) : hero.priceNow * (1 + y)
    const d = priceDecimals(raw)
    out.push({
      label: `${hero.symbol} liquidation price`,
      before: fmtUsd(hero.priceShown, hero.decimals),
      after: fmtUsd(roundTowardRisk(raw, hero.direction, d), d),
    })
    out.push({
      label: 'Distance from now',
      before: fmtMove(hero.distancePct, hero.direction),
      after: fmtMove(row.newDistancePct, row.direction),
    })
  } else {
    out.push({
      label: 'Distance from now',
      before: null,
      after: fmtMove(row.newDistancePct, row.direction),
    })
  }
  if (!stale && view.forecast) {
    const chance = (h: TouchFrequency) =>
      `${formatChance(h.touched, h.n)} (${formatBand(h.lo, h.hi, h.n)})`
    const at = view.forecast.byHorizon[horizon].at
    out.push({
      label: `Chance ${view.forecast.asset} touches it, ${HORIZON_WORDS[horizon]}†`,
      before: at ? chance(at) : null,
      after: row.history ? chance(row.history) : 'past the table: no forecast here',
    })
  }
  return out
}

export interface StepLine {
  title: string
  /** What the wallet should show: the contract, the function and the exact units. */
  detail: string
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Each call of the batch in words, read back from the call itself (not from the plan). */
export function stepsOf(
  calls: readonly EvmCall[],
  o: { protocol: ExecProtocol; kind: 'repay' | 'add'; symbol: string; shown: string },
): StepLine[] {
  const venue = PROTOCOL_SHORT[o.protocol]
  const spenderName =
    o.protocol === 'compound-v3'
      ? 'Comet'
      : o.protocol === 'morpho-blue'
        ? 'Morpho Blue'
        : `${venue} Pool`
  return calls.map((c) => {
    const args = c.args ?? []
    if (c.functionName === 'approve') {
      const [spender, units] = args as readonly [Address, bigint]
      return units === 0n
        ? {
            title: `Reset the ${o.symbol} allowance to 0`,
            detail: `${o.symbol} ${short(c.address)} · approve ${spenderName} ${short(spender)} · 0 · a smaller allowance is standing`,
          }
        : {
            title: `Approve exactly ${o.shown} ${o.symbol}`,
            detail: `${o.symbol} ${short(c.address)} · approve ${spenderName} ${short(spender)} · ${units}`,
          }
    }
    if (c.functionName === 'repay') {
      // Aave repay(asset, amount, 2, onBehalfOf); Morpho repay(params, assets, 0, onBehalf, 0x).
      const units = args[1] as bigint
      const onBehalf = args[3] as Address
      return {
        title: `Repay ${o.shown} ${o.symbol}${o.protocol === 'morpho-blue' ? '' : ', variable rate'}`,
        detail: `${spenderName} ${short(c.address)} · repay · ${units} · for ${short(onBehalf)}`,
      }
    }
    if (c.functionName === 'supplyCollateral') {
      return {
        title: `Add ${o.shown} ${o.symbol} as collateral`,
        detail: `${spenderName} ${short(c.address)} · supplyCollateral · ${args[1] as bigint} · for ${short(args[2] as Address)}`,
      }
    }
    // supply: Aave (asset, amount, onBehalfOf, 0) or Comet (asset, amount).
    const units = args[1] as bigint
    if (o.protocol === 'compound-v3') {
      // Comet credits msg.sender: a base supply repays the borrow first.
      return {
        title:
          o.kind === 'repay'
            ? `Repay ${o.shown} ${o.symbol}`
            : `Add ${o.shown} ${o.symbol} as collateral`,
        detail: `${spenderName} ${short(c.address)} · supply · ${units} · to the signer's account`,
      }
    }
    return {
      title: `Add ${o.shown} ${o.symbol} as collateral`,
      detail: `${spenderName} ${short(c.address)} · supply · ${units} · for ${short(args[2] as Address)}`,
    }
  })
}

/** Two notice sentences, the second optional. */
export const joinNotice = (a: string, b: string | null): string => (b ? `${a}. ${b}` : a)

/**
 * The disclosure for an approval a partial run left standing (lib/position-exec/run.ts
 * standingApproval): what it lets the venue take, and the two ways out.
 */
export function standingNotice(
  units: bigint | null,
  symbol: string,
  decimals: number,
  venue: string,
  kind: 'repay' | 'add',
): string | null {
  if (units === null) return null
  const x = `${fmtUnits(units, decimals, 2)} ${symbol}`
  return `The approval for ${x} to ${venue} is still standing. It lets ${venue} take up to ${x}. Revoke it in your wallet, or sign the ${kind === 'repay' ? 'repay' : 'top-up'} again`
}

/** A mined revert's reason, best effort: the same call replayed now, named; null if it passes. */
export async function replayReason(
  call: EvmCall,
  owner: Address,
  venue: 'aave' | 'compound' | 'morpho',
  client: PublicClient = getMainnetClient(),
): Promise<string | null> {
  try {
    await client.simulateContract({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args ?? [],
      account: owner,
    } as Parameters<PublicClient['simulateContract']>[0])
    return null
  } catch (err) {
    return namedRevert(revertReason(err), venue)
  }
}

/** The borrow APR the solve's accrual buffer used (viewModel.buildPositionView). */
function bufferApr(p: ProtocolPosition): number | null {
  const aprs = p.debt.map((d) => d.borrowApr).filter((x): x is number => x !== null)
  return aprs.length === p.debt.length && aprs.length > 0 ? Math.max(...aprs) : null
}

/**
 * The solved row moved to the reader's own amount: the same leg, the same accrual buffer
 * and model (reverseSolve.distanceAfter), the forecast read at the new floored distance.
 * Throws when the position has no leg for the row's kind.
 */
export function rowAt(
  view: PositionView,
  base: LeverRow,
  amount: number,
  amountDecimals: number,
  table: TouchTable,
): LeverRow {
  if (!view.model) throw new Error('no line model for this position')
  const d = distanceAfter(view.mapped.snapshot, view.model, base.kind, amount, bufferApr(view.position))
  if (d === null) throw new Error(`no ${base.kind === 'repay' ? 'debt' : 'collateral'} leg moves this line`)
  const Y = Number.isFinite(d) ? floorPct(d) : Number.POSITIVE_INFINITY
  const history =
    view.forecast && Number.isFinite(Y)
      ? touchAtLevel(table, view.forecast.asset, view.forecast.direction, base.horizon, Y)
      : null
  const unitUsd = base.amount > 0 ? base.amountUsd / base.amount : 0
  const what = `If you ${base.kind} ${fmtAmount(amount, amountDecimals)} ${base.symbol}`
  const line = Number.isFinite(Y) ? `line ${fmtMove(Y, base.direction)}` : 'no line'
  return {
    ...base,
    amount,
    amountDecimals,
    amountUsd: amount * unitUsd,
    newDistancePct: Y,
    history,
    action: what,
    line,
    text: history
      ? `${what} · ${line} · ${formatChance(history.touched, history.n)} (${formatBand(history.lo, history.hi, history.n)})`
      : `${what} · ${line}`,
    short: history ? `${what} → ${formatChance(history.touched, history.n)}` : what,
  }
}

/** The gates for a lever at `amount` on one read (the venue's name in the paused text). */
export function gatesFor(
  intent: Pick<LeverIntent, 'protocol'>,
  row: LeverRow,
  leg: LegRef,
  amount: bigint,
  read: LeverChainRead,
): Gate[] {
  return leverGates({
    kind: row.kind,
    symbol: leg.symbol,
    token: leg.address,
    legDecimals: leg.decimals,
    amount,
    shown: Math.max(2, row.amountDecimals),
    read,
    venueName: PROTOCOL_SHORT[intent.protocol],
  })
}

/**
 * The same read at another amount, without reading again (the design harness; an Aave or
 * Compound read only: a Morpho repay's share count depends on the amount and needs a read).
 */
export function withAmount(
  p: PreparedLever,
  intent: Pick<LeverIntent, 'protocol'>,
  amount: number,
  amountDecimals: number,
  table: TouchTable,
): PreparedLever {
  if (p.read.venue.venue === 'morpho') throw new Error('a Morpho amount needs a fresh read')
  const row = rowAt(p.view, p.row, amount, amountDecimals, table)
  const units = leverUnits(amount, amountDecimals, p.leg.decimals)
  const read: LeverChainRead = { ...p.read, action: { ...p.read.action, amount: units } }
  return {
    ...p,
    row,
    custom: true,
    amount: units,
    read,
    gates: gatesFor(intent, row, p.leg, units, read),
    calls: leverCalls(read.action, read.allowance),
  }
}

/** The slip's amount ceiling on this read (gates.ts amountLimit). */
export const limitOf = (p: PreparedLever): AmountLimit =>
  amountLimit(p.read, p.row.kind, p.leg.symbol, Math.max(2, p.row.amountDecimals))

/**
 * The one-tap offer beside a cap that blocks a supply (owner, Q27 round 5): the room left,
 * cut DOWN to the row's display decimals so it fits. Null when the cap does not block, or
 * when the room is nothing at those decimals.
 */
export function capSuggestion(
  p: PreparedLever,
): { amount: number; amountDecimals: number; text: string } | null {
  const cap = p.gates.find((g) => g.id === 'cap')
  if (!cap || cap.ok) return null
  const c = capFigures(p.read.venue)
  if (!c || c.room <= 0n) return null
  const shown = Math.min(Math.max(2, p.row.amountDecimals), p.read.decimals)
  const text = fmtUnits(c.room, p.read.decimals, shown).replace(/,/g, '')
  const amount = Number(text)
  if (!(amount > 0)) return null
  const trimmed = text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
  const decimals = trimmed.split('.')[1]?.length ?? 0
  return {
    amount,
    amountDecimals: decimals,
    text: `Use ${fmtAmount(amount, decimals)} (the room left)`,
  }
}

/**
 * THE SETTLED TOAST (owner, Q27 round 5: the slip closes on settlement). "Repaid 760 USDT ·
 * new line $1,883": the verb in the past, the amount sent, and the liquidation price the
 * slip carried forward (its own computation at the read, the page reads it again next).
 */
export interface SettledToastData {
  text: string
  hash: `0x${string}`
}

export function settledToast(p: PreparedLever, horizon: HorizonId, hash: `0x${string}`): SettledToastData {
  const verb = p.row.kind === 'repay' ? 'Repaid' : 'Added'
  const what = `${fmtAmount(p.row.amount, p.row.amountDecimals)} ${p.leg.symbol}`
  const price = slipRows(p.view, p.row, horizon, true).find((r) => r.label.endsWith('liquidation price'))
  return { text: `${verb} ${what}${price ? ` · new line ${price.after}` : ''}`, hash }
}

// ------------------------------------------------------------------ prepare

export interface PrepareDeps {
  readAdapter: (protocol: ExecProtocol, owner: Address) => Promise<AdapterResult>
  client: PublicClient
  table: TouchTable
}

/** The re-read, the re-solve and the chain read for one lever. Throws, named, on a failed read. */
export async function prepareLever(intent: LeverIntent, deps: PrepareDeps): Promise<Prepared> {
  const venue = PROTOCOL_SHORT[intent.protocol]
  const result = await deps.readAdapter(intent.protocol, intent.owner)
  if (result.status === 'error' || result.status === 'unsupported') {
    throw new Error(`${venue} re-read failed: ${result.message ?? 'no message'}`)
  }
  const p = result.positions.find((x) => positionKeyOf(x) === intent.positionKey)
  if (!p) return { kind: 'gone', reason: `This position is no longer open on ${venue}.` }

  const view = buildPositionView(p, deps.table)
  const rows = view.forecast?.byHorizon[intent.horizon].actions ?? []
  const solved = findFreshRow(rows, intent)
  if (!solved) return { kind: 'gone', reason: goneReason(view, intent) }
  const custom = intent.amount ?? null
  const row: LeverRow = custom
    ? rowAt(view, solved, custom.value, custom.decimals, deps.table)
    : solved

  const leg = legFor(p, row)
  const amount = leverUnits(row.amount, row.amountDecimals, leg.decimals)
  const block = p.provenance.block ?? null
  const read = await readLeverChain(deps.client, {
    protocol: intent.protocol,
    kind: row.kind,
    owner: intent.owner,
    token: leg.address,
    amount,
    marketId: p.marketId,
    block: block === null ? null : BigInt(block),
  })
  const gates = gatesFor(intent, row, leg, amount, read)
  let blockTime: number | null = null
  try {
    if (block !== null)
      blockTime =
        Number((await deps.client.getBlock({ blockNumber: BigInt(block) })).timestamp) * 1000
  } catch {
    blockTime = null // the age check falls back to when the read resolved
  }
  return {
    kind: 'ready',
    blockTime,
    view,
    row,
    changed: !custom && (row.amount !== intent.row.amount || row.symbol !== intent.row.symbol),
    custom: custom !== null,
    solved: { amount: solved.amount, amountDecimals: solved.amountDecimals },
    leg,
    amount,
    read,
    gates,
    calls: leverCalls(read.action, read.allowance),
    block,
    at: p.provenance.at,
    source: p.provenance.label,
  }
}
