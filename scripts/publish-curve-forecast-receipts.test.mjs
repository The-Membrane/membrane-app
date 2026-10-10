import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  forecastPublishDatabaseUrl,
  publishVerifiedRows,
  receiptToRow,
} from './publish-curve-forecast-receipts.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const block = { number: 26_100_000, hash: `0x${'a'.repeat(64)}`, timestamp: 1_790_600_000 }
const captured = {
  study: 'curve-crvusd-secondary-prospective-quote-v1',
  block,
  captureStartUtc: new Date(block.timestamp * 1000 + 1_000).toISOString(),
  captureEndUtc: new Date(block.timestamp * 1000 + 2_000).toISOString(),
}
const checkpoint = {
  checkpoint: captured,
  filename: 'checkpoint.json',
  physicalSha256: sha('physical-checkpoint'),
}
const issue = {
  study: 'curve-crvusd-secondary-prospective-forecast-v1',
  issuedAtUtc: new Date(block.timestamp * 1000 + 3_000).toISOString(),
  source: {
    checkpointFilename: checkpoint.filename,
    checkpointPhysicalSha256: checkpoint.physicalSha256,
    checkpointSha256: sha(JSON.stringify(captured)),
  },
  block,
  horizonHours: 24,
  currentQuote: 0.999,
  status: 'unavailable',
  reason: 'insufficient_history',
}
const sealed = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const filename = `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}-24h.json`
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`)

test('publisher requires its explicit role URL and ignores generic app credentials', () => {
  const generic = {
    DATABASE_URL: 'postgresql://generic@localhost/test',
    DATABASE_URL_UNPOOLED: 'postgresql://generic-unpooled@localhost/test',
  }
  assert.throws(
    () => forecastPublishDatabaseUrl({ env: generic, get: () => undefined }),
    /FORECAST_PUBLISH_DATABASE_URL is required/,
  )
  assert.equal(
    forecastPublishDatabaseUrl({
      env: { ...generic, FORECAST_PUBLISH_DATABASE_URL: 'postgresql://publisher@localhost/test' },
      get: () => undefined,
    }),
    'postgresql://publisher@localhost/test',
  )
})

test('receipt bridge retains immutable provenance and allows only forecast fields', () => {
  const row = receiptToRow({
    bytes: bytes(sealed({ ...issue, secret: 'must-not-publish' })),
    filename,
    study: issue.study,
    checkpoint,
  })
  assert.equal(row.sourceCheckpointSha256, sha(JSON.stringify(captured)))
  assert.equal(
    row.artifactPhysicalSha256,
    sha(bytes(sealed({ ...issue, secret: 'must-not-publish' }))),
  )
  assert.equal(row.payload.secret, undefined)
  assert.equal(row.receiptKey, `point_issue:${filename}`)
  const sealedCheckpoint = {
    ...checkpoint,
    checkpoint: { ...captured, sha256: sha(JSON.stringify(captured)) },
  }
  const withLogicalSeal = receiptToRow({
    bytes: bytes(sealed(issue)),
    filename,
    study: issue.study,
    checkpoint: sealedCheckpoint,
  })
  assert.equal(withLogicalSeal.sourceCheckpointSha256, sha(JSON.stringify(captured)))
  assert.throws(
    () =>
      receiptToRow({
        bytes: bytes(sealed(issue)),
        filename,
        study: issue.study,
        checkpoint: { ...checkpoint, checkpoint: { ...captured, sha256: sha('wrong') } },
      }),
    /provenance/,
  )
})

test('tampered seal, source and impossible chronology fail before publication', async () => {
  const badSeal = sealed(issue)
  badSeal.status = 'research_forecast'
  assert.throws(
    () => receiptToRow({ bytes: bytes(badSeal), filename, study: issue.study, checkpoint }),
    /provenance/,
  )

  const badSource = sealed({
    ...issue,
    source: { ...issue.source, checkpointPhysicalSha256: sha('other') },
  })
  assert.throws(
    () => receiptToRow({ bytes: bytes(badSource), filename, study: issue.study, checkpoint }),
    /provenance/,
  )

  const badTime = sealed({ ...issue, issuedAtUtc: new Date(block.timestamp * 1000).toISOString() })
  assert.throws(
    () => receiptToRow({ bytes: bytes(badTime), filename, study: issue.study, checkpoint }),
    /chronology/,
  )

  let connections = 0
  await assert.rejects(
    publishVerifiedRows({
      collect: () =>
        receiptToRow({ bytes: bytes(badSeal), filename, study: issue.study, checkpoint }),
      connect: async () => {
        connections++
        return () => []
      },
    }),
    /provenance/,
  )
  assert.equal(connections, 0)
})

test('fake database preserves equal replay and rejects same-key changed content', async () => {
  const first = receiptToRow({
    bytes: bytes(sealed(issue)),
    filename,
    study: issue.study,
    checkpoint,
  })
  const stored = new Map()
  let connections = 0
  let calls = 0
  const group = [
    first,
    ...[
      ['point_issue', 168],
      ['duration_issue', 24],
      ['duration_issue', 72],
      ['duration_issue', 168],
    ].map(([kind, horizonHours]) => ({
      ...first,
      kind,
      horizonHours,
      receiptKey: `${kind}:${horizonHours}:${filename}`,
    })),
  ]
  const sql = (parts, rowJson) => {
    assert.match(parts.join(''), /publish_curve_forecast_receipt/)
    return JSON.parse(rowJson)
  }
  sql.transaction = async (queries) => {
    const staged = new Map(stored)
    const results = []
    for (const row of queries) {
      calls++
      const old = staged.get(row.receiptKey)
      if (old && JSON.stringify(old) !== JSON.stringify(row))
        throw new Error('Conflicting curve forecast receipt')
      if (old) results.push([{ inserted: false }])
      else {
        staged.set(row.receiptKey, row)
        results.push([{ inserted: true }])
      }
    }
    stored.clear()
    for (const [key, value] of staged) stored.set(key, value)
    return results
  }
  const connect = async () => {
    connections++
    return sql
  }
  assert.deepEqual(await publishVerifiedRows({ collect: () => group, connect }), {
    verified: 5,
    inserted: 5,
    existing: 0,
  })
  assert.deepEqual(await publishVerifiedRows({ collect: () => group, connect }), {
    verified: 5,
    inserted: 0,
    existing: 5,
  })
  const changed = { ...first, payload: { ...first.payload, reason: 'changed' } }
  await assert.rejects(
    publishVerifiedRows({ collect: () => [changed, ...group.slice(1)], connect }),
    /Conflicting/,
  )
  assert.equal(stored.get(first.receiptKey).payload.reason, first.payload.reason)
  assert.equal(connections, 3)
  assert.equal(calls, 11)
})

test('a failure on the fifth newest issue rolls back all five', async () => {
  const first = receiptToRow({
    bytes: bytes(sealed(issue)),
    filename,
    study: issue.study,
    checkpoint,
  })
  const newest = [
    ['point_issue', 24],
    ['point_issue', 168],
    ['duration_issue', 24],
    ['duration_issue', 72],
    ['duration_issue', 168],
  ].map(([kind, horizonHours]) => ({
    ...first,
    kind,
    horizonHours,
    sourceBlock: first.sourceBlock + 1,
    receiptKey: `${kind}:${horizonHours}:newest`,
  }))
  const stored = new Map()
  const sql = (_parts, rowJson) => JSON.parse(rowJson)
  sql.transaction = async (queries) => {
    const staged = new Map(stored)
    for (const [index, row] of queries.entries()) {
      if (index === 4) throw new Error('fifth issue failed')
      staged.set(row.receiptKey, row)
    }
    stored.clear()
    for (const [key, value] of staged) stored.set(key, value)
    return queries.map(() => [{ inserted: true }])
  }
  await assert.rejects(
    publishVerifiedRows({ collect: () => newest, connect: async () => sql }),
    /fifth issue failed/,
  )
  assert.equal(stored.size, 0)
})

test('incomplete checkpoint issue group fails before opening Neon', async () => {
  const first = receiptToRow({
    bytes: bytes(sealed(issue)),
    filename,
    study: issue.study,
    checkpoint,
  })
  let connected = false
  await assert.rejects(
    publishVerifiedRows({
      collect: () => [first],
      connect: async () => {
        connected = true
        throw new Error('must not connect')
      },
    }),
    /Incomplete forecast checkpoint issue group/,
  )
  assert.equal(connected, false)
})

test('score sidecar has separate immutable identity and exact issue linkage', () => {
  const sealedIssue = sealed(issue)
  const scoreFilename = `${filename}.score.json`
  const score = sealed({
    study: `${issue.study}-score-v1`,
    issueFilename: filename,
    issueSha256: sealedIssue.sha256,
    horizonHours: 24,
    targetAt: block.timestamp + 24 * 3600,
    status: 'missing_target',
    actualQuote: null,
    unexpectedAccount: 'must-not-publish',
  })
  const row = receiptToRow({
    bytes: bytes(score),
    filename: scoreFilename,
    study: issue.study,
    checkpoint: { ...checkpoint, issue: sealedIssue },
  })
  assert.equal(row.kind, 'point_score')
  assert.equal(row.receiptKey, `point_score:${scoreFilename}`)
  assert.notEqual(row.receiptKey, `point_issue:${filename}`)
  assert.equal(row.study, `${issue.study}-score-v1`)
  assert.equal(row.payload.actualQuote, null)
  assert.equal(row.payload.unexpectedAccount, undefined)

  const wrongLink = sealed({ ...score, issueSha256: sha('wrong'), sha256: undefined })
  assert.throws(
    () =>
      receiptToRow({
        bytes: bytes(wrongLink),
        filename: scoreFilename,
        study: issue.study,
        checkpoint: { ...checkpoint, issue: sealedIssue },
      }),
    /provenance/,
  )
  const wrongStudy = sealed({ ...score, study: issue.study, sha256: undefined })
  assert.throws(
    () =>
      receiptToRow({
        bytes: bytes(wrongStudy),
        filename: scoreFilename,
        study: issue.study,
        checkpoint: { ...checkpoint, issue: sealedIssue },
      }),
    /provenance/,
  )
})
