/**
 * The words and shapes of a user's threshold feed — JSON, RSS 2.0, and the one-line
 * event text the Telegram message reuses. Pure (no I/O, no server imports) so the
 * operator tick can load it through tsx.
 *
 * Figures first, short words, every value with its true source and as-of
 * (DESIGN_RULES §3, §4). No verdict words.
 */

import type { Reading } from './evaluate'
import { describeThreshold, formatValue, METRIC_LABEL, parseSubject, subjectLabel, type Direction, type Metric } from './metrics'
import type { OwnerFeed, ThresholdView } from './service'

type EventLike = {
  id: string
  thresholdId: string
  kind: 'crossed' | 'cleared'
  value: number
  at: string
  asOf: string
  source: string
  metric: Metric
  subject: string
  direction: Direction
  threshold: number
}

const utc = (isoStr: string): string => `${isoStr.slice(0, 16).replace('T', ' ')} UTC`

/** "ETH price reached $2,498.10 (alert: below $2,500.00)" */
export const eventHeadline = (e: EventLike): string => {
  const what = `${subjectLabel(e.subject)} ${METRIC_LABEL[e.metric]}`
  const verb = e.kind === 'crossed' ? 'reached' : 'back to'
  return `${what} ${verb} ${formatValue(e.metric, e.value)} (alert: ${e.direction} ${formatValue(e.metric, e.threshold)})`
}

/** "Chainlink ETH / USD · as of 2026-10-14 00:30 UTC" */
export const provenanceLine = (source: string, asOf: string): string => `${source} · as of ${utc(asOf)}`

/** Why a threshold was not checked on this read, in a few words. */
export const skippedLine = (t: ThresholdView): string | null => {
  const r = t.reading
  if (r.status === 'stale') return `not checked: ${r.source} is stale (as of ${utc(r.asOf)})`
  if (r.status === 'unavailable') return `not checked: ${r.source} unavailable`
  return null
}

const readingJson = (r: Reading) =>
  r.status === 'unavailable'
    ? { status: r.status, source: r.source, reason: r.reason }
    : { status: r.status, value: r.value, asOf: r.asOf, source: r.source }

/** The JSON body of GET /api/alerts/feed/[token] — this owner's own data only. */
export const feedJson = (feed: OwnerFeed) => ({
  generatedAt: feed.generatedAt,
  thresholds: feed.thresholds.map((t) => ({
    id: t.id,
    metric: t.metric,
    subject: t.subject,
    direction: t.direction,
    threshold: t.threshold,
    text: describeThreshold(t),
    createdAt: t.createdAt,
    crossed: t.crossed,
    crossedAt: t.crossedAt,
    reading: readingJson(t.reading),
    note: skippedLine(t),
  })),
  events: feed.events.map((e) => ({
    id: e.id,
    thresholdId: e.thresholdId,
    kind: e.kind,
    value: e.value,
    at: e.at,
    asOf: e.asOf,
    source: e.source,
    text: eventHeadline(e),
  })),
})

const xml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Where an item links: the venue page for a venue subject, else the site. */
const linkFor = (siteUrl: string, subject: string): string => {
  const s = parseSubject(subject)
  return s?.kind === 'venue' ? `${siteUrl}/ethereum/venue/${encodeURIComponent(s.venue)}` : siteUrl
}

/**
 * RSS 2.0. One item per crossed/cleared event (stable guid per transition, so a reader
 * shows each once). Thresholds this read could not check are named in the channel
 * description — never as items, which would repeat on every poll.
 */
export const feedRss = (feed: OwnerFeed, args: { feedUrl: string; siteUrl: string }): string => {
  const active = feed.thresholds.length
  const notChecked = feed.thresholds.map(skippedLine).filter((l): l is string => l !== null)
  const desc = [
    `Your alerts: ${active} active.`,
    ...feed.thresholds.map((t) => `${describeThreshold(t)}.`),
    ...notChecked.map((l) => `${l}.`),
    'Data compiled by Membrane.',
  ].join(' ')
  const items = feed.events
    .map(
      (e) => `    <item>
      <title>${xml(`${eventHeadline(e)} · ${e.kind}`)}</title>
      <description>${xml(`${eventHeadline(e)}. ${provenanceLine(e.source, e.asOf)}.`)}</description>
      <link>${xml(linkFor(args.siteUrl, e.subject))}</link>
      <guid isPermaLink="false">${xml(`threshold:${e.thresholdId}:${e.kind}:${e.id}`)}</guid>
      <pubDate>${new Date(e.at).toUTCString()}</pubDate>
    </item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Membrane · your alerts</title>
    <link>${xml(args.siteUrl)}</link>
    <atom:link href="${xml(args.feedUrl)}" rel="self" type="application/rss+xml" />
    <description>${xml(desc)}</description>
    <ttl>15</ttl>
${items}
  </channel>
</rss>
`
}
