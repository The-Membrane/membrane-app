// Pure logic for PER-ADDRESS VENUE ALERTS — the join between the two tables the
// recorder already writes: strat_watches (which venues an address holds) and
// venue_alarms (which venues just fired a failure-pattern alarm). Kept JSX-free
// and I/O-free so tests/unit exercises exactly what /api/radar/alerts serves.
//
// Nothing here computes a new signal. An alert is an existing venue alarm, routed
// to the addresses that hold that venue. Silence is NOT all-clear: every surface
// that renders these carries the held venues' blind-spot footer (pages/api/_lib/uncovered.ts).

import {
  alarmConsequence,
  isTermsOnlyNotice,
  termsSourceUrl,
} from '@/components/Carry/venueLogLogic'

/** Below this a holding is dust and does not route alerts. */
export const DUST_USD = 1

export type WatchLike = {
  createdAt: string
  /** Radar positions captured at watch time: [{ venue, usd, ... }]. */
  entryPositions: Array<{ venue: string; usd: number }> | null
  /** Cached current positions from refresh-strat-positions: { usdByVenue }. */
  lastScanned: { usdByVenue?: Record<string, number> } | null
}

export type AlarmLike = {
  venue: string
  kind: string
  severity: 'watch' | 'alarm' | 'notice' | 'info'
  evidence: Record<string, unknown> | null
  firedAt: string
  clearedAt: string | null
}

export type Alert = AlarmLike & { text: string; open: boolean }

// The legacy flow recorder has no certified quiet-range coverage. These old
// rows remain in the DB for audit, but they cannot be actionable alerts until
// a complete-window evidence source replaces that recorder.
export const SUSPENDED_FLOW_ALARM_KINDS = ['net_outflow_streak', 'headroom_thin'] as const
export const isSuspendedFlowAlarm = (a: { kind: string }): boolean =>
  SUSPENDED_FLOW_ALARM_KINDS.some((kind) => kind === a.kind)

// UNREAD DEPTH ZEROS. Before the depth reader stored null on a failed read (first
// guarded snapshot 2026-09-25T04:29:56Z), a failed read was stored as depth_usd = 0.
// All four pre-guard zero rows recorded every reserve read as failed, so they are
// unreads, not drains — yet they fired depth_collapse alarms and "depth → $0" venue
// events. Those rows are insert-only history, so they are excluded at READ time by
// this one rule. After the guard a zero comes only from successful reads and counts.
// Mirror of scripts/lib/alarmRules.mjs DEPTH_GUARD_LIVE / isUnreadDepthZero.
export const DEPTH_GUARD_LIVE = '2026-09-25T04:29:56Z'

export const isUnreadDepthZero = (value: unknown, at: string | null | undefined): boolean => {
  if (value === null || value === undefined || Number(value) !== 0 || !at) return false
  const t = Date.parse(at)
  return Number.isFinite(t) && t < Date.parse(DEPTH_GUARD_LIVE)
}

/** A depth_collapse alarm whose end point was an unread zero. */
export const isUnreadDepthAlarm = (a: {
  kind: string
  evidence?: Record<string, unknown> | null
  firedAt?: string
}): boolean => {
  if (a.kind !== 'depth_collapse') return false
  const ev = a.evidence ?? {}
  const to = typeof ev.toDate === 'string' ? ev.toDate : a.firedAt
  return isUnreadDepthZero(ev.toValue, to)
}

/**
 * Remove an unread depth zero from a param_changed event. Returns the event with
 * depth_usd dropped from prev/next when either side was an unread zero, or null
 * when nothing else changed (the whole event was the artefact).
 */
export const scrubUnreadDepthEvent = <
  E extends {
    kind: string
    at: string
    prev: Record<string, unknown> | null
    next: Record<string, unknown> | null
  },
>(
  e: E,
): E | null => {
  if (e.kind !== 'param_changed') return e
  const unread =
    isUnreadDepthZero(e.next?.depth_usd, e.at) || isUnreadDepthZero(e.prev?.depth_usd, e.at)
  if (!unread) return e
  const strip = (o: Record<string, unknown> | null) => {
    if (!o) return o
    const { depth_usd: _drop, ...rest } = o
    return rest
  }
  const prev = strip(e.prev)
  const next = strip(e.next)
  if (!next || Object.keys(next).length === 0) return null
  return { ...e, prev, next }
}

/**
 * The venues an address holds right now. The cached current scan wins when it
 * exists (an address that exited a venue stops getting its alarms); otherwise
 * the entry snapshot stands in until the first refresh runs.
 */
export const heldVenues = (w: WatchLike): string[] => {
  const current = w.lastScanned?.usdByVenue
  if (current && Object.keys(current).length > 0) {
    return Object.entries(current)
      .filter(([, usd]) => Number(usd) >= DUST_USD)
      .map(([venue]) => venue)
      .sort()
  }
  const entry = w.entryPositions ?? []
  return Array.from(
    new Set(entry.filter((p) => Number(p.usd) >= DUST_USD).map((p) => p.venue)),
  ).sort()
}

const toAlert = (a: AlarmLike): Alert => ({
  ...a,
  open: a.clearedAt === null,
  text: alarmConsequence({
    venue: a.venue,
    kind: a.kind,
    at: a.firedAt,
    prev: null,
    next: null,
    provenance: 'alarm',
    severity: a.severity,
    evidence: a.evidence,
    cleared: a.clearedAt !== null,
  }).text,
})

/**
 * Route alarms to one address.
 *  open   — every currently-open alarm on a venue the address holds, whenever it
 *           fired (an alarm that opened before you started watching still applies).
 *  recent — alarms on held venues that CLEARED after the watch began: the history
 *           of what happened while you were watching.
 * Both newest first.
 */
export const matchAlerts = (
  held: string[],
  alarms: AlarmLike[],
  watchedSince: string,
): { open: Alert[]; recent: Alert[] } => {
  const holds = new Set(held)
  const since = Date.parse(watchedSince)
  const mine = alarms.filter(
    (a) => holds.has(a.venue) && !isUnreadDepthAlarm(a) && !isSuspendedFlowAlarm(a),
  )
  const open = mine
    .filter((a) => a.clearedAt === null)
    .sort((x, y) => Date.parse(y.firedAt) - Date.parse(x.firedAt))
    .map(toAlert)
  const recent = mine
    .filter((a) => a.clearedAt !== null && Date.parse(a.clearedAt) >= since)
    .sort((x, y) => Date.parse(y.clearedAt as string) - Date.parse(x.clearedAt as string))
    .map(toAlert)
  return { open, recent }
}

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * RSS 2.0 for one address's alerts — a subscription with no account, no email and
 * no personal data: any feed reader polls it. Opening and clearing are separate
 * items (distinct guids) so a reader sees both moments.
 */
export const toRss = (args: {
  address: string
  radarUrl: string
  feedUrl: string
  open: Alert[]
  recent: Alert[]
  footer: string
}): string => {
  const items = [
    ...args.open.map((a) => ({ a, at: a.firedAt, tag: 'fired' })),
    ...args.recent.map((a) => ({ a, at: a.clearedAt as string, tag: 'cleared' })),
  ].sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
  const short = `${args.address.slice(0, 6)}…${args.address.slice(-4)}`
  const body = items
    .map(
      ({ a, at, tag }) => `    <item>
      <title>${xml(isTermsOnlyNotice(a) ? `${a.venue} · official terms-page text notice · ${tag === 'fired' ? 'recorded' : a.kind === 'terms_page_notice' ? 'window ended' : 'old record closed'}` : `${a.venue} · ${a.kind.replace(/_/g, ' ')} · ${tag}`)}</title>
      <description>${xml(`${a.text}. ${args.footer}.`)}</description>
      <link>${xml(termsSourceUrl(a) ?? args.radarUrl)}</link>
      <guid isPermaLink="false">${xml(`${a.venue}:${a.kind}:${a.firedAt}:${tag}`)}</guid>
      <pubDate>${new Date(at).toUTCString()}</pubDate>
    </item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(`Membrane venue alerts · ${short}`)}</title>
    <link>${xml(args.radarUrl)}</link>
    <atom:link href="${xml(args.feedUrl)}" rel="self" type="application/rss+xml" />
    <description>${xml(`Recorded venue alerts and official terms-page text notices for venues ${short} holds. Data compiled by Membrane from its recorded venue corpus. ${args.footer}.`)}</description>
${body}
  </channel>
</rss>
`
}
