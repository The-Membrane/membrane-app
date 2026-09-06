// Pure logic for the venue state-change log — kept JSX-free so the unit suite
// (tests/unit, node environment) exercises it directly.

export type Entry = {
  venue: string
  kind: string
  at: string
  prev: Record<string, unknown> | null
  next: Record<string, unknown> | null
  provenance: 'observed' | 'reconstructed' | 'alarm'
  severity?: 'watch' | 'alarm'
  evidence?: Record<string, unknown> | null
  cleared?: boolean
}

// The memo signals the alarm system is BLIND to (mirror of
// scripts/lib/alarmRules.mjs UNCOVERED_SIGNALS — keep in lockstep). Rendered as
// a footer so a quiet log never reads as all-clear.
export const UNCOVERED_FOOTER =
  'this alarm cannot yet see: depth-vs-book, yield flatness, terms changes'

export const fmtDuration = (secs: number): string => {
  if (secs % 86400 === 0) return `${secs / 86400}d`
  if (secs % 3600 === 0) return `${secs / 3600}h`
  return `${secs}s`
}

const fmtUsd = (n: number): string =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}k`

/**
 * Render a fired alarm as a consequence line from its evidence numbers. Every
 * alarm row is danger-toned (open) or muted (cleared). Mirrors the genres in
 * scripts/lib/alarmRules.mjs.
 */
export const alarmConsequence = (e: Entry): { text: string; tone: 'danger' | 'muted' } => {
  const tone = e.cleared ? 'muted' : 'danger'
  const ev = e.evidence ?? {}
  const sev = (e.severity ?? 'alarm').toUpperCase()
  const pre = e.cleared ? 'CLEARED · ' : `${sev} · `
  let body: string
  switch (e.kind) {
    case 'gate_change': {
      const latest = (ev.latest ?? {}) as Record<string, unknown>
      body = `the gate moved — ${latest.kind ?? 'event'} in the last 24h (${ev.count ?? 1} total); every exit plan against this venue just changed`
      break
    }
    case 'drawdown_fast': {
      const drop = Number(ev.dropPct)
      body = `capacity fell ${Number.isFinite(drop) ? drop.toFixed(0) : '?'}% — ${fmtUsd(Number(ev.fromValue))} → ${fmtUsd(Number(ev.toValue))} in ≤7d (${ev.metric})`
      break
    }
    case 'net_outflow_streak': {
      const pct = Number(ev.pctOfTvl)
      body = `net outflow ${ev.streakDays}d straight — ${fmtUsd(Number(ev.cumulativeOutflowUsd))} out = ${Number.isFinite(pct) ? pct.toFixed(0) : '?'}% of TVL; the book is bleeding`
      break
    }
    case 'headroom_thin': {
      const ratio = Number(ev.ratio)
      body = `instant exit ${fmtUsd(Number(ev.instantUsd))} vs worst day out ${fmtUsd(Number(ev.worstDayOutflowUsd))} = ${Number.isFinite(ratio) ? ratio.toFixed(1) : '?'}× — one bad day from gating`
      break
    }
    default:
      body = `${e.kind}: ${JSON.stringify(ev)}`
  }
  return { text: `${pre}${body}`, tone }
}

/** One entry → one rendered consequence line. Unknown kinds fall back to raw. */
export const consequence = (e: Entry): { text: string; tone: 'warning' | 'normal' } => {
  if (e.kind === 'cooldown_duration_changed') {
    const a = Number(e.prev?.cooldownDuration)
    const b = Number(e.next?.cooldownDuration)
    const shorter = b < a
    return {
      text: `cooldown ${fmtDuration(a)} → ${fmtDuration(b)} — the cooling window ${shorter ? 'shortened' : 'LENGTHENED'}; every exit plan against this venue just changed`,
      tone: 'warning',
    }
  }
  if (e.kind === 'instant_liquidity_shift') {
    const a = Number(e.prev?.instant_usd)
    const b = Number(e.next?.instant_usd)
    const pct = ((b - a) / Math.abs(a)) * 100
    return {
      text: `instant exit ${fmtUsd(a)} → ${fmtUsd(b)} (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)`,
      tone: pct < 0 ? 'warning' : 'normal',
    }
  }
  return { text: `${e.kind}: ${JSON.stringify(e.prev)} → ${JSON.stringify(e.next)}`, tone: 'normal' }
}
