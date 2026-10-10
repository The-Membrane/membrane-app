import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'
import { summarize, verify as verifyCurrent } from './saturn-queue-pending-current.mjs'
import { verifyPending } from './saturn-queue-pending-terms.mjs'
import {
  buildSeriesRecord,
  summarizeGateChange,
  validateSeriesRecord,
  validateSeriesRecords,
  verifySeries,
} from './saturn-queue-pending-series.mjs'

const digest = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const reseal = (value) => {
  const { sha256: _, ...body } = value
  return { ...body, sha256: digest(body) }
}

async function context() {
  const [baseline, cohort, episodes] = await Promise.all([
    verifyCurrent(),
    verifyPending(),
    verifyEpisodes(),
  ])
  return { baseline, cohort, episodes }
}

function nextSnapshot(prior, edits = {}) {
  const body = {
    ...prior,
    capturedAtUtc: new Date(Date.parse(prior.capturedAtUtc) + 60_000).toISOString(),
    block: {
      number: prior.block.number + 1,
      hash: '0x' + 'b'.repeat(64),
      timestamp: prior.block.timestamp + 12,
    },
    rows: structuredClone(prior.rows),
    ...edits,
  }
  return reseal(body)
}

test('append-only series accepts a mutable price-gate margin, preserves 40 identities and verifies files', async () => {
  const evidence = await context()
  const snapshot = nextSnapshot(evidence.baseline)
  snapshot.rows[0].minSharePriceRaw = '0'
  snapshot.rows[0].belowMin = false
  snapshot.summary = summarize(snapshot.rows)
  const record = buildSeriesRecord(reseal(snapshot), null, evidence.baseline)
  assert.equal(record.sequence, 1)
  assert.equal(record.previousSha256, evidence.baseline.sha256)
  assert.doesNotThrow(() => validateSeriesRecord(record, { ...evidence, previous: null }))
  assert.equal(validateSeriesRecords([record], evidence).samples, 1)
  const directory = await mkdtemp(join(tmpdir(), 'saturn-pending-series-'))
  try {
    await writeFile(join(directory, '000001.json'), JSON.stringify(record) + '\n')
    const verified = await verifySeries(directory, evidence)
    assert.equal(verified.summary.lastSha256, record.sha256)
    assert.equal(verified.summary.requestedPriceGated, 39)
    await writeFile(join(directory, '000003.json'), JSON.stringify(record) + '\n')
    await assert.rejects(verifySeries(directory, evidence), /saturn_series_files_invalid/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('series rejects resealed wrong arithmetic and a terminal ticket reopening', async () => {
  const evidence = await context()
  const first = buildSeriesRecord(nextSnapshot(evidence.baseline), null, evidence.baseline)
  const badSnapshot = structuredClone(first.snapshot)
  badSnapshot.rows[0].belowMin = !badSnapshot.rows[0].belowMin
  badSnapshot.summary = summarize(badSnapshot.rows)
  const bad = buildSeriesRecord(reseal(badSnapshot), null, evidence.baseline)
  assert.throws(
    () => validateSeriesRecord(bad, { ...evidence, previous: null }),
    /saturn_current_ticket_mismatch/,
  )

  const terminalSnapshot = nextSnapshot(evidence.baseline)
  terminalSnapshot.rows[0].status = 2
  terminalSnapshot.rows[0].owner = null
  terminalSnapshot.rows[0].quoteUsdatRaw = null
  terminalSnapshot.rows[0].belowMin = null
  terminalSnapshot.summary = summarize(terminalSnapshot.rows)
  const terminal = buildSeriesRecord(reseal(terminalSnapshot), null, evidence.baseline)
  assert.doesNotThrow(() => validateSeriesRecord(terminal, { ...evidence, previous: null }))
  const reopenedSnapshot = nextSnapshot(terminal.snapshot, {
    block: {
      number: terminal.snapshot.block.number + 1,
      hash: '0x' + 'c'.repeat(64),
      timestamp: terminal.snapshot.block.timestamp + 12,
    },
  })
  reopenedSnapshot.rows[0] = structuredClone(evidence.baseline.rows[0])
  reopenedSnapshot.summary = summarize(reopenedSnapshot.rows)
  const reopened = buildSeriesRecord(reseal(reopenedSnapshot), terminal, evidence.baseline)
  assert.throws(
    () => validateSeriesRecord(reopened, { ...evidence, previous: terminal }),
    /saturn_series_transition_invalid/,
  )
})

test('series rejects duplicate finalized blocks, broken links and noncanonical files', async () => {
  const evidence = await context()
  const snapshot = nextSnapshot(evidence.baseline)
  const record = buildSeriesRecord(snapshot, null, evidence.baseline)
  const sameBlock = buildSeriesRecord(
    reseal({
      ...snapshot,
      block: { ...snapshot.block, number: evidence.baseline.block.number },
    }),
    null,
    evidence.baseline,
  )
  assert.throws(
    () => validateSeriesRecord(sameBlock, { ...evidence, previous: null }),
    /saturn_series_transition_invalid/,
  )
  assert.throws(
    () =>
      validateSeriesRecord(reseal({ ...record, previousSha256: 'f'.repeat(64) }), {
        ...evidence,
        previous: null,
      }),
    /saturn_series_record_invalid/,
  )
  const directory = await mkdtemp(join(tmpdir(), 'saturn-pending-series-'))
  try {
    await writeFile(join(directory, '000001.json'), JSON.stringify(record))
    await assert.rejects(verifySeries(directory, evidence), /saturn_series_file_invalid/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('gate changes separate a lost quote from deeper existing price deficits', async () => {
  const evidence = await context()
  const first = nextSnapshot(evidence.baseline)
  first.rows[0].minSharePriceRaw = '0'
  first.rows[0].belowMin = false
  first.summary = summarize(first.rows)
  const firstRecord = buildSeriesRecord(reseal(first), null, evidence.baseline)
  const second = nextSnapshot(firstRecord.snapshot, {
    block: {
      number: firstRecord.snapshot.block.number + 1,
      hash: '0x' + 'c'.repeat(64),
      timestamp: firstRecord.snapshot.block.timestamp + 12,
    },
  })
  second.rows[0].minSharePriceRaw = evidence.baseline.rows[0].minSharePriceRaw
  second.rows[0].belowMin = true
  second.rows[1].minSharePriceRaw = (BigInt(second.rows[1].minSharePriceRaw) + 1n).toString()
  second.summary = summarize(second.rows)
  const secondRecord = buildSeriesRecord(reseal(second), firstRecord, evidence.baseline)
  assert.doesNotThrow(() => validateSeriesRecords([firstRecord, secondRecord], evidence))
  assert.deepEqual(summarizeGateChange(firstRecord.snapshot, secondRecord.snapshot), {
    previousBlock: firstRecord.snapshot.block.number,
    previousEvidenceSha256: firstRecord.snapshot.sha256,
    newlyGated: 1,
    newlyQuoteEligible: 0,
    stillGatedDeeper: 1,
  })
})
