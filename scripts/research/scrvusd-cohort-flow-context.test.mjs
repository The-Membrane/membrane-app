import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  buildIssue,
  historicalPrefixAt,
  issueLatest,
  readSealed,
  verify,
} from './scrvusd-cohort-flow-context.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const s = (digit) => digit.repeat(64)
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const dirname = resolve('data/research/venue-signals')
const names = [
  '000026072271-602810b969ba8d9d51f448584f6dfb56d23bf940b25c931be31abea62db3ce63.json',
  '000026072303-8c9f3cbea198abf6cdd4e0d0acb4310eeb001de56a18e6cbac007a930745fbeb.json',
]
const physicalRef = (path, filename, value) => ({
  filename,
  logicalSha256: value.sha256,
  physicalSha256: sha(readFileSync(path)),
})

function savedPair(index) {
  const filename = names[index]
  const durationPath = join(dirname, 'scrvusd-cohort-duration', 'issues', filename)
  const featurePath = join(dirname, 'scrvusd-vault-flow-feature-issues', filename)
  const duration = JSON.parse(readFileSync(durationPath))
  const feature = JSON.parse(readFileSync(featurePath))
  return {
    duration,
    feature,
    durationRef: physicalRef(durationPath, filename, duration),
    featureRef: physicalRef(featurePath, filename, feature),
  }
}

function near(cutoffUtc, { receipts = [], receiptRefs = [], witnessRefs = [] } = {}) {
  return {
    issuedAtUtc: iso(Date.parse(cutoffUtc) / 1000 + 60),
    plan: {
      sha256: s('a'),
      capturedAtUtc: iso(1_790_554_000),
      start: { number: 1 },
      end: { number: 2 },
      firstLiveParentHash: `0x${s('b')}`,
    },
    planRef: { filename: 'plan.json', logicalSha256: s('a'), physicalSha256: s('c') },
    source: { identitySha256: s('d') },
    receipts,
    receiptRefs,
    witnessRefs,
  }
}

test('saved first cohort B attaches exact-B flow issued before its duration issue', () => {
  const data = savedPair(0)
  assert.ok(Date.parse(data.feature.issuedAtUtc) <= Date.parse(data.duration.issuedAtUtc))
  const issue = buildIssue({ ...data, near: near(data.duration.issuedAtUtc) })
  assert.deepEqual(issue.sameBlockFlowFeatureIssue, {
    status: 'available',
    ...data.featureRef,
    issuedAtUtc: data.feature.issuedAtUtc,
    flowFeatures: data.feature.features,
  })
  assert.equal(
    issue.sameBlockFlowFeatureIssue.flowFeatures.coverage.throughBlock,
    data.duration.block.number,
  )
  assert.equal(
    issue.sameBlockFlowFeatureIssue.flowFeatures.trailingCompleteWindow['24h'].status,
    'unavailable',
  )
  assert.equal(
    issue.sameBlockFlowFeatureIssue.flowFeatures.maximumObservedCompleteWindow['7d'].status,
    'unavailable',
  )
  assert.equal(issue.cohort.pairCount, 16)
  assert.equal(issue.cohort.distinctHolderCount, 5)
  assert.equal(issue.cohort.vaultCount, 1)
  assert.equal(issue.historicalSuffix.maximumObservedCompleteWindow['24h'].status, 'unavailable')
  assert.equal(
    issue.historicalSuffix.maximumObservedCompleteWindowNetDepletion['7d'].status,
    'unavailable',
  )
})

test('saved second cohort B preserves late exact-B flow as unavailable', () => {
  const data = savedPair(1)
  assert.ok(Date.parse(data.feature.issuedAtUtc) > Date.parse(data.duration.issuedAtUtc))
  const issue = buildIssue({ ...data, near: near(data.duration.issuedAtUtc) })
  assert.deepEqual(issue.sameBlockFlowFeatureIssue, {
    status: 'unavailable',
    reason: 'same_B_flow_not_available_before_duration_issue',
  })
  assert.equal(issue.cohortDurationIssue.logicalSha256, data.duration.sha256)
  assert.equal(issue.historicalSuffix.evidenceCutoffUtc, data.duration.issuedAtUtc)
  const absent = buildIssue({
    duration: data.duration,
    durationRef: data.durationRef,
    near: near(data.duration.issuedAtUtc),
  })
  assert.deepEqual(absent.sameBlockFlowFeatureIssue, issue.sameBlockFlowFeatureIssue)
})

test('wrong B, hash, timestamp, or quote physical seal cannot be attached', () => {
  const data = savedPair(0)
  for (const change of [
    (feature) => {
      feature.block.number++
    },
    (feature) => {
      feature.block.hash = `0x${s('e')}`
    },
    (feature) => {
      feature.block.timestamp++
    },
    (feature) => {
      feature.source.quotePhysicalSha256 = s('e')
    },
    (feature) => {
      feature.features.checkpoint.timestamp++
    },
  ]) {
    const feature = structuredClone(data.feature)
    change(feature)
    assert.throws(
      () => buildIssue({ ...data, feature, near: near(data.duration.issuedAtUtc) }),
      /Invalid same-B/,
    )
  }
})

test('historical prefix stops before receipts or witnesses captured after duration issue', () => {
  const data = savedPair(1)
  const cutoff = data.duration.issuedAtUtc
  const early = {
    receipt: { captureEndUtc: iso(Date.parse(cutoff) / 1000 - 20) },
    witnessRef: { capturedAtUtc: iso(Date.parse(cutoff) / 1000 - 10) },
  }
  const late = {
    receipt: { captureEndUtc: iso(Date.parse(cutoff) / 1000 + 1) },
    witnessRef: { capturedAtUtc: iso(Date.parse(cutoff) / 1000 + 2) },
  }
  assert.deepEqual(historicalPrefixAt([early, late], cutoff), [early])
})

test('physical and logical companion seal both matter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrvusd-cohort-flow-seal-'))
  try {
    const path = join(dir, 'issue.json')
    const data = savedPair(0)
    const issue = buildIssue({ ...data, near: near(data.duration.issuedAtUtc) })
    writeFileSync(path, `${JSON.stringify(issue)}\n`)
    assert.deepEqual(readSealed(path), issue)
    writeFileSync(path, `${JSON.stringify(issue)}  \n`)
    assert.throws(() => readSealed(path), /seal mismatch/)
    writeFileSync(path, `${JSON.stringify({ ...issue, kind: 'altered' })}\n`)
    assert.throws(() => readSealed(path), /seal mismatch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('actual saved cohort and flow sources replay with first available, second unavailable', () => {
  const out = mkdtempSync(join(tmpdir(), 'scrvusd-cohort-flow-context-'))
  const stat = () => ({ bavail: 1_000_000, bsize: 4096 })
  try {
    const first = issueLatest({ out, stat })
    const second = issueLatest({ out, stat })
    assert.equal(first.status, 'issued')
    assert.equal(second.status, 'issued')
    assert.equal(first.sameBlockFlow, 'available')
    assert.equal(second.sameBlockFlow, 'unavailable')
    assert.equal(verify({ out }).issues, 2)
    const firstIssue = readSealed(first.path)
    const secondIssue = readSealed(second.path)
    assert.deepEqual(
      firstIssue.sameBlockFlowFeatureIssue.flowFeatures,
      savedPair(0).feature.features,
    )
    assert.equal(secondIssue.sameBlockFlowFeatureIssue.flowFeatures, undefined)
    assert.equal(firstIssue.historicalSuffix.evidenceCutoffUtc, savedPair(0).duration.issuedAtUtc)
    assert.equal(secondIssue.historicalSuffix.evidenceCutoffUtc, savedPair(1).duration.issuedAtUtc)
    assert.equal(firstIssue.historicalSuffix.receipts.length, 85)
    assert.equal(secondIssue.historicalSuffix.receipts.length, 86)
    for (const issue of [firstIssue, secondIssue]) {
      assert.equal(issue.historicalSuffix.completeToFirstLive, false)
      for (const horizon of ['24h', '7d']) {
        assert.equal(
          issue.historicalSuffix.maximumObservedCompleteWindow[horizon].status,
          'observed',
        )
        assert.equal(
          issue.historicalSuffix.maximumObservedCompleteWindowNetDepletion[horizon].status,
          'observed',
        )
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
