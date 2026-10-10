import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sourceIdentity } from './curve-vault-flow-ledger.mjs'
import { OUT } from './curve-vault-flow-near-live.mjs'
import { buildReference, reference } from './curve-vault-flow-reference.mjs'

const source = sourceIdentity()
const start = 1_788_000_000
const event = (kind, second, amount, logIndex) => ({
  kind,
  assetsRaw: String(BigInt(amount) * 10n ** 18n),
  blockTimestamp: second,
  blockNumber: logIndex + 1,
  logIndex,
})
const receipt = (throughSecond, events = []) => ({
  sha256: 'c'.repeat(64),
  range: {
    from: { number: 1, timestamp: start },
    to: { number: 2, timestamp: throughSecond },
  },
  events,
  captureEndUtc: '2026-09-28T00:01:00.000Z',
})
const plan = {
  sha256: 'a'.repeat(64),
  capturedAtUtc: '2026-09-28T00:00:00.000Z',
  start: { number: 1 },
  end: { number: 100 },
}
const asOfUtc = '2026-09-28T00:03:00.000Z'
const planPhysicalSha256 = 'd'.repeat(64)
const sourceInputs = [
  {
    fromBlock: 1,
    throughBlock: 2,
    receiptLogicalSha256: 'c'.repeat(64),
    receiptPhysicalSha256: 'e'.repeat(64),
    witnessLogicalSha256: 'f'.repeat(64),
    witnessPhysicalSha256: '0'.repeat(64),
    witnessCapturedAtUtc: '2026-09-28T00:02:00.000Z',
  },
]

test('incomplete windows stay unavailable and archive remains disjoint', () => {
  const value = buildReference({
    receipts: [receipt(start + 60, [])],
    plan,
    planPhysicalSha256,
    source,
    asOfUtc,
    sourceInputs,
  })
  assert.equal(value.firstKnownAtUtc, sourceInputs[0].witnessCapturedAtUtc)
  assert.equal(value.completeWindowSupport['24h'].possibleCompleteStartSeconds, 0)
  assert.equal(value.maximumObservedCompleteWindowGrossWithdrawal['24h'].status, 'unavailable')
  assert.equal(value.maximumObservedCompleteWindowSignedNetDepletion['7d'].status, 'unavailable')
  assert.equal(value.bridge.joinedToLiveLedger, false)
  assert.equal(value.bridge.blocksRemainingToPlannedBridge, 98)
  assert.equal(value.sourceSpan.throughBlock, 2)
})

test('complete windows report gross and separately optimized signed net, including a negative maximum', () => {
  const value = buildReference({
    receipts: [
      receipt(start + 86_400, [
        event('deposit', start + 100, 10, 0),
        event('withdraw', start + 200, 2, 1),
      ]),
    ],
    plan,
    planPhysicalSha256,
    source,
    asOfUtc,
    sourceInputs,
  })
  assert.equal(value.completeWindowSupport['24h'].possibleCompleteStartSeconds, 2)
  assert.equal(
    value.maximumObservedCompleteWindowGrossWithdrawal['24h'].grossWithdrawalsCrvUsd,
    '2',
  )
  assert.equal(
    value.maximumObservedCompleteWindowSignedNetDepletion['24h'].netDepletionRaw,
    String(-8n * 10n ** 18n),
  )
  assert.equal(value.maximumObservedCompleteWindowGrossWithdrawal['7d'].status, 'unavailable')
  assert.equal(value.maximumObservedCompleteWindowSignedNetDepletion['7d'].status, 'unavailable')
})

test('capture cutoff refuses future plan, receipt, and witness', () => {
  const base = {
    receipts: [receipt(start + 10)],
    plan,
    planPhysicalSha256,
    source,
    asOfUtc,
    sourceInputs,
  }
  assert.throws(() => buildReference({ ...base, asOfUtc: '2026-09-27T23:59:59.000Z' }), /Future/)
  assert.throws(() => buildReference({ ...base, asOfUtc: '2026-09-28T00:01:30.000Z' }), /Future/)
  assert.throws(() => buildReference({ ...base, sourceInputs: [] }), /Source input count/)
  assert.throws(() => buildReference({ ...base, asOfUtc: 'bad' }), /Invalid as-of/)
  assert.throws(
    () => buildReference({ ...base, asOfUtc: '2026-09-27T20:03:00-04:00' }),
    /Invalid as-of/,
  )
})

test('a future block is excluded even when its receipt and witness captures are backdated', () => {
  const futureBlock = Math.floor(Date.parse(asOfUtc) / 1000) + 1
  assert.throws(
    () =>
      buildReference({
        receipts: [receipt(futureBlock)],
        plan,
        planPhysicalSha256,
        source,
        asOfUtc,
        sourceInputs,
      }),
    /Future or invalid receipt block/,
  )
  assert.throws(
    () =>
      buildReference({
        receipts: [receipt(start - 1)],
        plan,
        planPhysicalSha256,
        source,
        asOfUtc,
        sourceInputs,
      }),
    /Future or invalid receipt block/,
  )
})

test('real sealed prefix uses only receipts known as of cutoff and rejects physical tampering', (t) => {
  if (!existsSync(join(OUT, 'plan.json'))) return t.skip('Local sealed suffix unavailable')
  const out = mkdtempSync(join(tmpdir(), 'flow-reference-'))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  cpSync(join(OUT, 'plan.json'), join(out, 'plan.json'))
  const receiptFile = readdirSync(join(OUT, 'receipts')).sort()[0]
  const witnessFile = readdirSync(join(OUT, 'boundaries')).sort()[0]
  cpSync(join(OUT, 'receipts', receiptFile), join(out, 'receipts', receiptFile), {
    recursive: true,
  })
  cpSync(join(OUT, 'boundaries', witnessFile), join(out, 'boundaries', witnessFile), {
    recursive: true,
  })
  const first = reference({ out, source, asOfUtc: '2026-09-28T00:03:00.000Z' })
  const repeated = reference({ out, source, asOfUtc: '2026-09-28T00:03:00.000Z' })
  assert.deepEqual(repeated, first)
  const { sha256, ...payload } = first
  assert.equal(sha256, createHash('sha256').update(JSON.stringify(payload)).digest('hex'))
  assert.equal(first.sourceInputs.length, 1)
  assert.equal(
    first.sourceInputs[0].receiptPhysicalSha256,
    createHash('sha256')
      .update(readFileSync(join(out, 'receipts', receiptFile)))
      .digest('hex'),
  )
  assert.equal(
    first.sourceInputs[0].witnessPhysicalSha256,
    createHash('sha256')
      .update(readFileSync(join(out, 'boundaries', witnessFile)))
      .digest('hex'),
  )
  assert.equal(first.sourceSpan.receiptCount, 1)
  assert.equal(first.bridge.joinedToLiveLedger, false)
  assert.equal(first.maximumObservedCompleteWindowGrossWithdrawal['24h'].status, 'unavailable')
  const before = reference({ out, source, asOfUtc: '2026-09-27T21:23:32.738Z' })
  assert.equal(before.sourceSpan, null)
  assert.equal(before.completeWindowSupport['24h'].possibleCompleteStartSeconds, 0)
  const path = join(out, 'boundaries', witnessFile)
  const originalWitness = readFileSync(path, 'utf8')
  writeFileSync(path, originalWitness.replace('capturedAtUtc', 'captureAtUtc'))
  assert.throws(() => reference({ out, source, asOfUtc }), /seal|witness/i)
  writeFileSync(path, originalWitness)
  const receiptPath = join(out, 'receipts', receiptFile)
  writeFileSync(receiptPath, `${readFileSync(receiptPath, 'utf8')} `)
  assert.throws(() => reference({ out, source, asOfUtc }), /physical|witness/i)
})
