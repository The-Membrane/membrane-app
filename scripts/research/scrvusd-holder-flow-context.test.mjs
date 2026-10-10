import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildIssue, historicalPrefixAt, readSealed } from './scrvusd-holder-flow-context.mjs'

const sha = (x) => createHash('sha256').update(x).digest('hex')
const h = (n) => `0x${n.toString(16).padStart(64, '0')}`
const s = (n) => String(n).repeat(64)
const iso = (n) => new Date(n * 1000).toISOString()
const BASE = 1_790_000_000
const DAY = 86_400
const block = { number: 100, hash: h(100), timestamp: BASE + 8 * DAY }
const filename = `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
const receiptName = (from, to) =>
  `${String(from).padStart(12, '0')}-${String(to).padStart(12, '0')}-${h(to).slice(2)}.json`
const witnessName = (from) => `${String(from).padStart(12, '0')}-${h(from).slice(2)}.json`
function fixture({
  durationAt = BASE + 8 * DAY + 30,
  featureAt = BASE + 8 * DAY + 20,
  issueAt = BASE + 8 * DAY + 40,
  end = BASE + 8 * DAY,
} = {}) {
  const duration = {
    study: 'scrvusd-holder-executable-duration-v1',
    block,
    quote: { logicalSha256: s(1), physicalSha256: s(2) },
    issuedAtUtc: iso(durationAt),
    sha256: s(3),
  }
  const feature = {
    study: 'scrvusd-vault-flow-feature-issues-v1',
    block,
    source: { quoteCheckpointSha256: s(1), quotePhysicalSha256: s(2) },
    issuedAtUtc: iso(featureAt),
    sha256: s(4),
  }
  const receipt = {
    sha256: s(5),
    captureEndUtc: iso(durationAt - 2),
    range: {
      from: { number: 1, hash: h(1), timestamp: BASE },
      to: { number: 2, hash: h(2), timestamp: end },
    },
    events: [
      {
        kind: 'deposit',
        blockTimestamp: BASE + DAY,
        blockNumber: 1,
        logIndex: 0,
        assetsRaw: `${50n * 10n ** 18n}`,
      },
      {
        kind: 'withdraw',
        blockTimestamp: BASE + 7 * DAY,
        blockNumber: 2,
        logIndex: 0,
        assetsRaw: `${100n * 10n ** 18n}`,
      },
    ],
  }
  return {
    duration,
    feature,
    durationRef: { filename, logicalSha256: duration.sha256, physicalSha256: s(6) },
    featureRef: { filename, logicalSha256: feature.sha256, physicalSha256: s(7) },
    near: {
      issuedAtUtc: iso(issueAt),
      plan: {
        sha256: s(8),
        capturedAtUtc: iso(BASE - 10),
        start: receipt.range.from,
        end: receipt.range.to,
        firstLiveParentHash: h(2),
      },
      planRef: { filename: 'plan.json', logicalSha256: s(8), physicalSha256: s(9) },
      source: { identitySha256: s(0) },
      receipts: [receipt],
      receiptRefs: [{ filename: receiptName(1, 2), logicalSha256: s(5), physicalSha256: s(1) }],
      witnessRefs: [
        {
          filename: witnessName(1),
          logicalSha256: s(2),
          physicalSha256: s(3),
          capturedAtUtc: iso(durationAt - 1),
        },
      ],
    },
  }
}

test('exact-B pre-duration flow and as-of near-live context are sealed separately', () => {
  const issue = buildIssue(fixture())
  assert.equal(issue.sameBlockFlowFeatureIssue.logicalSha256, s(4))
  assert.equal(issue.durationIssue.logicalSha256, s(3))
  assert.equal(issue.historicalSuffix.completeToFirstLive, true)
  assert.equal(
    issue.historicalSuffix.maximumObservedCompleteWindow['24h'].grossWithdrawalsCrvUsd,
    '100',
  )
  assert.equal(
    issue.historicalSuffix.maximumObservedCompleteWindowNetDepletion['24h'].netDepletionRaw,
    `${100n * 10n ** 18n}`,
  )
  assert.equal(issue.historicalSuffix.maximumObservedCompleteWindow['7d'].status, 'observed')
  assert.equal(issue.historicalSuffix.receipts.length, 1)
  const { sha256: sealSha, ...unsigned } = issue
  assert.equal(sealSha, sha(JSON.stringify(unsigned)))
})

test('late or wrong-block flow cannot backfill a holder duration issue', () => {
  const late = fixture({ featureAt: BASE + 8 * DAY + 31 })
  assert.throws(() => buildIssue(late), /requires eligible same-B flow/)
  const wrong = fixture()
  wrong.feature.block = { ...block, number: 101 }
  assert.throws(() => buildIssue(wrong), /requires eligible same-B flow/)
})

test('future v2 holder-duration issue uses the same exact-B chronology and seals', () => {
  const data = fixture()
  data.duration.study = 'scrvusd-holder-executable-duration-v2'
  const issue = buildIssue(data)
  assert.equal(issue.durationIssue.logicalSha256, data.duration.sha256)
  data.feature.issuedAtUtc = iso(BASE + 8 * DAY + 31)
  assert.throws(() => buildIssue(data), /requires eligible same-B flow/)
})

test('later captured historical receipt or witness cannot enter earlier companion issue', () => {
  const lateReceipt = fixture()
  lateReceipt.near.receipts[0].captureEndUtc = iso(BASE + 8 * DAY + 35)
  assert.throws(() => buildIssue(lateReceipt), /unavailable at duration issue time/)
  const lateWitness = fixture()
  lateWitness.near.witnessRefs[0].capturedAtUtc = iso(BASE + 8 * DAY + 35)
  assert.throws(() => buildIssue(lateWitness), /unavailable at duration issue time/)
})

test('late suffix capture before companion but after duration issue is excluded from context', () => {
  const data = fixture()
  const late = {
    receipt: { captureEndUtc: iso(BASE + 8 * DAY + 35) },
    witnessRef: { capturedAtUtc: iso(BASE + 8 * DAY + 36) },
  }
  const rows = [{ receipt: data.near.receipts[0], witnessRef: data.near.witnessRefs[0] }, late]
  const prefix = historicalPrefixAt(rows, data.duration.issuedAtUtc)
  assert.equal(prefix.length, 1)
  assert.equal(buildIssue(data).historicalSuffix.receipts.length, 1)
  assert.equal(buildIssue(data).historicalSuffix.evidenceCutoffUtc, data.duration.issuedAtUtc)
})

test('less than seven days of verified suffix has no seven-day maximum', () => {
  const data = fixture({ end: BASE + 3 * DAY })
  data.near.receipts[0].events = []
  data.near.plan.end = data.near.receipts[0].range.to
  const issue = buildIssue(data)
  assert.equal(issue.historicalSuffix.maximumObservedCompleteWindow['7d'].status, 'unavailable')
  assert.equal(
    issue.historicalSuffix.maximumObservedCompleteWindowNetDepletion['7d'].status,
    'unavailable',
  )
})

test('physical or logical companion corruption is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holder-flow-context-'))
  try {
    const path = join(dir, 'issue.json')
    const issue = buildIssue(fixture())
    writeFileSync(path, `${JSON.stringify(issue)}\n`)
    assert.deepEqual(readSealed(path), issue)
    writeFileSync(path, `${JSON.stringify({ ...issue, kind: 'altered' })}\n`)
    assert.throws(() => readSealed(path), /seal mismatch/)
    writeFileSync(path, `${JSON.stringify(issue)}  \n`)
    assert.throws(() => readSealed(path), /seal mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
