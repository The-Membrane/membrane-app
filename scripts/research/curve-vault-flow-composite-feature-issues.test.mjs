import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OUT as QUOTE_OUT, readValidatedCheckpoints } from './curve-prospective-quote.mjs'
import {
  collect,
  FIRST_LIVE_BLOCK,
  FIRST_LIVE_BLOCK_HASH,
  OUT as LIVE_OUT,
  sourceIdentity,
} from './curve-vault-flow-ledger.mjs'
import { LOOKBACK_SECONDS, freezePlan, run } from './curve-vault-flow-near-live.mjs'
import {
  buildIssue,
  issueLatest,
  MAX_ISSUE_BYTES,
  runIfReady,
  verifyIssues,
} from './curve-vault-flow-composite-feature-issues.mjs'

const source = sourceIdentity()
const QUOTE_B = 26_071_191
const quoteBlock = readValidatedCheckpoints({ out: QUOTE_OUT }).find(
  (row) => row.checkpoint.block.number === QUOTE_B,
)?.checkpoint.block
const firstLive = JSON.parse(readFileSync(join(LIVE_OUT, readdirSync(LIVE_OUT).sort()[0]), 'utf8'))
const firstTime = firstLive.range.from.timestamp
const start = FIRST_LIVE_BLOCK - 2
const threshold = firstTime - LOOKBACK_SECONDS
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const reseal = ({ sha256: _sha, ...payload }) => ({
  ...payload,
  sha256: sha(JSON.stringify(payload)),
})
const hashAt = (n) =>
  n === QUOTE_B
    ? quoteBlock.hash
    : n === FIRST_LIVE_BLOCK
      ? FIRST_LIVE_BLOCK_HASH
      : `0x${sha(`composite-issue-test-${n}`)}`
const timeAt = (n) =>
  n >= QUOTE_B
    ? quoteBlock.timestamp + (n - QUOTE_B) * 12
    : n >= FIRST_LIVE_BLOCK
      ? firstTime + (n - FIRST_LIVE_BLOCK) * 12
      : n === start + 1
        ? threshold + 12
        : threshold - (start - n) * 12
const hex = (n) => `0x${n.toString(16)}`
const rpc = {
  async request({ method, params }) {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_call') return `0x${source.asset.slice(2).padStart(64, '0')}`
    if (method === 'eth_getLogs') return []
    if (method !== 'eth_getBlockByNumber') throw new Error('Unexpected RPC method')
    const n = params[0] === 'finalized' ? QUOTE_B + 100 : Number(BigInt(params[0]))
    return {
      number: hex(n),
      hash: hashAt(n),
      parentHash: hashAt(n - 1),
      timestamp: hex(timeAt(n)),
    }
  },
}

async function fixture(t, { partial = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'composite-issues-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const liveOut = join(dir, 'live')
  const quoteOut = join(dir, 'quotes')
  const nearLiveOut = join(dir, 'suffix')
  const out = join(dir, 'issues')
  cpSync(LIVE_OUT, liveOut, { recursive: true })
  cpSync(QUOTE_OUT, quoteOut, { recursive: true })
  for (const name of readdirSync(liveOut).filter((item) => item.endsWith('.json'))) {
    if (Number(name.slice(13, 25)) > QUOTE_B) unlinkSync(join(liveOut, name))
  }
  for (const name of readdirSync(quoteOut).filter((item) => item.endsWith('.json'))) {
    if (Number(name.slice(0, 12)) > QUOTE_B) unlinkSync(join(quoteOut, name))
  }
  const now = () => new Date('2026-09-27T21:00:00.000Z')
  await freezePlan({
    client: rpc,
    rpcHost: 'archive.example',
    out: nearLiveOut,
    liveOut,
    source,
    now,
  })
  if (!partial)
    await run({
      client: rpc,
      out: nearLiveOut,
      liveOut,
      source,
      rpcHost: 'archive.example',
      maxChunks: 1,
      range: 2,
      now,
    })
  return {
    dir,
    out,
    quoteOut,
    liveOut,
    nearLiveOut,
    source,
    now: () => new Date('2026-09-27T21:30:00.000Z'),
  }
}

test('complete bridged 30d suffix issues once with physical source references', async (t) => {
  const f = await fixture(t)
  const first = issueLatest(f)
  assert.equal(first.status, 'issued')
  const saved = JSON.parse(readFileSync(first.path, 'utf8'))
  assert.equal(saved.study, 'scrvusd-vault-flow-composite-feature-issues-v2')
  assert.equal(saved.features.trailingCompleteWindow['7d'].status, 'observed')
  assert.equal(saved.features.maximumObservedCompleteWindow['24h'].status, 'observed')
  assert.equal(saved.source.nearLiveReceiptPrefix.count, 1)
  assert.equal(saved.source.nearLiveWitnessPrefix.count, 1)
  assert.equal(saved.source.liveReceiptPrefix.last.receiptSha256.length, 64)
  assert.ok(Buffer.byteLength(readFileSync(first.path)) < MAX_ISSUE_BYTES)
  assert.equal(verifyIssues(f).issues, 1)
  assert.equal(issueLatest(f).status, 'existing')
  assert.equal(runIfReady(f).status, 'existing')
  assert.equal(readdirSync(f.out).length, 1)
})

test('issue replays at original quote and capture time after later quote and live receipt', async (t) => {
  const f = await fixture(t)
  const first = issueLatest(f)
  const before = readFileSync(first.path, 'utf8')
  const old = readValidatedCheckpoints({ out: f.quoteOut }).at(-1)
  const laterBlock = {
    ...old.checkpoint.block,
    number: QUOTE_B + 1,
    hash: hashAt(QUOTE_B + 1),
    timestamp: old.checkpoint.block.timestamp + 12,
  }
  const later = reseal({
    ...old.checkpoint,
    block: laterBlock,
    captureStartUtc: '2026-09-27T22:00:00.000Z',
    captureEndUtc: '2026-09-27T22:00:01.000Z',
  })
  const laterName = `${String(laterBlock.number).padStart(12, '0')}-${laterBlock.hash.slice(2)}.json`
  writeFileSync(join(f.quoteOut, laterName), `${JSON.stringify(later)}\n`)
  await collect({
    client: rpc,
    out: f.liveOut,
    source,
    toBlock: laterBlock.number,
    expectedTargetHash: laterBlock.hash,
    maxChunks: 1,
    range: 1,
    rpcHost: 'archive.example',
    now: () => new Date('2026-09-27T22:00:00.000Z'),
  })
  assert.equal(verifyIssues(f).issues, 1)
  assert.equal(readFileSync(first.path, 'utf8'), before)
})

test('tampering and resealing an issue cannot change as-of features or physical references', async (t) => {
  const f = await fixture(t)
  const path = issueLatest(f).path
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, `${JSON.stringify({ ...saved, caveats: [] })}\n`)
  assert.throws(() => verifyIssues(f), /SHA mismatch/)
  assert.throws(() => runIfReady(f), /SHA mismatch/)
  writeFileSync(path, `${JSON.stringify(reseal({ ...saved, caveats: [] }))}\n`)
  assert.throws(() => verifyIssues(f), /as-of replay/)
  writeFileSync(path, `${JSON.stringify(saved)}\n`)
  const nearName = readdirSync(join(f.nearLiveOut, 'receipts'))[0]
  const nearPath = join(f.nearLiveOut, 'receipts', nearName)
  writeFileSync(nearPath, `${JSON.stringify(JSON.parse(readFileSync(nearPath, 'utf8')))}  \n`)
  assert.throws(
    () => verifyIssues(f),
    /boundary witness mismatch|physical source mismatch|as-of replay/,
  )
})

test('late issue, incomplete suffix, and low disk reserve fail without an issue', async (t) => {
  const f = await fixture(t, { partial: true })
  assert.throws(() => issueLatest(f), /incomplete/)
  assert.deepEqual(runIfReady(f), {
    status: 'waiting',
    reason: 'near_live_suffix_incomplete',
    throughBlock: null,
    quoteBlock: QUOTE_B,
  })
  const planPath = join(f.nearLiveOut, 'plan.json')
  const plan = readFileSync(planPath, 'utf8')
  writeFileSync(planPath, plan.replace('archive.example', 'archive.evil'))
  assert.throws(() => runIfReady(f), /physical|plan|seal/i)
  writeFileSync(planPath, plan)
  assert.equal(verifyIssues(f).issues, 0)
  assert.throws(
    () => runIfReady({ ...f, now: () => new Date('2026-09-27T23:00:00.000Z') }),
    /clock bounds/,
  )
  const complete = await fixture(t)
  const name = readValidatedCheckpoints({ out: complete.quoteOut }).at(-1).filename
  assert.throws(
    () =>
      buildIssue({
        ...complete,
        checkpointFilename: name,
        issuedAtUtc: '2026-09-27T23:00:00.000Z',
      }),
    /clock bounds/,
  )
  assert.throws(
    () => issueLatest({ ...complete, stat: () => ({ bavail: 0, bsize: 4096 }) }),
    /disk reserve/,
  )
  assert.equal(verifyIssues(complete).issues, 0)
})

test('issue reader caps bytes and requires one canonical newline', async (t) => {
  const f = await fixture(t)
  const path = issueLatest(f).path
  const original = readFileSync(path, 'utf8')
  writeFileSync(path, `${original}\n`)
  assert.throws(() => verifyIssues(f), /noncanonical/)
  writeFileSync(path, `${' '.repeat(MAX_ISSUE_BYTES + 1)}`)
  assert.throws(() => verifyIssues(f), /size cap/)
  writeFileSync(path, original)
  assert.equal(verifyIssues(f).issues, 1)
})
