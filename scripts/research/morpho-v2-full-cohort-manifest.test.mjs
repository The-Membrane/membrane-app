import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { eventKey } from './morpho-v2-cap-lifecycle-census.mjs'
import {
  buildManifest,
  controlRiskSet,
  horizonStatus,
  load,
  paths,
  readHead,
} from './morpho-v2-full-cohort-manifest.mjs'

const DAY = 86_400
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222'
const C = '0x3333333333333333333333333333333333333333'
const D = '0x4444444444444444444444444444444444444444'
const asset = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const anchor = { vault: A, block: 100, timestamp: 20 * DAY }
const factory = [
  { vault: A, asset, block: 10, timestamp: 10 * DAY },
  { vault: B, asset, block: 11, timestamp: 11 * DAY },
  { vault: C, asset, block: 12, timestamp: 12 * DAY },
  { vault: D, asset, block: 13, timestamp: 13 * DAY },
]
const prior = (vault, timestamp) => ({
  vault,
  selector: '0xf6f98fd5',
  data: '0xf6f98fd500',
  timestamp,
  block: timestamp / DAY,
  executableAt: anchor.timestamp - 1,
})

test('overdue pending full-key cycle excluded; settled future-clock cycle stays eligible', () => {
  const pending = prior(B, DAY)
  const settled = { ...prior(C, 2 * DAY), executableAt: anchor.timestamp + DAY }
  const recent = prior(D, 19 * DAY)
  const row = controlRiskSet({
    factoryEvents: factory,
    priorByVault: new Map([
      [B, [pending]],
      [C, [settled]],
      [D, [recent]],
    ]),
    state: new Map([
      [eventKey(pending), { pending: true, ambiguous: false }],
      [eventKey(settled), { pending: false, ambiguous: false }],
      [eventKey(recent), { pending: false, ambiguous: false }],
    ]),
    anchor,
    treatedCreation: factory[0],
  })
  assert.deepEqual(row.counts, {
    sameAssetPreAnchor: 3,
    recentSevenDay: 1,
    pending: 1,
    ambiguous: 0,
    clean: 1,
  })
  assert.deepEqual(
    row.firstCleanCandidates.map((x) => x.vault),
    [C],
  )
  assert.equal(row.nextCleanOffset, null)
})

test('missing replay state is ambiguous, never a clean control', () => {
  const missing = prior(B, DAY)
  const row = controlRiskSet({
    factoryEvents: factory.slice(0, 2),
    priorByVault: new Map([[B, [missing]]]),
    state: new Map(),
    anchor,
    treatedCreation: factory[0],
  })
  assert.equal(row.counts.ambiguous, 1)
  assert.equal(row.counts.clean, 0)
})

test('horizons are measured from earliest executable clock and head truncation is censoring', () => {
  assert.deepEqual(horizonStatus(100, 100 + DAY), {
    plus24h: { targetTimestamp: 100 + DAY, status: 'available' },
    plus7d: { targetTimestamp: 100 + 7 * DAY, status: 'head-censored' },
  })
  assert.equal(horizonStatus(100, 99).plus24h.status, 'head-censored')
})

test('head timestamp requires the pinned physical source SHA, not caller-provided metadata', () => {
  const bytes = readFileSync(paths().headPath)
  assert.equal(readHead(bytes).block, 26_052_740)
  assert.throws(() => readHead(Buffer.from(bytes.toString().replace('1790318495', '1790318496'))))
})

test('real frozen sources produce all 304 rows, exact censor totals, bounded pagination, and a stable seal', () => {
  const inputs = load()
  const result = buildManifest(inputs)
  assert.equal(result.rows.length, 304)
  assert.equal(result.summary.uniqueVaults, 124)
  assert.equal(result.summary.plus24hAvailable, 297)
  assert.equal(result.summary.plus7dAvailable, 286)
  assert.equal(result.summary.noCleanControl, 6)
  assert.equal(result.summary.sameAssetPreAnchorPairs, 55_017)
  assert.equal(result.summary.recentSevenDayPairs, 2_655)
  assert.ok(result.rows.every((row) => row.controls.firstCleanCandidates.length <= 32))
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2 * 1024 * 1024)
  const { checkpointSha256, ...unsigned } = result
  assert.equal(
    checkpointSha256,
    createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
  )
})
