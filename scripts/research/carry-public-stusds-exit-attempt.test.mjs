import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { tickStusds, verifyStusdsAttempts } from './carry-public-stusds-exit-attempt.mjs'

test('private run receipts bind issued records and disclose no holder or Q', async () => {
  const out = await mkdtemp(join(tmpdir(), 'stusds-attempt-'))
  const holder = `0x${'d'.repeat(40)}`
  const issues = []
  const scores = []
  let clock = Date.parse('2026-10-01T01:00:00.000Z')
  const base = {
    out,
    now: () => new Date(clock++),
    urls: ['https://one.example', 'https://two.example'],
    clientsFor: (urls) => urls.map((url) => ({ provider: url, url })),
    loadIssues: async () => issues,
    loadScores: async () => scores,
  }
  try {
    const result = await tickStusds('issue', {
      ...base,
      issue: async () => {
        issues.push({ sequence: 1, sha256: 'a'.repeat(64), holder, assetsRaw: '1000000' })
      },
    })
    assert.deepEqual(result, { status: 'completed', due: 1, attempted: 1, sealed: 1 })
    const noDue = await tickStusds('score', {
      ...base,
      score: async () => ({ due: 0, attempted: 0 }),
    })
    assert.equal(noDue.status, 'nothing_due')
    const { attempts } = await verifyStusdsAttempts(out, base.loadIssues, base.loadScores)
    assert.equal(attempts.length, 2)
    const json = JSON.stringify(attempts)
    assert.ok(!json.includes(holder))
    assert.ok(!json.includes('1000000'))
    const path = join(out, '00000001.json')
    const tampered = (await readFile(path, 'utf8')).replace('completed', 'failed')
    await writeFile(path, tampered)
    await assert.rejects(
      verifyStusdsAttempts(out, base.loadIssues, base.loadScores),
      /stusds_ledger_chain_invalid/,
    )
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('no fresh holder is a sealed no-issue attempt, not a duplicate cohort', async () => {
  const out = await mkdtemp(join(tmpdir(), 'stusds-no-fresh-'))
  try {
    const result = await tickStusds('issue', {
      out,
      urls: ['https://one.example', 'https://two.example'],
      clientsFor: (urls) => urls.map((url) => ({ provider: url, url })),
      loadIssues: async () => [],
      loadScores: async () => [],
      issue: async () => {
        throw Error('stusds_no_fresh_holder')
      },
    })
    assert.deepEqual(result, { status: 'no_fresh_holder', due: 1, attempted: 1, sealed: 0 })
    const state = await verifyStusdsAttempts(
      out,
      async () => [],
      async () => [],
    )
    assert.equal(state.attempts[0].status, 'no_fresh_holder')
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('all-retry score sweep seals a failed attempt and never reports completed', async () => {
  const out = await mkdtemp(join(tmpdir(), 'stusds-score-retry-'))
  try {
    await assert.rejects(
      tickStusds('score', {
        out,
        urls: ['https://one.example', 'https://two.example'],
        loadIssues: async () => [],
        loadScores: async () => [],
        score: async () => ({ due: 2, attempted: 2, scored: 0, retries: 2 }),
      }),
      /stusds_score_retries_exhausted/,
    )
    const { attempts } = await verifyStusdsAttempts(
      out,
      async () => [],
      async () => [],
    )
    assert.equal(attempts[0].status, 'failed')
    assert.equal(attempts[0].failure, 'stusds_score_retries_exhausted')
    assert.equal(attempts[0].records.length, 0)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})
