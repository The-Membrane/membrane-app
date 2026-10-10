import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activePendingIssues,
  runTargetWindowPass,
  scoreSelectedQuote,
  selectedPair,
} from './scrvusd-target-window-capture.mjs'

const base = Date.parse('2026-09-28T12:00:00.000Z')
const iso = (offset) => new Date(base + offset * 1000).toISOString()
const issue = {
  issuedAtUtc: iso(-3600),
  targetUtc: iso(0),
  holder: `0x${'a'.repeat(40)}`,
  qAssetsRaw: '100',
  outcomeProtocol: {
    checkpointSelection: { windowSeconds: 1800, captureDeadlineUtc: iso(5400) },
  },
}
const quote = (number, offset, captured = offset + 10) => ({
  checkpoint: {
    block: {
      number,
      hash: `0x${String(number).padStart(64, '0')}`,
      timestamp: (base + offset * 1000) / 1000,
    },
    captureEndUtc: iso(captured),
  },
})

test('active pass includes pending v1 and v2 only from target -30m through +90m', () => {
  const v1 = [{ filename: 'a', issue }]
  const v2 = [{ filename: 'b', issue }]
  assert.equal(activePendingIssues({ v1, v2, nowUtc: iso(-1800) }).length, 2)
  assert.equal(activePendingIssues({ v1, v2, nowUtc: iso(5400) }).length, 2)
  assert.equal(activePendingIssues({ v1, v2, nowUtc: iso(-1801) }).length, 0)
  assert.equal(activePendingIssues({ v1, v2, nowUtc: iso(5401) }).length, 0)
})

test('target choice follows score timestamp distance, tie then earlier block; late capture excluded', () => {
  const rows = [quote(10, -100), quote(11, 100), quote(12, 20, 5401)]
  assert.equal(scoreSelectedQuote(issue, rows).checkpoint.block.number, 10)
  assert.equal(scoreSelectedQuote(issue, [quote(1, -1801), quote(2, 1801)]), null)
})

test('pairing requires the selected exact block, matching holder/amount, and on-time probe', () => {
  const selected = quote(10, 0)
  const holder = (block, captured = 20, qAssetsRaw = '100') => ({
    issue: {
      checkpoint: block.checkpoint,
      holder: issue.holder,
      rawCrvUsd: qAssetsRaw,
      captureEndUtc: iso(captured),
      result: { status: 'revert' },
    },
  })
  assert.equal(
    selectedPair(issue, selected, [holder(quote(11, 10))]).status,
    'missing_holder_observation',
  )
  assert.equal(
    selectedPair(issue, selected, [holder(selected, 5401)]).status,
    'missing_holder_observation',
  )
  assert.equal(selectedPair(issue, selected, [holder(selected)]).status, 'paired')
  assert.throws(
    () => selectedPair(issue, selected, [holder(selected, 20, '101')]),
    /different holder/,
  )
})

test('disk-reserve quote failure yields missing pair and partial top-level capture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scrvusd-target-window-'))
  try {
    const client = {
      request: async () => {
        throw new Error('RPC should not run')
      },
    }
    const result = await runTargetWindowPass({
      now: () => new Date(iso(0)),
      quoteClient: client,
      holderClient: client,
      lockPath: join(dir, 'pass.lock'),
      loadPending: async () => [{ filename: 'pending.json', issue, lane: 'v1' }],
      collectQuote: async () => {
        throw { reason: 'disk_reserve' }
      },
      readCheckpoints: () => [],
    })
    assert.equal(result.status, 'partial')
    assert.equal(result.stage.quote, 'disk_reserve')
    assert.equal(result.missingPairCount, 1)
    assert.deepEqual(result.failureReasons, ['disk_reserve', 'missing_quote_checkpoint'])
    assert.equal(result.pairs[0].status, 'missing_quote_checkpoint')
    assert.equal(result.forecastEligible, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
