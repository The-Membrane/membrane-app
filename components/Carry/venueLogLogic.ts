// Pure logic for the venue state-change log — kept JSX-free so the unit suite
// (tests/unit, node environment) exercises it directly.

export type Entry = {
  venue: string
  kind: string
  at: string
  prev: Record<string, unknown> | null
  next: Record<string, unknown> | null
  provenance: 'observed' | 'reconstructed'
}

export const fmtDuration = (secs: number): string => {
  if (secs % 86400 === 0) return `${secs / 86400}d`
  if (secs % 3600 === 0) return `${secs / 3600}h`
  return `${secs}s`
}

const fmtUsd = (n: number): string =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}k`

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
