import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from 'viem'
import { collect, readValidatedReceipts, sourceIdentity } from './curve-vault-flow-ledger.mjs'
import { auditSidecars, reconcileReceipt } from './scrvusd-flow-second-provider.mjs'

const source = sourceIdentity()
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const q = (n) => `0x${n.toString(16)}`
const stat = () => ({ bavail: 10_000_000, bsize: 4096 })
const clock = () => new Date('2026-09-28T12:00:00.000Z')
const fetchFrom = (client) => async (url, options) => {
  assert.equal(url, 'https://secondary.example/rpc')
  assert.equal(options.redirect, 'error')
  const request = JSON.parse(options.body)
  const result = await client.request({ method: request.method, params: request.params })
  return { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result }) }
}
const asset = encodeFunctionResult({
  abi: parseAbi(['function asset() view returns (address)']),
  functionName: 'asset',
  result: source.asset,
})
function log(kind, block) {
  const stream = source.streams.find((x) => x.kind === kind)
  const actor = hash(1)
  return {
    address: source.vault,
    topics:
      kind === 'deposit' ? [stream.topic0, actor, actor] : [stream.topic0, actor, actor, actor],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [100n, 98n]),
    blockNumber: q(block),
    blockHash: hash(block),
    transactionHash: hash(100 + block),
    transactionIndex: q(0),
    logIndex: q(0),
    removed: false,
  }
}
function mock(logs = [], altered = {}) {
  return {
    request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'finalized' ? 20 : Number(BigInt(params[0]))
        return {
          number: q(n),
          hash: altered.boundary === n ? hash(999) : hash(n),
          timestamp: q(1_790_000_000 + n),
        }
      }
      if (method === 'eth_call') return asset
      if (method === 'eth_getLogs') {
        const filter = params[0]
        const topics = Array.isArray(filter.topics[0]) ? filter.topics[0] : [filter.topics[0]]
        return logs.filter(
          (row) =>
            Number(BigInt(row.blockNumber)) >= Number(BigInt(filter.fromBlock)) &&
            Number(BigInt(row.blockNumber)) <= Number(BigInt(filter.toBlock)) &&
            topics.includes(row.topics[0]),
        )
      }
      throw new Error('Unexpected mock request')
    },
  }
}
async function fixture(fn, logs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'second-provider-test-'))
  const primaryOut = join(dir, 'primary')
  const out = join(dir, 'sidecars')
  try {
    await collect({
      client: mock(logs),
      out: primaryOut,
      source,
      fromBlock: 10,
      toBlock: 12,
      range: 3,
      maxChunks: 1,
      rpcHost: 'primary.example',
      now: clock,
      stat,
    })
    const receipts = readValidatedReceipts({ out: primaryOut, source })
    await fn({ primaryOut, out, receipts, receipt: receipts[0] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const corroborate = ({ receipt, primaryOut, out }, client) =>
  reconcileReceipt({
    receipt,
    primaryOut,
    out,
    secondRpcUrl: 'https://secondary.example/rpc',
    fetchImpl: fetchFrom(client),
    source,
    stat,
  })

test('corroborates exact Deposit/Withdraw set and physical receipt; preserves first observation', async () =>
  fixture(
    async (x) => {
      const before = auditSidecars({
        receipts: x.receipts,
        primaryOut: x.primaryOut,
        out: x.out,
        source,
      })
      assert.equal(before.certified, false)
      const sidecar = await corroborate(x, mock([log('deposit', 11), log('withdraw', 12)]))
      assert.equal(sidecar.eventCount, 2)
      assert.match(sidecar.primaryReceiptPhysicalSha256, /^[0-9a-f]{64}$/)
      assert.equal(
        auditSidecars({
          receipts: x.receipts,
          primaryOut: x.primaryOut,
          out: x.out,
          source,
          fromBlock: 10,
          throughBlock: 12,
        }).certified,
        false,
      )
      assert.deepEqual(await corroborate(x, mock([])), sidecar)
    },
    [log('deposit', 11), log('withdraw', 12)],
  ))

test('zero-event range is corroborated and a missing secondary event is rejected', async () => {
  await fixture(async (x) => {
    const sidecar = await corroborate(x, mock())
    assert.equal(sidecar.eventCount, 0)
    assert.equal(
      auditSidecars({ receipts: x.receipts, primaryOut: x.primaryOut, out: x.out, source })
        .certified,
      false,
    )
  })
  await fixture(
    async (x) => {
      await assert.rejects(corroborate(x, mock()), /event set or finalized boundary disagrees/)
      assert.equal(
        auditSidecars({ receipts: x.receipts, primaryOut: x.primaryOut, out: x.out, source })
          .certified,
        false,
      )
    },
    [log('withdraw', 11)],
  )
})

test('injected transport is retained for research but cannot certify provider coverage', async () =>
  fixture(async (x) => {
    const sidecar = await reconcileReceipt({
      receipt: x.receipt,
      primaryOut: x.primaryOut,
      out: x.out,
      secondRpcUrl: 'https://secondary.example/rpc',
      fetchImpl: fetchFrom(mock()),
      source,
      stat,
    })
    assert.equal(sidecar.transportMode, 'injected_transport')
    const audit = auditSidecars({
      receipts: x.receipts,
      primaryOut: x.primaryOut,
      out: x.out,
      source,
    })
    assert.equal(audit.certified, false)
    assert.equal(audit.reason, 'injected_transport_unattested')
  }))

test('different boundary, same provider host and short requested window fail closed', async () =>
  fixture(async (x) => {
    await assert.rejects(
      corroborate(x, mock([], { boundary: 10 })),
      /event set or finalized boundary disagrees/,
    )
    await assert.rejects(
      reconcileReceipt({
        ...x,
        secondRpcUrl: 'https://primary.example/rpc',
        fetchImpl: fetchFrom(mock()),
        source,
        stat,
      }),
      /Distinct second RPC/,
    )
    const short = auditSidecars({
      receipts: x.receipts,
      primaryOut: x.primaryOut,
      out: x.out,
      source,
      fromBlock: 9,
    })
    assert.equal(short.reason, 'primary_window_incomplete')
  }))

test('tampered sidecar and primary physical receipt fail audit', async () =>
  fixture(async (x) => {
    const sidecar = await corroborate(x, mock())
    const sidecarPath = join(x.out, `${x.receipt.sha256}.json`)
    writeFileSync(sidecarPath, `${JSON.stringify({ ...sidecar, eventCount: 1 })}\n`)
    assert.throws(
      () => auditSidecars({ receipts: x.receipts, primaryOut: x.primaryOut, out: x.out, source }),
      /seal mismatch/,
    )
    writeFileSync(sidecarPath, `${JSON.stringify(sidecar)}\n`)
    const secondPath = join(x.out, 'secondary', `${x.receipt.sha256}.json`)
    const secondBytes = readFileSync(secondPath)
    unlinkSync(secondPath)
    assert.throws(
      () => auditSidecars({ receipts: x.receipts, primaryOut: x.primaryOut, out: x.out, source }),
      /ENOENT/,
    )
    writeFileSync(secondPath, secondBytes)
    writeFileSync(secondPath, secondBytes.subarray(0, secondBytes.length - 1))
    assert.throws(
      () => auditSidecars({ receipts: x.receipts, primaryOut: x.primaryOut, out: x.out, source }),
      /Secondary receipt physical seal mismatch/,
    )
    writeFileSync(secondPath, secondBytes)
    const primaryPath = join(
      x.primaryOut,
      `${String(x.receipt.range.from.number).padStart(12, '0')}-${String(x.receipt.range.to.number).padStart(12, '0')}-${x.receipt.range.to.hash.slice(2)}.json`,
    )
    writeFileSync(primaryPath, JSON.stringify(x.receipt))
    assert.throws(
      () => auditSidecars({ receipts: x.receipts, primaryOut: x.primaryOut, out: x.out, source }),
      /Primary receipts|receipt|physical/i,
    )
  }))

test('two contiguous primary ranges require two secondary sidecars', async () =>
  fixture(async (x) => {
    await collect({
      client: mock(),
      out: x.primaryOut,
      source,
      toBlock: 15,
      range: 3,
      maxChunks: 1,
      rpcHost: 'primary.example',
      now: clock,
      stat,
    })
    const receipts = readValidatedReceipts({ out: x.primaryOut, source })
    assert.equal(receipts.length, 2)
    await corroborate(x, mock())
    const partial = auditSidecars({ receipts, primaryOut: x.primaryOut, out: x.out, source })
    assert.equal(partial.certified, false)
    assert.equal(partial.confirmedCount, 1)
    await corroborate({ ...x, receipt: receipts[1] }, mock())
    assert.equal(
      auditSidecars({ receipts, primaryOut: x.primaryOut, out: x.out, source }).certified,
      false,
    )
  }))
