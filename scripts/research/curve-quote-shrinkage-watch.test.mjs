import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PARTS,
  routesFromParts,
  sourceIdentity,
  STUDY as QUOTE_STUDY,
} from './curve-prospective-quote.mjs'
import { analyze, assessPair, DEFAULT_MAX_GAP_SECONDS } from './curve-quote-shrinkage-watch.mjs'

const source = sourceIdentity()
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const start = 1_780_000_000

function fixture(number, timestamp, lossUsd = 0) {
  const loss = BigInt(lossUsd * 1e6)
  const parts = Array.from({ length: 2 }, () =>
    PARTS.map((part) => String(BigInt(part) * 1_000_000n - (loss * BigInt(part)) / 1_000_000n)),
  )
  const checkpoint = {
    study: QUOTE_STUDY,
    source,
    captureStartUtc: new Date((timestamp + 60) * 1000).toISOString(),
    captureEndUtc: new Date((timestamp + 61) * 1000).toISOString(),
    block: { number, hash: `0x${number.toString(16).padStart(64, '0')}`, timestamp },
    pinMode: 'hash',
    pinCaveat: null,
    raw: { vaultAssetsCrvUsd: '1000000000000000000', parts },
    routes: routesFromParts(parts),
  }
  const sealed = { ...checkpoint, sha256: sha(JSON.stringify(checkpoint)) }
  return { checkpoint, sealed, physicalSha256: sha(JSON.stringify(sealed) + '\n') }
}

function put(out, row) {
  const p = row.checkpoint
  const path = join(
    out,
    `${String(p.block.number).padStart(12, '0')}-${p.block.hash.slice(2)}.json`,
  )
  writeFileSync(path, JSON.stringify(row.sealed) + '\n')
  return path
}

test('threshold equality is a measured 10 bp $1m deterioration', () => {
  const prior = fixture(100, start)
  const current = fixture(101, start + 3600, 1000)
  const result = assessPair(prior, current)
  assert.equal(result.status, 'deteriorating')
  assert.equal(result.nominalOutputChangeUsd, -1000)
  assert.equal(result.quoteChange, -0.001)
  assert.equal(result.absoluteDeteriorationBpsOfInput, 10)
  assert.equal(result.relativeOutputChangeBps, -10)
  assert.equal(result.previous.blockHash, prior.checkpoint.block.hash)
  assert.equal(result.current.blockTimeUtc, new Date((start + 3600) * 1000).toISOString())
  assert.equal(result.current.sourceIdentitySha256, source.identitySha256)
  assert.match(result.current.quoteSource, /get_dy/)
  assert.equal(assessPair(prior, current, { thresholdBps: 11 }).status, 'stable')
})

test('threshold-sized improvement, unchanged quotes, gaps, nonadvancing blocks, and zero quotes', () => {
  const prior = fixture(100, start, 1000)
  const improvement = assessPair(prior, fixture(101, start + 100, 0))
  assert.equal(improvement.status, 'improving')
  assert.equal(improvement.absoluteImprovementBpsOfInput, 10)
  assert.equal(assessPair(prior, fixture(101, start + 100, 1000)).status, 'stable')
  const gap = assessPair(prior, fixture(101, start + DEFAULT_MAX_GAP_SECONDS + 1, 2000))
  assert.equal(gap.status, 'unavailable')
  assert.equal(gap.reason, 'observation_gap')
  assert.equal(
    assessPair(prior, fixture(100, start + 100, 2000)).reason,
    'nonadvancing_finalized_block',
  )
  assert.equal(assessPair(prior, fixture(101, start, 2000)).reason, 'nonadvancing_finalized_block')
  assert.equal(assessPair(prior, fixture(101, start + 100, 1_000_000)).reason, 'zero_quote')
  assert.throws(
    () => assessPair(prior, fixture(101, start + 100), { thresholdBps: 0 }),
    /threshold/,
  )
})

test('offline report reads validated receipts, is repeatable, and rejects tampering', () => {
  const out = mkdtempSync(join(tmpdir(), 'curve-shrinkage-'))
  const first = fixture(100, start)
  const second = fixture(101, start + 3600, 1000)
  const third = fixture(102, start + 7200, 0)
  put(out, first)
  put(out, second)
  const path = put(out, third)
  const options = { out, now: () => new Date((start + 7320) * 1000) }
  const result = analyze(options)
  assert.deepEqual(analyze(options), result)
  assert.equal(result.checkpointCount, 3)
  assert.equal(result.comparedPairs, 2)
  assert.equal(result.deterioratingPairs, 1)
  assert.equal(result.latest.status, 'improving')
  assert.equal(result.latest.previous.physicalSha256, second.physicalSha256)

  const saved = JSON.parse(readFileSync(path, 'utf8'))
  saved.raw.parts[0][0] = '0'
  writeFileSync(path, JSON.stringify(saved) + '\n')
  assert.throws(() => analyze(options), /SHA mismatch/)
})

test('a small positive $1m quote change remains stable with its exact signed delta', () => {
  const before = fixture(100, start, 0)
  const after = fixture(101, start + 64 * 60, -0.040913)
  const result = assessPair(before, after)
  assert.equal(result.status, 'stable')
  assert.equal(result.nominalOutputChangeUsd, 0.040913)
  assert.equal(result.absoluteImprovementBpsOfInput, 0.00040913)
  assert.equal(assessPair(before, fixture(101, start + 64 * 60, -999.999999)).status, 'stable')
  assert.equal(assessPair(before, fixture(101, start + 64 * 60, -1000)).status, 'improving')
})

test('reports an unavailable latest state with fewer than two checkpoints', () => {
  const out = mkdtempSync(join(tmpdir(), 'curve-shrinkage-empty-'))
  const options = { out, now: () => new Date((start + 120) * 1000) }
  assert.equal(analyze(options).latest.reason, 'insufficient_checkpoints')
  put(out, fixture(100, start))
  const latest = analyze(options).latest
  assert.equal(latest.reason, 'insufficient_checkpoints')
  assert.equal(latest.latestCheckpoint.block, 100)
})

test('a historical deterioration expires when both collection and block time become stale', () => {
  const out = mkdtempSync(join(tmpdir(), 'curve-shrinkage-stale-'))
  put(out, fixture(100, start))
  put(out, fixture(101, start + 3600, 1000))
  const near = analyze({ out, now: () => new Date((start + 3700) * 1000) })
  assert.equal(near.latest.status, 'deteriorating')
  const stale = analyze({ out, now: () => new Date((start + 3600 + 7201) * 1000) })
  assert.equal(stale.latest.status, 'unavailable')
  assert.equal(stale.latest.reason, 'stale_checkpoint')
  assert.equal(stale.latestHistorical.status, 'deteriorating')
  assert.equal(stale.latest.lastObserved.current.block, 101)
  assert.equal(stale.freshnessSeconds, 7200)
})
