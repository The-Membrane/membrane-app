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
  severity?: 'watch' | 'alarm' | 'notice' | 'info'
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

/** Only a measured, windowed capacity delta belongs in the landing's capacity card. */
export const capacityMove = (
  e: Entry,
): {
  venue: string
  metric: string
  change: string
  from: string
  to: string
  window: string
  at: string
} | null => {
  if (e.provenance !== 'observed' || !e.since) return null
  const field =
    e.kind === 'instant_liquidity_shift'
      ? 'instant_usd'
      : e.kind === 'param_changed' && 'depth_usd' in (e.next ?? {})
        ? 'depth_usd'
        : e.kind === 'param_changed' && 'instant_usd' in (e.next ?? {})
          ? 'instant_usd'
          : null
  if (!field) return null
  const before = Number(e.prev?.[field])
  const after = Number(e.next?.[field])
  const window = windowLabel(e).trim()
  if (
    !Number.isFinite(before) ||
    !Number.isFinite(after) ||
    before < 0 ||
    after < 0 ||
    before === after ||
    !window
  )
    return null
  return {
    venue: e.venue === 'aave-v3-usde' ? 'Aave USDe' : e.venue,
    metric: field === 'depth_usd' ? 'instant swap-out depth' : 'instant exit capacity',
    change: `${after > before ? 'rose' : 'fell'} ${fmtUsd(Math.abs(after - before))}`,
    from: fmtUsd(before),
    to: fmtUsd(after),
    window,
    at: e.at,
  }
}

const gateEvents = (e: Pick<Entry, 'evidence'>): Array<Record<string, unknown>> => {
  const evidence = e.evidence ?? {}
  const events = Array.isArray(evidence.events)
    ? evidence.events.filter(
        (event): event is Record<string, unknown> =>
          event !== null && typeof event === 'object' && !Array.isArray(event),
      )
    : []
  if (events.length > 0) return events
  const latest = evidence.latest
  return latest !== null && typeof latest === 'object' && !Array.isArray(latest)
    ? [latest as Record<string, unknown>]
    : []
}

/** A changed terms-page hash alone does not establish a moved exit gate. */
export const isTermsOnlyNotice = (e: Pick<Entry, 'kind' | 'evidence'>): boolean => {
  if (e.kind === 'terms_page_notice') return true
  if (e.kind !== 'gate_change') return false
  const count = Number(e.evidence?.count)
  if (!Number.isInteger(count) || count <= 0) return false
  const rawEvents = e.evidence?.events
  if (Array.isArray(rawEvents)) {
    return (
      rawEvents.length === count &&
      rawEvents.every(
        (event) =>
          event !== null &&
          typeof event === 'object' &&
          !Array.isArray(event) &&
          event.kind === 'terms_page_changed',
      )
    )
  }
  return (
    count === 1 &&
    (e.evidence?.latest as Record<string, unknown> | null)?.kind === 'terms_page_changed'
  )
}

/** Reject executable, credential-bearing, or ambiguous external links. */
export const safeHttpsSourceUrl = (value: unknown): string | null => {
  if (
    typeof value !== 'string' ||
    !value.startsWith('https://') ||
    value !== value.trim() ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  )
    return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

/** Only a structured, browser-safe HTTPS URL on a recorded terms change is linkable. */
export const termsSourceUrl = (e: Pick<Entry, 'kind' | 'evidence'>): string | null => {
  const hasTermsChange =
    e.kind === 'terms_page_notice' ||
    (e.kind === 'gate_change' && gateEvents(e).some((event) => event.kind === 'terms_page_changed'))
  return hasTermsChange ? safeHttpsSourceUrl(e.evidence?.sourceUrl) : null
}

/** Render an alarm from its recorded evidence; terms-only changes are notices. */
export const alarmConsequence = (
  e: Entry,
): { text: string; tone: 'danger' | 'muted' | 'notice' } => {
  // These historical rows came from venue_flows before the recorder could
  // certify quiet ranges or complete days. Keep the archive visible, but never
  // restate its streak, worst-day, or headroom numbers as measured facts.
  if (e.kind === 'net_outflow_streak' || e.kind === 'headroom_thin') {
    return {
      text: `HISTORICAL · ${e.kind === 'net_outflow_streak' ? 'outflow streak' : 'thin headroom'} signal withdrawn — source flow coverage was incomplete; the earlier alert cannot be validated`,
      tone: 'muted',
    }
  }
  const termsOnly = isTermsOnlyNotice(e)
  const tone = e.cleared ? 'muted' : termsOnly ? 'notice' : 'danger'
  const ev = e.evidence ?? {}
  const sev = (e.severity ?? 'alarm').toUpperCase()
  const pre = termsOnly
    ? e.cleared
      ? e.kind === 'terms_page_notice'
        ? 'NOTICE WINDOW ENDED · '
        : 'NOTICE RECORD CLOSED · '
      : 'NOTICE · '
    : e.kind === 'gate_change' && e.cleared
      ? 'ALERT WINDOW ENDED · '
      : e.cleared
        ? 'CLEARED · '
        : `${sev} · `
  let body: string
  switch (e.kind) {
    case 'gate_change': {
      const events = gateEvents(e)
      const cooldown = events.find((event) => event.kind === 'cooldown_duration_changed')
      const liquidity = events.find((event) => event.kind === 'instant_liquidity_shift')
      const termsChanged = events.some((event) => event.kind === 'terms_page_changed')
      const count = Number(ev.count)
      const rawEvents = ev.events
      const fullRoster =
        Number.isInteger(count) &&
        count > 0 &&
        (Array.isArray(rawEvents)
          ? rawEvents.length === count && events.length === count
          : count === 1 && events.length === 1)
      const detailsMissing = !fullRoster
      const missingNote = detailsMissing ? '; additional event details unavailable' : ''
      const measured: string[] = []
      if (cooldown) {
        const beforeValue = (cooldown.prev as Record<string, unknown> | null)?.cooldownDuration
        const afterValue = (cooldown.next as Record<string, unknown> | null)?.cooldownDuration
        const before = Number(beforeValue)
        const after = Number(afterValue)
        const values =
          beforeValue != null &&
          afterValue != null &&
          Number.isFinite(before) &&
          Number.isFinite(after)
            ? ` ${fmtDuration(before)} → ${fmtDuration(after)}`
            : ''
        measured.push(`cooldown duration changed${values}`)
      }
      if (liquidity) {
        const beforeValue = (liquidity.prev as Record<string, unknown> | null)?.instant_usd
        const afterValue = (liquidity.next as Record<string, unknown> | null)?.instant_usd
        const before = Number(beforeValue)
        const after = Number(afterValue)
        const values =
          beforeValue != null &&
          afterValue != null &&
          Number.isFinite(before) &&
          Number.isFinite(after) &&
          before >= 0 &&
          after >= 0
            ? ` ${fmtUsd(before)} → ${fmtUsd(after)}`
            : ''
        measured.push(`instant exit capacity shifted${values}`)
      }
      if (measured.length > 0) {
        body = `${measured.join('; ')} in the recorded 24h detection window${termsChanged ? '; configured official terms-page text also changed (exit impact unclassified)' : ''}${missingNote} — review the current exit conditions`
      } else if (termsChanged) {
        // A normalized visible-text hash change does not identify a changed
        // clause or establish a withdrawal restriction.
        body = `configured official terms-page text changed in the recorded 24h detection window${missingNote} — exit impact unclassified; review the source terms`
      } else {
        body =
          'venue exit-condition event recorded in the 24h detection window — review the venue log'
      }
      break
    }
    case 'terms_page_notice': {
      body =
        'configured official terms-page text changed in the recorded 24h detection window — exit impact unclassified; review the source terms'
      break
    }
    case 'drawdown_fast': {
      const drop = Number(ev.dropPct)
      body = `capacity fell ${Number.isFinite(drop) ? drop.toFixed(0) : '?'}% — ${fmtUsd(Number(ev.fromValue))} → ${fmtUsd(Number(ev.toValue))} in ≤7d (${ev.metric})`
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
    // A normalized visible-text hash changed. Neither the hash nor a length
    // delta identifies a changed clause or establishes an exit restriction.
    const a = Number(e.prev?.content_len)
    const b = Number(e.next?.content_len)
    const delta =
      Number.isFinite(a) && Number.isFinite(b) && b !== a
        ? ` (${b > a ? '+' : ''}${b - a} chars)`
        : ''
    return {
      text: `configured official terms-page text changed${delta} — exit impact unclassified; review the source terms`,
      tone: 'normal',
    }
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
      .map(
        (k) =>
          `${LABEL[k] ?? k.replace(/_/g, ' ')} ${fmt(k, e.prev?.[k])} → ${fmt(k, e.next?.[k])}`,
      )
    const down = keys.some((k) => Number(e.next?.[k]) < Number(e.prev?.[k]))
    return {
      text: `${parts.join(' · ') || 'parameter changed'}${windowLabel(e)}`,
      tone: down ? 'warning' : 'normal',
    }
  }
  // Unknown kind: name it, never dump it.
  return { text: `${e.kind.replace(/_/g, ' ')} recorded`, tone: 'normal' }
}
