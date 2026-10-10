import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { COST_LEVELS_PCT } from './depthCurve.mjs'
import {
  appendLocalVenueCurvePass,
  readLocalVenueCurvePasses,
  validateLocalVenueCurvePass,
  MAX_LOCAL_CURVE_RECORD_BYTES,
} from './localVenueCurveStore.mjs'

const roots = []
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'local-curve-test-'))
  roots.push(path)
  return path
}
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
const ampleDisk = () => ({ bavail: 1_000_000, bsize: 4096 })
const date = (hour, seconds = 0) => new Date(Date.UTC(2026, 9, 1, hour, 0, seconds))
const input = (hour = 0) => ({
  venue: 'scrvUSD',
  chainId: 1,
  block: String(100 + hour),
  sourceBlockHash: `0x${String(hour + 1).padStart(64, '0')}`,
  sourceBlockTime: date(hour).toISOString(),
  observedAtUtc: date(hour, 30).toISOString(),
  finalized: true,
  pinned: true,
  expectedIdentities: { poolA: 'a'.repeat(64), poolB: 'b'.repeat(64) },
  markets: ['poolB', 'poolA'].map((market) => ({
    market,
    configIdentity: (market === 'poolA' ? 'a' : 'b').repeat(64),
    points: COST_LEVELS_PCT.map((costPct, index) => ({ costPct, capacityUsd: index * 100 })),
  })),
})
const append = (path, hour = 0, options = {}) =>
  appendLocalVenueCurvePass(input(hour), {
    root: path,
    now: () => date(hour, 40),
    stat: ampleDisk,
    ...options,
  })
const rewriteDigest = (record) => {
  const { sha256: _old, ...body } = record
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}

test('complete passes preserve exact quotes/source/config and first receipt independently', () => {
  const path = root()
  const first = append(path)
  const second = append(path, 1)
  assert.equal(first.status, 'appended')
  assert.deepEqual(first.record.pass, validateLocalVenueCurvePass(input()))
  assert.equal(first.record.firstLocalReceiptAtUtc, date(0, 40).toISOString())
  assert.equal(second.record.prevSha256, first.record.sha256)
  const read = readLocalVenueCurvePasses('scrvUSD', { root: path })
  assert.deepEqual(
    read.records.map((record) => record.sequence),
    [2, 1],
  )
  assert.equal(read.verification, 'from_local_start')
  assert.equal(read.truncated, false)
  const before = readFileSync(join(path, 'scrvUSD.jsonl'))
  const repeat = append(path, 1, { now: () => date(2) })
  assert.equal(repeat.status, 'already_recorded')
  assert.equal(repeat.record.firstLocalReceiptAtUtc, second.record.firstLocalReceiptAtUtc)
  assert.deepEqual(readFileSync(join(path, 'scrvUSD.jsonl')), before)
})

test('incomplete levels, market/config mismatches, null quotes, unpinned or future source fail closed', () => {
  for (const mutate of [
    (pass) => pass.markets.pop(),
    (pass) => pass.markets[0].points.pop(),
    (pass) => {
      pass.markets[0].points[3].capacityUsd = null
    },
    (pass) => {
      pass.markets[0].configIdentity = 'c'.repeat(64)
    },
    (pass) => {
      pass.markets[0].points[3].costPct = 0.75
    },
    (pass) => {
      pass.markets[0].points[3].capacityUsd = -1
    },
    (pass) => {
      pass.pinned = false
    },
    (pass) => {
      pass.sourceBlockTime = date(1).toISOString()
    },
  ]) {
    const pass = input()
    mutate(pass)
    assert.throws(() => appendLocalVenueCurvePass(pass, { root: root() }), /local_curve_/)
  }
})

test('digest damage, missing links, changed sequence and partial writes are visible failures', () => {
  for (const mutate of [
    (records) => {
      records[1].pass.markets[0].points[3].capacityUsd += 1
    },
    (records) => {
      records[1].prevSha256 = 'c'.repeat(64)
      records[1] = rewriteDigest(records[1])
    },
    (records) => {
      records[1].sequence = 4
      records[1] = rewriteDigest(records[1])
    },
  ]) {
    const path = root()
    append(path)
    append(path, 1)
    const file = join(path, 'scrvUSD.jsonl')
    const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
    mutate(records)
    writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    assert.throws(() => readLocalVenueCurvePasses('scrvUSD', { root: path }), /local_curve_/)
  }
  const path = root()
  append(path)
  appendFileSync(join(path, 'scrvUSD.jsonl'), '{')
  assert.throws(() => readLocalVenueCurvePasses('scrvUSD', { root: path }), /partial_tail/)
})

test('bounded tail verifies its adjacent anchor and reports an unverified older prefix honestly', () => {
  const path = root()
  for (let hour = 0; hour < 25; hour++) append(path, hour)
  const result = readLocalVenueCurvePasses('scrvUSD', { root: path, limit: 2 })
  assert.deepEqual(
    result.records.map((record) => record.sequence),
    [25, 24],
  )
  assert.equal(result.truncated, true)
  assert.equal(result.verification, 'bounded_tail_links')
  assert.ok(result.bytesRead <= 4 * MAX_LOCAL_CURVE_RECORD_BYTES)
  assert.throws(
    () => readLocalVenueCurvePasses('scrvUSD', { root: path, limit: 21 }),
    /read_options/,
  )
})

test('file cap returns typed stop without truncation; reserve and live writer lock remain enforced', () => {
  const path = root()
  append(path)
  const file = join(path, 'scrvUSD.jsonl')
  const before = readFileSync(file)
  assert.deepEqual(append(path, 1, { maxFileBytes: before.length + 1 }), {
    status: 'unavailable',
    reason: 'local_curve_file_limit',
    record: null,
  })
  assert.deepEqual(readFileSync(file), before)
  assert.throws(() => append(path, 1, { stat: () => ({ bavail: 1, bsize: 4096 }) }), /disk_reserve/)
  writeFileSync(join(path, 'scrvUSD.lock'), `${process.pid}\n`)
  assert.throws(() => append(path, 1), /writer_locked/)
  writeFileSync(join(path, 'scrvUSD.lock'), '999999999\n')
  assert.throws(() => append(path, 1), /writer_locked/)
  rmSync(join(path, 'scrvUSD.lock'))
  assert.equal(append(path, 1).status, 'appended')
})

test('source/receipt clocks must advance and symlink ledgers are rejected', () => {
  const path = root()
  append(path)
  assert.throws(() => append(path, 1, { now: () => date(0) }), /receipt_clock_order/)
  const pass = input(1)
  pass.sourceBlockTime = date(0).toISOString()
  assert.throws(
    () =>
      appendLocalVenueCurvePass(pass, {
        root: path,
        now: () => date(1, 40),
        stat: ampleDisk,
      }),
    /source_clock_order/,
  )
  const other = root()
  symlinkSync(join(path, 'scrvUSD.jsonl'), join(other, 'scrvUSD.jsonl'))
  assert.throws(() => readLocalVenueCurvePasses('scrvUSD', { root: other }))
  assert.throws(() => append(other, 1))
})
