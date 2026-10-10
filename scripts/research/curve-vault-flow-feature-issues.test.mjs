import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sourceIdentity as quoteIdentity } from './curve-prospective-quote.mjs'
import { sourceIdentity as flowIdentity } from './curve-vault-flow-ledger.mjs'
import { buildIssue, issueLatest, verifyIssues } from './curve-vault-flow-feature-issues.mjs'

const sha = (data) => createHash('sha256').update(data).digest('hex')
const seal = ({ sha256: _old, ...payload }) => ({
  ...payload,
  sha256: sha(JSON.stringify(payload)),
})
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const T = 1_790_000_000
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const source = flowIdentity()
const qSource = quoteIdentity()
const stat = () => ({ bavail: 2_000_000_000, bsize: 1 })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flow-feature-issue-'))
  const out = join(root, 'issues')
  const flowOut = join(root, 'flows')
  mkdirSync(flowOut)
  const checkpointRow = {
    filename: `${String(100).padStart(12, '0')}-${hash(100).slice(2)}.json`,
    physicalSha256: 'a'.repeat(64),
    checkpoint: {
      study: 'quote-fixture',
      sha256: 'b'.repeat(64),
      source: qSource,
      block: { number: 100, hash: hash(100), timestamp: T },
      captureEndUtc: iso(T + 60),
    },
  }
  const first = {
    study: 'flow-fixture',
    source,
    range: {
      from: { number: 99, hash: hash(99), timestamp: T - 3600 },
      to: { number: 100, hash: hash(100), timestamp: T },
    },
    captureEndUtc: iso(T + 90),
    previousReceiptSha256: null,
    events: [
      { kind: 'withdraw', blockNumber: 100, blockTimestamp: T, logIndex: 0, assetsRaw: '10' },
    ],
    sha256: 'c'.repeat(64),
  }
  const second = {
    ...first,
    range: {
      from: { number: 101, hash: hash(101), timestamp: T + 3600 },
      to: { number: 101, hash: hash(101), timestamp: T + 3600 },
    },
    captureEndUtc: iso(T + 4000),
    previousReceiptSha256: first.sha256,
    events: [
      {
        kind: 'withdraw',
        blockNumber: 101,
        blockTimestamp: T + 3600,
        logIndex: 0,
        assetsRaw: '999',
      },
    ],
    sha256: 'd'.repeat(64),
  }
  const save = (receipt) => {
    const { from, to } = receipt.range
    const filename = `${String(from.number).padStart(12, '0')}-${String(to.number).padStart(12, '0')}-${to.hash.slice(2)}.json`
    const path = join(flowOut, filename)
    writeFileSync(path, JSON.stringify(receipt) + '\n')
    return path
  }
  const firstPath = save(first)
  return {
    root,
    out,
    flowOut,
    checkpointRow,
    first,
    second,
    firstPath,
    save,
    args: { out, flowOut, checkpoints: [checkpointRow], receipts: [first], source },
  }
}

const cleanup = (f) => rmSync(f.root, { recursive: true, force: true })

test('short sealed coverage stays unavailable, never reported as zero', () => {
  const f = fixture()
  try {
    const issue = buildIssue({
      checkpointRow: f.checkpointRow,
      receipts: [f.first],
      source,
      flowOut: f.flowOut,
      issuedAtUtc: iso(T + 120),
    })
    assert.equal(issue.features.status, 'observed')
    assert.equal(issue.features.trailingCompleteWindow['24h'].status, 'unavailable')
    assert.equal(issue.features.trailingCompleteWindow['7d'].status, 'unavailable')
    assert.equal(issue.features.maximumObservedCompleteWindow['24h'].status, 'unavailable')
    assert.equal(issue.source.flowEndpointReceiptSha256, f.first.sha256)
    assert.equal(issue.source.quoteCheckpointSha256, f.checkpointRow.checkpoint.sha256)
    assert.match(issue.caveats[0], /One RPC provider/)
  } finally {
    cleanup(f)
  }
})

test('append-only issue is idempotent and verifies against original prefix after later receipt', () => {
  const f = fixture()
  try {
    const now = () => new Date((T + 120) * 1000)
    const created = issueLatest({ ...f.args, now, stat })
    const bytes = readFileSync(created.path)
    assert.equal(created.status, 'issued')
    assert.equal(issueLatest({ ...f.args, now, stat }).status, 'existing')
    f.save(f.second)
    assert.deepEqual(verifyIssues({ ...f.args, receipts: [f.first, f.second] }), { issues: 1 })
    assert.throws(
      () => issueLatest({ ...f.args, receipts: [f.first, f.second], now, stat }),
      /Current vault flow tip/,
    )
    assert.deepEqual(readFileSync(created.path), bytes)
  } finally {
    cleanup(f)
  }
})

test('tampered source and re-sealed issue fail full as-of replay', () => {
  const f = fixture()
  try {
    const created = issueLatest({ ...f.args, now: () => new Date((T + 120) * 1000), stat })
    const original = readFileSync(f.firstPath)
    writeFileSync(f.firstPath, Buffer.concat([original, Buffer.from(' ')]))
    assert.throws(() => verifyIssues(f.args), /as-of replay or source mismatch/)
    writeFileSync(f.firstPath, original)
    const issue = JSON.parse(readFileSync(created.path, 'utf8'))
    issue.features.trailingCompleteWindow['24h'] = { status: 'observed', grossWithdrawalsRaw: '0' }
    writeFileSync(created.path, JSON.stringify(seal(issue)) + '\n')
    assert.throws(() => verifyIssues(f.args), /as-of replay or source mismatch/)
  } finally {
    cleanup(f)
  }
})

test('late issue, missing exact alignment, and receipt captured after issue refuse publication', () => {
  const f = fixture()
  try {
    const base = { checkpointRow: f.checkpointRow, receipts: [f.first], source, flowOut: f.flowOut }
    assert.throws(() => buildIssue({ ...base, issuedAtUtc: iso(T + 60) }), /unavailable/)
    assert.throws(() => buildIssue({ ...base, issuedAtUtc: iso(T + 60 + 2 * 3600 + 1) }), /clock/)
    assert.throws(() => buildIssue({ ...base, issuedAtUtc: iso(T + 24 * 3600) }), /clock/)
    assert.throws(() => buildIssue({ ...base, receipts: [], issuedAtUtc: iso(T + 120) }), /exactly/)
    const later = { ...f.first, captureEndUtc: iso(T + 180) }
    assert.throws(
      () => buildIssue({ ...base, receipts: [later], issuedAtUtc: iso(T + 120) }),
      /unavailable/,
    )
  } finally {
    cleanup(f)
  }
})
