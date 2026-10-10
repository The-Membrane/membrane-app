import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FIRST_LIVE_BLOCK,
  FIRST_LIVE_BLOCK_HASH,
  readValidatedReceipts,
  sourceIdentity,
} from './curve-vault-flow-ledger.mjs'
import {
  LOOKBACK_SECONDS,
  availableReceiptsAt,
  boundaryWitness,
  firstLiveAnchor,
  freezePlan,
  parseOptions,
  readPlan,
  run,
  validatePlan,
  verify,
} from './curve-vault-flow-near-live.mjs'

const source = sourceIdentity()
const anchor = firstLiveAnchor({ source })
const hashAt = (n) =>
  n === FIRST_LIVE_BLOCK
    ? FIRST_LIVE_BLOCK_HASH
    : `0x${createHash('sha256').update(`near-live-test-${n}`).digest('hex')}`
const timestampAt = (n) => Math.max(1, anchor.timestamp - 12 * (FIRST_LIVE_BLOCK - n))
const hex = (n) => `0x${n.toString(16)}`
const reseal = ({ sha256: _old, ...payload }) => ({
  ...payload,
  sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
})
const headerAt = (n) => ({
  number: hex(n),
  hash: hashAt(n),
  parentHash: hashAt(n - 1),
  timestamp: hex(timestampAt(n)),
})
const rpc = {
  async request({ method, params }) {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber')
      return headerAt(
        params[0] === 'finalized' ? FIRST_LIVE_BLOCK + 100 : Number(BigInt(params[0])),
      )
    if (method === 'eth_call') return `0x${source.asset.slice(2).padStart(64, '0')}`
    if (method === 'eth_getLogs') return []
    throw new Error(`Unexpected mocked RPC method: ${method}`)
  },
}
const now = () => new Date('2026-09-27T22:00:00.000Z')
const temp = (t) => {
  const out = mkdtempSync(join(tmpdir(), 'near-live-flow-'))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  return out
}

test('freezes 30-day archive boundary and exact first-live parent bridge; plan is idempotent', async (t) => {
  const out = temp(t)
  const plan = await freezePlan({ client: rpc, rpcHost: 'archive.example', out, source, now })
  assert.equal(plan.thresholdTimestamp, anchor.timestamp - LOOKBACK_SECONDS)
  assert.equal(plan.start.timestamp <= plan.thresholdTimestamp, true)
  assert.equal(plan.successor.timestamp > plan.thresholdTimestamp, true)
  assert.equal(plan.firstLiveParentHash, plan.end.hash)
  assert.equal(plan.end.number, FIRST_LIVE_BLOCK - 1)
  assert.deepEqual(
    await freezePlan({ client: rpc, rpcHost: 'archive.example', out, source, now }),
    plan,
  )
  assert.throws(
    () =>
      validatePlan(reseal({ ...plan, firstLiveParentHash: hashAt(1) }), {
        source,
        firstLive: anchor,
      }),
    /seal or boundary/,
  )
  assert.throws(
    () =>
      validatePlan(plan, {
        source: { ...source, vault: '0x0000000000000000000000000000000000000000' },
        firstLive: anchor,
      }),
    /seal or boundary/,
  )
  assert.deepEqual(readPlan({ out, source }), plan)
})

test('plan refuses a live header whose parent differs from suffix end', async (t) => {
  const out = temp(t)
  const wrongRpc = {
    async request(args) {
      const response = await rpc.request(args)
      return args.method === 'eth_getBlockByNumber' && args.params[0] === hex(FIRST_LIVE_BLOCK)
        ? { ...response, parentHash: hashAt(1) }
        : response
    },
  }
  await assert.rejects(
    freezePlan({ client: wrongRpc, rpcHost: 'archive.example', out, source, now }),
    /parent hash bridge/,
  )
})

test('bounded empty-event receipts resume, carry witnesses, and reject physical tampering', async (t) => {
  const out = temp(t)
  const plan = await freezePlan({ client: rpc, rpcHost: 'archive.example', out, source, now })
  const first = await run({
    client: rpc,
    out,
    source,
    rpcHost: 'archive.example',
    maxChunks: 1,
    range: 2,
    now,
  })
  assert.equal(first.saved, 1)
  assert.equal(first.throughBlock, plan.start.number + 1)
  assert.equal(verify({ out, source }).receipts, 1)
  const second = await run({
    client: rpc,
    out,
    source,
    rpcHost: 'archive.example',
    maxChunks: 1,
    range: 2,
    now,
  })
  assert.equal(second.saved, 1)
  assert.equal(second.throughBlock, plan.start.number + 3)
  const receipts = readValidatedReceipts({ out: join(out, 'receipts'), source })
  assert.equal(receipts[1].previousReceiptSha256, receipts[0].sha256)
  assert.equal(verify({ out, source }).receipts, 2)
  const before = availableReceiptsAt({ issuedAtUtc: '2026-09-27T21:59:59.000Z', out, source })
  assert.equal(before.length, 0)
  const after = availableReceiptsAt({ issuedAtUtc: '2026-09-27T22:00:00.000Z', out, source })
  assert.equal(after.length, 2)
  const witnessFile = join(out, 'boundaries', readdirSync(join(out, 'boundaries')).sort()[1])
  const witness = JSON.parse(readFileSync(witnessFile, 'utf8'))
  writeFileSync(witnessFile, `${JSON.stringify({ ...witness, previousToHash: hashAt(2) })}\n`)
  assert.throws(() => verify({ out, source }), /seal|witness/)
})

test('boundary witness refuses wrong canonical parent hash', () => {
  const receipt = { range: { from: { number: 10, hash: hashAt(10) } }, sha256: 'a'.repeat(64) }
  const previous = { range: { to: { hash: hashAt(9) } }, sha256: 'b'.repeat(64) }
  const plan = { sha256: 'c'.repeat(64), start: { hash: hashAt(10) }, rpcHost: 'archive.example' }
  assert.throws(
    () =>
      boundaryWitness({
        plan,
        receipt,
        previous,
        fromHeader: { number: 10, hash: hashAt(10), parentHash: hashAt(8) },
        now,
      }),
    /parent hash/,
  )
})

test('missing first receipt cannot become a valid prefix', async (t) => {
  const out = temp(t)
  await freezePlan({ client: rpc, rpcHost: 'archive.example', out, source, now })
  await run({ client: rpc, out, source, rpcHost: 'archive.example', maxChunks: 2, range: 2, now })
  const firstFile = readdirSync(join(out, 'receipts')).sort()[0]
  unlinkSync(join(out, 'receipts', firstFile))
  assert.throws(
    () => verify({ out, source }),
    /first receipt disagrees with plan|coverage gap|Invalid vault flow receipt/,
  )
})

test('CLI is offline by default and refuses unbounded or mixed modes', () => {
  assert.deepEqual(parseOptions([]), {})
  assert.throws(() => parseOptions(['--plan', '--run']), /Incompatible/)
  assert.throws(() => parseOptions(['--max-chunks', '33']), /Incompatible/)
})
