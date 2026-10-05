import type { VenueExitMetrics } from '@/lib/exitQueue/metrics'
import type { ParamChange, ParamValue } from '@/lib/exitQueue/types'

/**
 * Pure formatting for the exit-queue card (components/Venue/ExitQueueCard.tsx).
 * Every duration it prints is measured history (or, for the beacon row, the chain's
 * schedule); the card's stamp carries that label, and these strings never call a
 * number an estimate or an ETA.
 */

export const CARD_WINDOW_DAYS = 30

export function fmtDuration(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—'
  if (s < 60) return s <= 0 ? '0s' : '<1m'
  if (s < 3_600) return `${Math.round(s / 60)}m`
  if (s < 2 * 86_400) return `${(s / 3_600).toFixed(1)}h`
  return `${(s / 86_400).toFixed(1)}d`
}

export function fmtAmount(units: number | null, symbol: string): string {
  if (units == null) return '—'
  if (units === 0) return `0 ${symbol}`
  const a = Math.abs(units)
  const body =
    a >= 1e9
      ? `${(units / 1e9).toFixed(2)}B`
      : a >= 1e6
        ? `${(units / 1e6).toFixed(2)}M`
        : a >= 1e3
          ? `${(units / 1e3).toFixed(1)}k`
          : units.toFixed(a >= 1 ? 1 : 3)
  return `${body} ${symbol}`
}

export type Cell = { primary: string; secondary: string }

export function queueCell(m: VenueExitMetrics): Cell {
  const q = m.queueNow
  if (!m.anchor) return { primary: '—', secondary: 'no local ledger' }
  const noun = m.venue === 'beacon-exit' ? 'validators exiting' : 'requests waiting'
  const r = q.reconciliation
  const mismatch =
    r && r.status !== 'match' ? ` · ledger holds ${r.ledgerOpen} open vs ${r.onchain} on-chain` : ''
  return {
    primary: `${q.amountIsLowerBound && q.amount != null ? '≥ ' : ''}${fmtAmount(q.amountUnits, m.unit.symbol)}`,
    secondary:
      (q.count == null ? 'count unavailable' : `${q.count.toLocaleString('en-US')} ${noun}`) +
      mismatch,
  }
}

export function waitCell(m: VenueExitMetrics, windowDays = CARD_WINDOW_DAYS): Cell {
  if (!m.anchor) return { primary: '—', secondary: '' }
  if (m.venue === 'beacon-exit') {
    const w = m.windows.find((x) => x.windowDays === windowDays)
    const p50 = w?.requestToFinalize.p50S
    return {
      primary: `${fmtDuration(m.scheduleWaitS)} to the last scheduled exit`,
      secondary:
        `+27.3h to withdrawable, then the sweep` +
        (w && w.requestToFinalize.n > 1
          ? ` · ${windowDays}d readings p50 ${fmtDuration(p50)}`
          : ''),
    }
  }
  const w = m.windows.find((x) => x.windowDays === windowDays)
  if (!w || w.coverage === 'none') return { primary: '—', secondary: 'no ledger coverage yet' }
  const d = m.venue.startsWith('erc7540:') ? w.requestToClaim : w.requestToFinalize
  const claim = w.finalizeToClaim
  const bracketed = m.ledgerHealth.bracketedFinalizations
  const scope =
    `${d.n} requests, ${d.completed} done` +
    (w.coverage === 'partial' ? ' · window not yet full' : '') +
    (bracketed ? ` · ${bracketed} completion times are upper bounds` : '')
  const claimed = claim.p50S != null ? ` · claimed after p50 ${fmtDuration(claim.p50S)}` : ''
  if (d.n === 0) return { primary: 'no requests', secondary: `in the last ${windowDays}d` }
  if (d.p50S == null)
    return {
      primary: `≥ ${fmtDuration(d.atLeastS)}`,
      secondary: `more than half still waiting · ${scope}${claimed}`,
    }
  return {
    primary: `p50 ${fmtDuration(d.p50S)} · p90 ${d.p90S != null ? fmtDuration(d.p90S) : `≥ ${fmtDuration(d.atLeastS)}`}`,
    secondary: `${scope}${claimed}`,
  }
}

const shortAddr = (v: string) =>
  /^0x[0-9a-f]{40}$/i.test(v) ? `${v.slice(0, 6)}…${v.slice(-4)}` : v

export function fmtParam(param: string, v: ParamValue): string {
  if (v == null) return '?'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (param === 'cooldownDuration') return fmtDuration(Number(v))
  if (param === 'withdrawalDelayBlocks') return `${v} blocks (~${fmtDuration(Number(v) * 12)})`
  if (param === 'instantWithdrawalFeeBps') return `${v} bp`
  return shortAddr(String(v))
}

const PARAM_LABEL: Record<string, string> = {
  cooldownDuration: 'cooldown',
  withdrawalDelayBlocks: 'withdrawal delay',
  instantWithdrawalFeeBps: 'instant-exit fee',
  bunkerMode: 'bunker mode',
  paused: 'paused',
  withdrawalManager: 'withdrawal manager',
}

export const describeChange = (c: ParamChange): string => {
  const name = PARAM_LABEL[c.param] ?? c.param.replace(/:0x[0-9a-f]{40}$/i, '')
  return `${name} ${fmtParam(c.param, c.from)} → ${fmtParam(c.param, c.to)}`
}

export function changeCell(m: VenueExitMetrics): Cell {
  const c = m.lastChange
  const since = m.ledgerHealth.coverageFromTs
  if (!c)
    return {
      primary: 'none recorded',
      secondary: since ? `watched since ${new Date(since * 1000).toISOString().slice(0, 10)}` : '',
    }
  return {
    primary: describeChange(c),
    secondary:
      c.source === 'event'
        ? `${new Date(c.ts * 1000).toISOString().slice(0, 10)} · emitted as an event`
        : `silent (no event) · found ${new Date(c.ts * 1000).toISOString().slice(0, 10)}, changed after block ${c.sinceBlock}`,
  }
}

export const cooldownNote = (m: VenueExitMetrics): string | null =>
  m.advertisedCooldownS == null
    ? null
    : `on-chain cooldown now ${fmtDuration(m.advertisedCooldownS)}`
