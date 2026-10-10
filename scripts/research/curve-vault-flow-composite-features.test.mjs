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
  FIRST_LIVE_BLOCK,
  FIRST_LIVE_BLOCK_HASH,
  OUT as LIVE_OUT,
  sourceIdentity,
} from './curve-vault-flow-ledger.mjs'
import { LOOKBACK_SECONDS, freezePlan, run } from './curve-vault-flow-near-live.mjs'
import { readCompositeFeatures } from './curve-vault-flow-composite-features.mjs'

const source = sourceIdentity()
const TEST_QUOTE_BLOCK = 26_071_191
const firstLive = JSON.parse(readFileSync(join(LIVE_OUT, readdirSync(LIVE_OUT).sort()[0]), 'utf8'))
const firstTime = firstLive.range.from.timestamp
const start = FIRST_LIVE_BLOCK - 2
const threshold = firstTime - LOOKBACK_SECONDS
const hashAt = (n) =>
  n === FIRST_LIVE_BLOCK
    ? FIRST_LIVE_BLOCK_HASH
    : `0x${createHash('sha256').update(`composite-test-${n}`).digest('hex')}`
const timeAt = (n) =>
  n >= FIRST_LIVE_BLOCK
    ? firstTime + (n - FIRST_LIVE_BLOCK) * 12
    : n === start + 1
      ? threshold + 12
      : threshold - (start - n) * 12
const hex = (n) => `0x${n.toString(16)}`
const reseal = ({ sha256: _sha, ...payload }) => ({
  ...payload,
  sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
})
const rpc = {
  async request({ method, params }) {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_call') return `0x${source.asset.slice(2).padStart(64, '0')}`
    if (method === 'eth_getLogs') return []
    if (method !== 'eth_getBlockByNumber') throw new Error('Unexpected RPC method')
    const n = params[0] === 'finalized' ? FIRST_LIVE_BLOCK + 100 : Number(BigInt(params[0]))
    return {
      number: hex(n),
      hash: hashAt(n),
      parentHash: hashAt(n - 1),
      timestamp: hex(timeAt(n)),
    }
  },
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'composite-flow-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const liveOut = join(dir, 'live')
  const quoteOut = join(dir, 'quotes')
  const nearLiveOut = join(dir, 'suffix')
  cpSync(LIVE_OUT, liveOut, { recursive: true })
  cpSync(QUOTE_OUT, quoteOut, { recursive: true })
  for (const name of readdirSync(liveOut).filter((item) => item.endsWith('.json'))) {
    const to = Number(name.slice(13, 25))
    if (to > TEST_QUOTE_BLOCK) unlinkSync(join(liveOut, name))
  }
  for (const name of readdirSync(quoteOut).filter((item) => item.endsWith('.json'))) {
    const block = Number(name.slice(0, 12))
    if (block > TEST_QUOTE_BLOCK) unlinkSync(join(quoteOut, name))
  }
  const at = () => new Date('2026-09-27T22:00:00.000Z')
  const plan = await freezePlan({
    client: rpc,
    rpcHost: 'archive.example',
    out: nearLiveOut,
    liveOut,
    source,
    now: at,
  })
  if (!options.partial)
    await run({
      client: rpc,
      out: nearLiveOut,
      liveOut,
      source,
      rpcHost: 'archive.example',
      maxChunks: 1,
      range: 2,
      now: at,
    })
  return { dir, liveOut, quoteOut, nearLiveOut, plan, asOfUtc: '2026-09-27T23:00:00.000Z' }
}

test('30-day quiet suffix makes both 7d and 24h composite windows complete', async (t) => {
  const f = await fixture(t)
  const result = readCompositeFeatures(f)
  assert.equal(result.features.status, 'observed')
  assert.equal(result.features.trailingCompleteWindow['7d'].status, 'observed')
  assert.equal(result.features.maximumObservedCompleteWindow['7d'].status, 'observed')
  assert.equal(result.features.maximumObservedCompleteWindow['24h'].status, 'observed')
  assert.equal(result.source.nearLiveReceiptPrefix.count, 1)
  assert.equal(result.source.nearLiveWitnessPrefix.count, 1)
  assert.equal(result.source.nearLivePlanSha256, f.plan.sha256)
  assert.equal(result.source.nearLiveEndHash, result.source.frozenFirstLiveParentHash)
  assert.equal(result.source.liveReceiptPrefix.first.receiptSha256, firstLive.sha256)
  assert.match(result.source.liveReceiptPrefix.orderedTuplesSha256, /^[0-9a-f]{64}$/)
  assert.equal('nearLiveReceipts' in result.source, false)
  assert.equal('liveReceipts' in result.source, false)
  assert.equal(result.features.coverage.fromBlock, f.plan.start.number)
})

test('canonical physical receipt changes update only the relevant prefix commitment', async (t) => {
  const f = await fixture(t)
  const before = readCompositeFeatures(f)
  const liveFile = readdirSync(f.liveOut)
    .filter((name) => name.endsWith('.json'))
    .sort()[1]
  const livePath = join(f.liveOut, liveFile)
  writeFileSync(livePath, `${readFileSync(livePath, 'utf8')} `)
  const after = readCompositeFeatures(f)
  assert.deepEqual(after.features, before.features)
  assert.equal(
    after.source.nearLiveReceiptPrefix.orderedTuplesSha256,
    before.source.nearLiveReceiptPrefix.orderedTuplesSha256,
  )
  assert.notEqual(
    after.source.liveReceiptPrefix.orderedTuplesSha256,
    before.source.liveReceiptPrefix.orderedTuplesSha256,
  )
})

test('partial suffix and later capture cannot become earlier as-of coverage', async (t) => {
  const partial = await fixture(t, { partial: true })
  assert.throws(() => readCompositeFeatures(partial), /incomplete/)
  const full = await fixture(t)
  assert.throws(
    () => readCompositeFeatures({ ...full, asOfUtc: '2026-09-27T21:59:59.000Z' }),
    /captured after|unavailable/,
  )
  const witnessName = readdirSync(join(full.nearLiveOut, 'boundaries'))[0]
  const witnessPath = join(full.nearLiveOut, 'boundaries', witnessName)
  const witness = JSON.parse(readFileSync(witnessPath, 'utf8'))
  writeFileSync(
    witnessPath,
    `${JSON.stringify(reseal({ ...witness, capturedAtUtc: '2026-09-28T00:00:00.000Z' }))}\n`,
  )
  assert.throws(() => readCompositeFeatures(full), /as-of suffix|bridge unavailable/)
})

test('wrong bridge, missing receipt, and quote tip mismatch fail closed', async (t) => {
  const f = await fixture(t)
  const planPath = join(f.nearLiveOut, 'plan.json')
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
  writeFileSync(
    planPath,
    `${JSON.stringify(reseal({ ...plan, firstLiveParentHash: hashAt(start) }))}\n`,
  )
  assert.throws(() => readCompositeFeatures(f), /seal|boundary/)
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`)

  const file = readdirSync(join(f.nearLiveOut, 'receipts'))[0]
  unlinkSync(join(f.nearLiveOut, 'receipts', file))
  assert.throws(() => readCompositeFeatures(f), /witness count|incomplete/)

  const quoteFiles = readdirSync(f.quoteOut)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const latest = readValidatedCheckpoints({ out: f.quoteOut }).at(-1).filename
  assert.equal(quoteFiles.includes(latest), true)
  const liveFiles = readdirSync(f.liveOut)
    .filter((name) => name.endsWith('.json'))
    .sort()
  unlinkSync(join(f.quoteOut, latest))
  for (const fileName of liveFiles.slice(1)) unlinkSync(join(f.liveOut, fileName))
  assert.throws(() => readCompositeFeatures(f), /exact quote checkpoint|checkpoint/)
})

test('an old issue replays at its exact validated quote after a later quote arrives', async (t) => {
  const f = await fixture(t)
  const before = readCompositeFeatures(f)
  const oldName = before.source.quoteFilename
  const old = JSON.parse(readFileSync(join(f.quoteOut, oldName), 'utf8'))
  const laterBlock = {
    ...old.block,
    number: old.block.number + 1,
    timestamp: old.block.timestamp + 12,
    hash: hashAt(old.block.number + 1),
  }
  const later = reseal({
    ...old,
    block: laterBlock,
    captureStartUtc: '2026-09-28T00:00:00.000Z',
    captureEndUtc: '2026-09-28T00:00:01.000Z',
  })
  const laterName = `${String(laterBlock.number).padStart(12, '0')}-${laterBlock.hash.slice(2)}.json`
  writeFileSync(join(f.quoteOut, laterName), `${JSON.stringify(later)}\n`)
  const lastLiveName = readdirSync(f.liveOut)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .at(-1)
  const lastLive = JSON.parse(readFileSync(join(f.liveOut, lastLiveName), 'utf8'))
  const laterLive = reseal({
    ...lastLive,
    range: { from: laterBlock, to: laterBlock },
    finalizedHead: laterBlock,
    previousReceiptSha256: lastLive.sha256,
    events: [],
    counts: { deposit: 0, withdraw: 0 },
    captureStartUtc: '2026-09-28T00:00:00.000Z',
    captureEndUtc: '2026-09-28T00:00:01.000Z',
  })
  const laterLiveName = `${String(laterBlock.number).padStart(12, '0')}-${String(laterBlock.number).padStart(12, '0')}-${laterBlock.hash.slice(2)}.json`
  writeFileSync(join(f.liveOut, laterLiveName), `${JSON.stringify(laterLive)}\n`)

  assert.deepEqual(readCompositeFeatures(f), before)
  assert.deepEqual(readCompositeFeatures({ ...f, checkpointFilename: oldName }), before)
  assert.throws(
    () => readCompositeFeatures({ ...f, checkpointFilename: laterName }),
    /captured after/,
  )
  assert.throws(
    () => readCompositeFeatures({ ...f, checkpointFilename: '../unknown.json' }),
    /eligible sealed quote checkpoint/,
  )
  const current = readCompositeFeatures({ ...f, asOfUtc: '2026-09-28T01:00:00.000Z' })
  assert.equal(current.source.quoteFilename, laterName)
  assert.equal(current.source.liveReceiptPrefix.count, before.source.liveReceiptPrefix.count + 1)
  const replay = readCompositeFeatures({
    ...f,
    checkpointFilename: oldName,
    asOfUtc: '2026-09-28T01:00:00.000Z',
  })
  assert.equal(replay.source.quoteFilename, oldName)
  assert.equal(replay.block.number, before.block.number)
})
