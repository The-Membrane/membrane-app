// Offline feasibility audit. A publication timestamp is a source claim, while
// fetchedAt is the earliest locally usable headline observation. No alert.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OUT as NEWS_OUT, verify as verifyNews } from './venue-news-event-ledger.mjs'
import { OUT as POLL_OUT, verifyPolls } from '../lib/newsPollLedger.mjs'
import { OUT as QUOTE_OUT, readValidatedCheckpoints } from './curve-prospective-quote.mjs'
import { OUT as HOLDER_OUT, verify as verifyHolder } from './scrvusd-fixed-holder-exit.mjs'

export const STUDY = 'curve-news-lead-feasibility-v1'
export const HORIZONS_HOURS = [24, 168]
const MAX_BASELINE_AGE_MS = 6 * 3_600_000
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const ms = (utc) => Date.parse(utc)
const file = (sequence) => `${String(sequence).padStart(12, '0')}.json`

function asOfUtc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(ms(value)) ||
    new Date(ms(value)).toISOString() !== value
  )
    throw new Error('Valid --as-of UTC required')
  return value
}

function sourceRef(directory, name, logicalSha256) {
  return {
    filename: name,
    logicalSha256,
    physicalSha256: sha(readFileSync(join(directory, name))),
  }
}

function latestPreFetch(rows, fetched, captureTime) {
  const firstSeen = ms(fetched)
  return rows.reduce((latest, row) => {
    const captured = ms(captureTime(row))
    if (
      !Number.isFinite(captured) ||
      captured >= firstSeen ||
      firstSeen - captured > MAX_BASELINE_AGE_MS
    )
      return latest
    return !latest || captured > ms(captureTime(latest)) ? row : latest
  }, null)
}

export function groupCandidates({ news, quotes, holders, polls = [], asOf }) {
  const cutoff = ms(asOfUtc(asOf))
  const groups = new Map()
  for (const row of news) {
    if (row.observation.venue.toLowerCase() !== 'scrvusd') continue
    if (ms(row.observation.fetchedAt) > cutoff) continue
    const id = row.group.eventId
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(row)
  }
  return [...groups.values()].map((rows) => {
    // The ledger's duplicate group is chronological. Only the first member
    // can start a candidate incident; later reprints never backdate it.
    const first = rows[0]
    const fetched = first.observation.fetchedAt
    const published = first.observation.publishedAt
    const lagHours = published ? (ms(fetched) - ms(published)) / 3_600_000 : null
    const quote = latestPreFetch(quotes, fetched, (q) => q.checkpoint.captureEndUtc)
    const holder = latestPreFetch(
      holders.filter((h) => h.result.status === 'success'),
      fetched,
      (h) => h.captureEndUtc,
    )
    const priorPolls = polls.filter(
      (p) => p.venue.toLowerCase() === 'scrvusd' && ms(p.endedAtUtc) < ms(fetched),
    )
    return {
      eventId: first.group.eventId,
      rootSequence: first.sequence,
      memberSequences: rows.map((r) => r.sequence),
      duplicateCount: rows.length - 1,
      title: first.observation.title,
      sourceClaimedPublishedAtUtc: published,
      firstLocallyFetchedAtUtc: fetched,
      publicationToFetchLagHours: lagHours,
      leadBeforeClaimedPublicationHours: lagHours === null ? null : -lagHours,
      claimedPublicationLeadEligible: Object.fromEntries(
        HORIZONS_HOURS.map((h) => [
          `${h}h`,
          published === null ? 'unknown_publication' : lagHours <= -h,
        ]),
      ),
      preFetchQuoteBaseline: quote
        ? { block: quote.checkpoint.block.number, captureEndUtc: quote.checkpoint.captureEndUtc }
        : null,
      preFetchSuccessfulHolderBaseline: holder
        ? { block: holder.checkpoint.block.number, captureEndUtc: holder.captureEndUtc }
        : null,
      precedingScrvUsdPollReceipts: priorPolls.length,
      prospectivePostFetchTarget: 'future_only_if_armed_before_first_fetch',
      relevanceAndImpact: 'unadjudicated_query_provenance',
    }
  })
}

export function pollCoverage(polls, asOf) {
  const relevant = polls.filter(
    (p) => p.venue.toLowerCase() === 'scrvusd' && ms(p.endedAtUtc) <= ms(asOf),
  )
  const v2 = relevant.filter((p) => p.receiptVersion === 2)
  const legacy = relevant.filter((p) => p.receiptVersion === undefined)
  const failed = relevant.filter((p) => p.status !== 'success')
  const usableV2 = v2.filter(
    (p) => p.status === 'success' && p.coverageStatus === 'observed_below_cap',
  )
  return {
    total: relevant.length,
    v2: v2.length,
    legacy: legacy.length,
    failed: failed.length,
    v2SuccessfulBelowCap: usableV2.length,
    v2CappedOrIncomplete: v2.filter(
      (p) => p.status === 'success' && p.coverageStatus !== 'observed_below_cap',
    ).length,
    feedQuietBetweenPolls: 'unknown',
    sourceScope: 'one_scrvusd_google_news_rss_query',
  }
}

export function summarize({ candidates, coverage, asOf, sources }) {
  const payload = {
    study: STUDY,
    asOfUtc: asOfUtc(asOf),
    sourceRefs: sources,
    population: 'scrvUSD-tagged candidate news groups; relevance and impact unadjudicated',
    denominators: {
      candidateIncidents: candidates.length,
      headlineObservations: candidates.reduce((n, c) => n + c.memberSequences.length, 0),
      duplicateObservations: candidates.reduce((n, c) => n + c.duplicateCount, 0),
      publicationClaimPresent: candidates.filter((c) => c.sourceClaimedPublishedAtUtc).length,
      localLead24h: candidates.filter((c) => c.claimedPublicationLeadEligible['24h'] === true)
        .length,
      localLead168h: candidates.filter((c) => c.claimedPublicationLeadEligible['168h'] === true)
        .length,
      preFetchQuoteBaselines: candidates.filter((c) => c.preFetchQuoteBaseline).length,
      preFetchSuccessfulHolderBaselines: candidates.filter(
        (c) => c.preFetchSuccessfulHolderBaseline,
      ).length,
      candidateIncidentsWithPrecedingPoll: candidates.filter(
        (c) => c.precedingScrvUsdPollReceipts > 0,
      ).length,
      impactAdjudicatedIncidents: 0,
    },
    pollCoverage: coverage,
    candidates,
    caveat:
      'Publication and stored DB fetched_at are source fields, not independent attestations. Only first local fetch can start prospective use; delayed headlines are retrospective context. No absence-of-news, volatility cause, or vault-exit forecast follows.',
  }
  return { ...payload, sha256: sha(JSON.stringify(payload)) }
}

export function buildReport({
  asOf,
  newsOut = NEWS_OUT,
  pollOut = POLL_OUT,
  quoteOut = QUOTE_OUT,
  holderOut = HOLDER_OUT,
} = {}) {
  const cutoff = asOfUtc(asOf)
  const news = verifyNews(newsOut).receipts
  const polls = verifyPolls(pollOut).receipts
  const quotes = readValidatedCheckpoints({ out: quoteOut })
  verifyHolder({ out: holderOut, quoteOut })
  const holderDir = join(holderOut, 'issues')
  const holders = existsSync(holderDir)
    ? readdirSync(holderDir)
        .filter((n) => n.endsWith('.json'))
        .sort()
        .map((n) => JSON.parse(readFileSync(join(holderDir, n), 'utf8')))
    : []
  const candidates = groupCandidates({ news, quotes, holders, polls, asOf: cutoff })
  const sourceRefs = {
    news: news
      .filter(
        (r) =>
          ms(r.observation.fetchedAt) <= ms(cutoff) &&
          r.observation.venue.toLowerCase() === 'scrvusd',
      )
      .map((r) => sourceRef(newsOut, file(r.sequence), r.sha256)),
    polls: polls
      .filter((p) => ms(p.endedAtUtc) <= ms(cutoff) && p.venue.toLowerCase() === 'scrvusd')
      .map((p) => sourceRef(pollOut, file(p.sequence), p.sha256)),
    quotes: quotes
      .filter((q) => ms(q.checkpoint.captureEndUtc) <= ms(cutoff))
      .map((q) => ({
        filename: q.filename,
        logicalSha256: q.checkpoint.sha256,
        physicalSha256: q.physicalSha256,
      })),
    holders: holders
      .filter((h) => ms(h.captureEndUtc) <= ms(cutoff))
      .map((h) =>
        sourceRef(
          holderDir,
          `${String(h.checkpoint.block.number).padStart(12, '0')}-${h.checkpoint.block.hash.slice(2)}.json`,
          h.sha256,
        ),
      ),
  }
  return summarize({
    candidates,
    coverage: pollCoverage(polls, cutoff),
    asOf: cutoff,
    sources: sourceRefs,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--as-of')
  if (index < 0 || !process.argv[index + 1])
    throw new Error('Usage: --as-of YYYY-MM-DDTHH:MM:SS.sssZ')
  console.log(JSON.stringify(buildReport({ asOf: process.argv[index + 1] }), null, 2))
}
