// Pure logic for the venue state-change log — kept JSX-free so the unit suite
// (tests/unit, node environment) exercises it directly.

export type Entry = {
  venue: string
  kind: string
  at: string
  prev: Record<string, unknown> | null
  next: Record<string, unknown> | null
  /** Start of the window the change was measured over (previous observed snapshot). */
  since?: string | null
  provenance: 'observed' | 'reconstructed' | 'alarm'
  severity?: 'watch' | 'alarm'
  evidence?: Record<string, unknown> | null
  cleared?: boolean
}

// The blind-spot footer is NOT kept here: /api/venues/log serves it per venue from
// scripts/lib/alarmRules.mjs coverageFor (the one source), so it cannot drift.

/** "over 1h" / "over 6d" / "over 3w" — the window between two observed snapshots. */
export const windowLabel = (e: Entry): string => {
  if (!e.since) return ''
  const secs = Math.round((Date.parse(e.at) - Date.parse(e.since)) / 1000)
  if (!Number.isFinite(secs) || secs <= 0) return ''
  if (secs < 3600) return ` over ${Math.max(1, Math.round(secs / 60))}m`
  if (secs < 86400) return ` over ${Math.round(secs / 3600)}h`
  if (secs < 14 * 86400) return ` over ${Math.round(secs / 86400)}d`
  return ` over ${Math.round(secs / (7 * 86400))}w`
}

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
      // evidence.source (checker, 2026-09-26): which capacity was judged —
      // 'depth_curve' = swap-out capacity within evidence.costCapPct cost incl.
      // fees (on-chain quotes); 'depth_usd_raw' (legacy 'depth_usd') = the raw
      // swap-into reserve, a fallback that is NOT executable at par.
      const cap = Number(ev.costCapPct)
      const capacity =
        ev.source === 'depth_curve'
          ? `swap-out capacity within ${Number.isFinite(cap) ? cap : '?'}% cost`
          : ev.source === 'depth_usd_raw' || ev.source === 'depth_usd'
            ? 'raw swap-out reserve (no cost bound)'
            : 'instant exit'
      const window = Number.isFinite(Number(ev.windowDays)) ? ` in ${ev.windowDays} d` : ''
      const head = `${capacity} ${fmtUsd(Number(ev.instantUsd))} vs worst day out${window} ${fmtUsd(Number(ev.worstDayOutflowUsd))} = ${Number.isFinite(ratio) ? ratio.toFixed(1) : '?'}×`
      // Owner ruling 2026-09-26: the vault's own redemption is capacity too. A
      // delayed redemption is stated with its cooldown and the total cover.
      const delay = Number(ev.redemptionDelaySec)
      const totalRatio = Number(ev.totalRatio)
      body =
        Number.isFinite(Number(ev.redemptionUsd)) && delay > 0
          ? `${head}; the vault's own redemption adds ${fmtUsd(Number(ev.redemptionUsd))} after a ${fmtDuration(delay)} cooldown (${Number.isFinite(totalRatio) ? totalRatio.toFixed(1) : '?'}× in total) — exits past the fast leg wait for the cooldown`
          : `${head} — one bad day from gating`
      break
    }
    case 'depth_collapse': {
      // evidence.dropPct is stored NEGATIVE (-fallFrac*100) by evalDepthCollapse.
      const drop = Math.abs(Number(ev.dropPct))
      const from = typeof ev.fromDate === 'string' ? ev.fromDate.slice(0, 10) : null
      const to = typeof ev.toDate === 'string' ? ev.toDate.slice(0, 10) : null
      const window = from && to ? ` from ${from} to ${to}` : ' in ≤7d'
      body = `instant swap-out depth fell ${Number.isFinite(drop) ? drop.toFixed(0) : '?'}% — ${fmtUsd(Number(ev.fromValue))} → ${fmtUsd(Number(ev.toValue))}${window}; the fast exit is thinning`
      break
    }
    case 'depth_skew': {
      const skew = Number(ev.skewPct)
      body = `the instant-exit pool is ${Number.isFinite(skew) ? skew.toFixed(0) : '?'}% one-sided — the side you swap into is running out`
      break
    }
    case 'utilization': {
      const u = Number(ev.utilizationPct)
      body = `utilization ${Number.isFinite(u) ? u.toFixed(1) : '?'}% — lent out; lenders may not be able to exit`
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
      text: `cooldown ${fmtDuration(a)} → ${fmtDuration(b)} — the cooldown window ${shorter ? 'shortened' : 'LENGTHENED'}; every exit plan against this venue just changed`,
      tone: 'warning',
    }
  }
  if (e.kind === 'instant_liquidity_shift') {
    const a = Number(e.prev?.instant_usd)
    const b = Number(e.next?.instant_usd)
    const pct = ((b - a) / Math.abs(a)) * 100
    return {
      text: `instant exit ${fmtUsd(a)} → ${fmtUsd(b)} (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)${windowLabel(e)}`,
      tone: pct < 0 ? 'warning' : 'normal',
    }
  }
  if (e.kind === 'terms_page_changed') {
    // The watcher hashes the venue's terms page; a new hash is a changed page. The
    // hash itself is not information — the fact of the edit is.
    const a = Number(e.prev?.content_len)
    const b = Number(e.next?.content_len)
    const delta = Number.isFinite(a) && Number.isFinite(b) && b !== a ? ` (${b > a ? '+' : ''}${b - a} chars)` : ''
    return { text: `terms page edited${delta} — read it before you rely on it`, tone: 'warning' }
  }
  if (e.kind === 'param_changed') {
    // One line per changed key, values formatted by name: *_usd → $, *Duration → time.
    const keys = Array.from(new Set([...Object.keys(e.prev ?? {}), ...Object.keys(e.next ?? {})]))
    const fmt = (k: string, v: unknown) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v ?? '—')
      if (/usd$/i.test(k)) return fmtUsd(n)
      if (/duration|seconds|cooldown/i.test(k)) return fmtDuration(n)
      return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    }
    // Recorder column names → what the reader is actually looking at.
    const LABEL: Record<string, string> = {
      depth_usd: 'instant swap-out depth',
      instant_usd: 'instant exit',
      cooldownDuration: 'cooldown',
      supply_cap_usd: 'supply cap',
      utilization: 'utilization',
    }
    const parts = keys
      .filter((k) => String(e.prev?.[k]) !== String(e.next?.[k]))
      .map((k) => `${LABEL[k] ?? k.replace(/_/g, ' ')} ${fmt(k, e.prev?.[k])} → ${fmt(k, e.next?.[k])}`)
    const down = keys.some((k) => Number(e.next?.[k]) < Number(e.prev?.[k]))
    return { text: `${parts.join(' · ') || 'parameter changed'}${windowLabel(e)}`, tone: down ? 'warning' : 'normal' }
  }
  // Unknown kind: name it, never dump it.
  return { text: `${e.kind.replace(/_/g, ' ')} recorded`, tone: 'normal' }
}
