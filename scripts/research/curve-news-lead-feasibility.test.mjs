import assert from 'node:assert/strict'
import test from 'node:test'
import { groupCandidates, pollCoverage, summarize } from './curve-news-lead-feasibility.mjs'

function row(sequence, fetched, published, eventId = 'a') {
  return {
    sequence,
    observation: {
      venue: 'scrvUSD',
      title: `headline ${sequence}`,
      fetchedAt: fetched,
      publishedAt: published,
    },
    group: { eventId },
  }
}
const at = (hours) => new Date(Date.UTC(2026, 8, 1) + hours * 3_600_000).toISOString()
const quote = (hours, block) => ({
  checkpoint: { captureEndUtc: at(hours), block: { number: block } },
})
const holder = (hours, block, status = 'success') => ({
  captureEndUtc: at(hours),
  checkpoint: { block: { number: block } },
  result: { status },
})

test('publication claim never backdates first usable evidence', () => {
  const [c] = groupCandidates({
    news: [row(1, at(200), at(0))],
    quotes: [quote(199, 10)],
    holders: [holder(199, 10)],
    asOf: at(201),
  })
  assert.equal(c.publicationToFetchLagHours, 200)
  assert.equal(c.claimedPublicationLeadEligible['24h'], false)
  assert.equal(c.claimedPublicationLeadEligible['168h'], false)
  assert.equal(c.preFetchQuoteBaseline.block, 10)
  assert.equal(c.preFetchSuccessfulHolderBaseline.block, 10)
})

test('24h and 168h lead boundaries use first fetch, not a later duplicate', () => {
  const candidates = groupCandidates({
    news: [row(1, at(0), at(24), 'a'), row(2, at(1), at(100), 'a'), row(3, at(0), at(168), 'b')],
    quotes: [],
    holders: [],
    asOf: at(2),
  })
  assert.equal(candidates[0].claimedPublicationLeadEligible['24h'], true)
  assert.equal(candidates[0].claimedPublicationLeadEligible['168h'], false)
  assert.deepEqual(candidates[0].memberSequences, [1, 2])
  assert.equal(candidates[0].duplicateCount, 1)
  assert.equal(candidates[1].claimedPublicationLeadEligible['168h'], true)
})

test('missing publication, stale baseline, and failed holder remain unknown or absent', () => {
  const [c] = groupCandidates({
    news: [row(1, at(24), null)],
    quotes: [quote(17, 1)],
    holders: [holder(23, 2, 'provider_error')],
    asOf: at(25),
  })
  assert.equal(c.claimedPublicationLeadEligible['24h'], 'unknown_publication')
  assert.equal(c.preFetchQuoteBaseline, null)
  assert.equal(c.preFetchSuccessfulHolderBaseline, null)
})

test('a source block before news is not a baseline when captured after first fetch', () => {
  const [c] = groupCandidates({
    news: [row(1, at(24), at(1))],
    quotes: [quote(25, 1)],
    holders: [holder(25, 1)],
    asOf: at(26),
  })
  assert.equal(c.preFetchQuoteBaseline, null)
  assert.equal(c.preFetchSuccessfulHolderBaseline, null)
})

test('late backfills cannot replace the freshest pre-fetch baselines', () => {
  const [c] = groupCandidates({
    news: [row(1, at(24), at(1))],
    quotes: [quote(23, 9), quote(22, 8)],
    holders: [holder(23, 9), holder(22, 8)],
    asOf: at(25),
  })
  assert.equal(c.preFetchQuoteBaseline.block, 9)
  assert.equal(c.preFetchSuccessfulHolderBaseline.block, 9)
})

test('as-of requires a canonical UTC instant', () => {
  assert.throws(
    () => groupCandidates({ news: [], quotes: [], holders: [], asOf: '2026-09-01' }),
    /Valid --as-of UTC required/,
  )
})

test('missing, legacy, failed, and capped polls cannot certify quiet', () => {
  const polls = [
    {
      venue: 'scrvUSD',
      endedAtUtc: at(1),
      status: 'success',
      coverageStatus: 'observed_below_cap',
    },
    { venue: 'scrvUSD', endedAtUtc: at(2), status: 'fetch_error', receiptVersion: 2 },
    {
      venue: 'scrvUSD',
      endedAtUtc: at(3),
      status: 'success',
      receiptVersion: 2,
      coverageStatus: 'at_or_over_cap',
    },
    {
      venue: 'scrvUSD',
      endedAtUtc: at(4),
      status: 'success',
      receiptVersion: 2,
      coverageStatus: 'observed_below_cap',
    },
  ]
  const c = pollCoverage(polls, at(5))
  assert.deepEqual(
    [c.total, c.legacy, c.v2, c.failed, c.v2SuccessfulBelowCap, c.v2CappedOrIncomplete],
    [4, 1, 3, 1, 1, 1],
  )
  assert.equal(c.feedQuietBetweenPolls, 'unknown')
  assert.equal(pollCoverage([], at(5)).feedQuietBetweenPolls, 'unknown')
})

test('report seal is deterministic and denominators count groups not reprints', () => {
  const candidates = groupCandidates({
    news: [row(1, at(1), at(0)), row(2, at(2), at(0))],
    quotes: [],
    holders: [],
    asOf: at(3),
  })
  const input = { candidates, coverage: pollCoverage([], at(3)), asOf: at(3), sources: {} }
  const a = summarize(input)
  assert.equal(a.sha256, summarize(input).sha256)
  assert.deepEqual(
    [
      a.denominators.candidateIncidents,
      a.denominators.headlineObservations,
      a.denominators.duplicateObservations,
    ],
    [1, 2, 1],
  )
})
