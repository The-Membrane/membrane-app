// Carry Radar — POST-EVENT RECAP composition. Pure + JSX-free so the unit suite
// (tests/unit, node environment) exercises it directly, mirroring radarLogic.ts
// and venueLogLogic.ts.
//
// HONESTY RULES (owner, docs/BRAND_CHARTS.md §4) — the recap tells the STORY of
// what happened, but every clause is built from a real chain log or a recorded
// corpus row handed in by the caller:
//  - Never invent a beat. Each beat maps 1:1 to an on-chain event (their own
//    Deposit/Withdraw log) or a recorded venue state change.
//  - A cooldown exit's "landed ~{date}" is ARITHMETIC (log block-time + the
//    recorded cooldownDuration at that block), never an observed claim — the
//    on-chain unstake() claim emits no vault event, so we never assert we saw it.
//  - Missing context is OMITTED, not defaulted. No corpus rows for a venue ⇒ no
//    rank clause, not a fabricated "1st".

import { fmtUsd, fmtDuration } from './radarLogic'
import { alarmConsequence, consequence, type Entry as VenueLogEntry } from '@/components/Carry/venueLogLogic'

// 'alarm' joined the venue-log union when the failure-pattern alarm shipped —
// an alarm open during a hold is legitimate recap material.
export type Provenance = 'observed' | 'reconstructed' | 'chain-read' | 'recorded' | 'alarm'
export type BeatKind = 'entered' | 'exit_initiated' | 'exit_landed' | 'venue_param_changed' | 'context'

export type Beat = {
  /** ISO instant this beat happened (or, for a cooldown landing, is projected). */
  at: string
  /** Config venue name, or '' for a cross-venue / portfolio beat. */
  venue: string
  kind: BeatKind
  text: string
  provenance: Provenance
}

export type FlowDirection = 'deposit' | 'withdraw'

/** One of THEIR on-chain flows, already joined to its recorded corpus context. */
export type AddressFlow = {
  venue: string
  label: string
  direction: FlowDirection
  /** Block time of the log, ISO. */
  at: string
  /** Underlying moved, in USD ($1/stable). */
  usd: number
  txHash: string
  /** cooldownDuration (sec) at the event's block — nearest snapshot ≤ block time. >0 ⇒ gated exit. */
  cooldownSecondsAtEvent: number | null
  /** That calendar day's total venue outflow (USD), from venue_flows. null = no corpus. */
  dayOutflowUsd: number | null
  /** 1 = the venue's biggest recorded outflow day; null = not rankable. */
  dayRank: number | null
  /** Number of distinct outflow days in the corpus for this venue. */
  dayRankTotal: number | null
}

export type RecapInputs = {
  address: string
  /** ISO watch-creation instant, or null when the address is not tracked. */
  watchedSinceISO: string | null
  /** Human window label used when unwatched, e.g. '180d'. */
  lookbackLabel: string
  /** Total USD across positions snapshotted at watch time; null when unwatched. */
  entryTotalUsd: number | null
  /** Total USD across positions read live now. */
  currentTotalUsd: number
  /** Their deposits/withdrawals over the window, with corpus context. */
  flows: AddressFlow[]
  /** Venue state changes during the hold window (observed + reconstructed). */
  venueEvents: VenueLogEntry[]
}

// English ordinal: 1 → "biggest", 2 → "2nd-biggest", 3 → "3rd-biggest", …
export function rankPhrase(rank: number): string {
  if (rank <= 1) return 'biggest'
  const mod100 = rank % 100
  const mod10 = rank % 10
  let suffix = 'th'
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suffix = 'st'
    else if (mod10 === 2) suffix = 'nd'
    else if (mod10 === 3) suffix = 'rd'
  }
  return `${rank}${suffix}-biggest`
}

const day = (iso: string): string => iso.slice(0, 10)

/** The corpus-context clause appended to an exit beat (day rank + day outflow). */
function exitContextClause(f: AddressFlow): string {
  if (f.dayRank == null || f.dayOutflowUsd == null) return ''
  const rankTail = f.dayRankTotal != null ? ` of ${f.dayRankTotal} recorded exit days` : ''
  return ` — that day was ${f.label}'s ${rankPhrase(f.dayRank)} exit day${rankTail} in our corpus (${fmtUsd(f.dayOutflowUsd)} left the venue)`
}

/** One of their flows → its recap beat(s). Cooldown exits state the gate + landing. */
export function flowToBeats(f: AddressFlow): Beat[] {
  const you = fmtUsd(f.usd)

  if (f.direction === 'deposit') {
    return [
      {
        at: f.at,
        venue: f.venue,
        kind: 'entered',
        text: `entered ${you} into ${f.label}`,
        provenance: 'observed',
      },
    ]
  }

  // Withdraw. A recorded cooldown gate (>0) means the exit was INITIATED here and
  // lands later; no gate means it landed instantly.
  const gated = f.cooldownSecondsAtEvent != null && f.cooldownSecondsAtEvent > 0
  if (gated) {
    const secs = f.cooldownSecondsAtEvent as number
    const landedISO = new Date(new Date(f.at).getTime() + secs * 1000).toISOString()
    return [
      {
        at: f.at,
        venue: f.venue,
        kind: 'exit_initiated',
        text: `exit initiated on ${f.label} — ${you} gated ${fmtDuration(secs)}; landed ~${day(landedISO)}${exitContextClause(f)}`,
        provenance: 'observed',
      },
    ]
  }

  return [
    {
      at: f.at,
      venue: f.venue,
      kind: 'exit_landed',
      text: `exited ${you} from ${f.label} — instant, no cooldown gate${exitContextClause(f)}`,
      provenance: 'observed',
    },
  ]
}

/** A hold-window venue state change → a beat, reusing the venue-log consequence copy. */
export function venueEventToBeat(e: VenueLogEntry): Beat {
  const isAlarm = e.provenance === 'alarm'
  const c = isAlarm ? alarmConsequence(e) : consequence(e)
  const paramish = e.kind === 'cooldown_duration_changed' || e.kind === 'instant_liquidity_shift'
  return {
    at: e.at,
    venue: e.venue,
    kind: isAlarm ? 'context' : paramish ? 'venue_param_changed' : 'context',
    text: isAlarm
      ? `${e.venue}: failure-pattern flag during your hold — ${c.text}`
      : `${e.venue}: ${c.text}`,
    provenance: e.provenance,
  }
}

/** The portfolio-delta summary line: entered $X → now $Y (when tracked). */
export function deltaSummary(inp: RecapInputs): string {
  const now = fmtUsd(inp.currentTotalUsd)
  if (inp.watchedSinceISO == null || inp.entryTotalUsd == null) {
    return `Recap over the trailing ${inp.lookbackLabel} — address not yet tracked, so there is no entry baseline; now holding ${now}.`
  }
  const entered = fmtUsd(inp.entryTotalUsd)
  const delta = inp.currentTotalUsd - inp.entryTotalUsd
  const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
  const move = delta === 0 ? '' : ` (${dir} ${fmtUsd(Math.abs(delta))})`
  return `Tracked since ${day(inp.watchedSinceISO)}: entered ${entered} → now ${now}${move}.`
}

/**
 * Compose the full recap: their flows, hold-window venue changes, and the
 * portfolio-delta context beat, sorted newest-first. Returns beats + a summary.
 */
export function composeRecap(inp: RecapInputs): { beats: Beat[]; summary: string } {
  const beats: Beat[] = []

  for (const f of inp.flows) beats.push(...flowToBeats(f))
  for (const e of inp.venueEvents) beats.push(venueEventToBeat(e))

  // Portfolio-delta context beat — anchored at the watch instant when tracked.
  if (inp.watchedSinceISO != null && inp.entryTotalUsd != null) {
    const delta = inp.currentTotalUsd - inp.entryTotalUsd
    const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
    const move = delta === 0 ? 'flat' : `${dir} ${fmtUsd(Math.abs(delta))}`
    beats.push({
      at: inp.watchedSinceISO,
      venue: '',
      kind: 'context',
      text: `started tracking here — entered ${fmtUsd(inp.entryTotalUsd)} → now ${fmtUsd(inp.currentTotalUsd)} (${move})`,
      provenance: 'chain-read',
    })
  }

  // Newest first; stable for equal instants.
  beats.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  return { beats, summary: deltaSummary(inp) }
}
