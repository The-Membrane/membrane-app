import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CHUNK_BLOCKS,
  DEPLOYMENT_BLOCK,
  MIN_FREE_BYTES,
  PROXY,
  UPGRADED_TOPIC,
  checkDisk,
  collect,
  main,
  verify,
} from './sgho-upgrade-history.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const h = (n) => ({ number: hash(n), hash: hash(n + 100), parentHash: hash(n + 99) })
const target = { block: DEPLOYMENT_BLOCK + 3, hash: h(DEPLOYMENT_BLOCK + 3).hash }
const topicAddress = (n) => `0x${'0'.repeat(24)}${n.toString(16).padStart(40, '0')}`
const event = (n) => ({
  address: PROXY,
  topics: [UPGRADED_TOPIC, topicAddress(7)],
  data: '0x',
  blockNumber: hash(n),
  blockHash: h(n).hash,
  transactionHash: hash(n + 1000),
  logIndex: '0x0',
  removed: false,
})
const ampleDisk = () => ({ bavail: 2 * MIN_FREE_BYTES, bsize: 1 })

function reader({
  events = [],
  mismatch = false,
  wrongTarget = false,
  wrongParentAt,
  chain = 1,
} = {}) {
  return async (method, params) => {
    if (method === 'eth_chainId') return hash(chain)
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? target.block + 10 : Number(BigInt(params[0]))
      const result = h(n)
      if (wrongTarget && n === target.block) result.hash = hash(999)
      if (n === wrongParentAt) result.parentHash = hash(888)
      return result
    }
    if (method === 'eth_getLogs') {
      const from = Number(BigInt(params[0].fromBlock))
      const to = Number(BigInt(params[0].toBlock))
      const logs = events.filter(
        (e) => Number(BigInt(e.blockNumber)) >= from && Number(BigInt(e.blockNumber)) <= to,
      )
      return mismatch ? logs.map((e) => ({ ...e, topics: [e.topics[0], topicAddress(8)] })) : logs
    }
    throw new Error('unexpected method')
  }
}

function withDir(fn) {
  const out = mkdtempSync(join(tmpdir(), 'sgho-upgrades-'))
  return Promise.resolve(fn(out)).finally(() => rmSync(out, { recursive: true, force: true }))
}

test('quiet chunks seal immutably and offline replay reaches exact target', () =>
  withDir(async (out) => {
    const first = await collect({
      out,
      target,
      rpcRead: reader(),
      peerRpcRead: reader(),
      windowBlocks: 2,
      maxChunks: 1,
      stat: ampleDisk,
    })
    assert.equal(first.throughBlock, DEPLOYMENT_BLOCK + 1)
    assert.equal(first.fullEventRange, false)
    assert.equal(first.segments.length, 1)
    assert.equal(first.upgrades.length, 0)
    const second = await collect({
      out,
      target,
      rpcRead: reader(),
      peerRpcRead: reader(),
      windowBlocks: 2,
      maxChunks: 1,
      stat: ampleDisk,
    })
    assert.equal(second.fullEventRange, true)
    assert.equal(second.segments.length, 2)
    assert.equal(second.upgrades.length, 0)
    assert.equal(second.slotWriteCoverage, 'event_only')
    assert.deepEqual(verify({ out, target }).segments, second.segments)
    assert.equal(readdirSync(out).filter((name) => name.endsWith('.json')).length, 2)
  }))

test('upgrades retain implementation and exact block/transaction/log order', () =>
  withDir(async (out) => {
    const events = [event(DEPLOYMENT_BLOCK), event(DEPLOYMENT_BLOCK + 2)]
    const result = await collect({
      out,
      target,
      rpcRead: reader({ events }),
      peerRpcRead: reader({ events }),
      maxChunks: 1,
      stat: ampleDisk,
    })
    assert.equal(result.upgrades.length, 2)
    assert.equal(result.upgrades[0].implementation, `0x${'7'.padStart(40, '0')}`)
    assert.equal(result.upgrades[1].blockNumber, DEPLOYMENT_BLOCK + 2)
    assert.equal(verify({ out, target }).upgrades.length, 2)
  }))

test('provider disagreement and target mismatch fail without seal', () =>
  withDir(async (out) => {
    const events = [event(DEPLOYMENT_BLOCK)]
    await assert.rejects(
      collect({
        out,
        target,
        rpcRead: reader({ events }),
        peerRpcRead: reader({ events, mismatch: true }),
        stat: ampleDisk,
      }),
      /provider_logs_mismatch/,
    )

    assert.equal(readdirSync(out).length, 0)
    await assert.rejects(
      collect({
        out,
        target,
        rpcRead: reader(),
        peerRpcRead: reader({ wrongTarget: true }),
        stat: ampleDisk,
      }),
      /header_mismatch/,
    )
    assert.equal(readdirSync(out).length, 0)
  }))

test('adjacent pinned boundary ancestry fails live and offline replay', () =>
  withDir(async (out) => {
    const broken = reader({ wrongParentAt: DEPLOYMENT_BLOCK + 1 })
    await assert.rejects(
      collect({
        out,
        target,
        rpcRead: broken,
        peerRpcRead: broken,
        windowBlocks: 2,
        stat: ampleDisk,
      }),
      /pinned_ancestry_invalid/,
    )
    assert.equal(readdirSync(out).length, 0)

    await collect({
      out,
      target,
      rpcRead: reader(),
      peerRpcRead: reader(),
      windowBlocks: 2,
      stat: ampleDisk,
    })
    const oldName = readdirSync(out)[0]
    const segment = JSON.parse(readFileSync(join(out, oldName), 'utf8'))
    segment.toHeader.parentHash = hash(888)
    const bytes = JSON.stringify(segment)
    const digest = createHash('sha256').update(bytes).digest('hex')
    rmSync(join(out, oldName))
    writeFileSync(
      join(
        out,
        `${String(segment.fromBlock).padStart(12, '0')}-${String(segment.toBlock).padStart(12, '0')}-${digest}.json`,
      ),
      bytes,
    )
    assert.throws(() => verify({ out, target }), /pinned_ancestry_invalid/)
  }))

test('tampering, gaps, and alternate target cannot replay as full history', () =>
  withDir(async (out) => {
    await collect({
      out,
      target,
      rpcRead: reader(),
      peerRpcRead: reader(),
      windowBlocks: 2,
      maxChunks: 2,
      stat: ampleDisk,
    })
    const names = readdirSync(out).sort()
    assert.equal(names.length, 2)
    assert.throws(
      () => verify({ out, target: { block: target.block, hash: hash(999) } }),
      /segment_invalid/,
    )
    rmSync(join(out, names[0]))
    assert.throws(() => verify({ out, target }), /segment_invalid/)
    const one = join(out, names[1])
    const bytes = readFileSync(one, 'utf8')
    writeFileSync(one, bytes.replace('event_only', 'event_fake'))
    assert.throws(() => verify({ out, target }), /hash_mismatch/)
  }))

test('disk floor and chunk cap fail closed before RPC/sealing', () =>
  withDir(async (out) => {
    const insufficient = () => ({ bavail: MIN_FREE_BYTES - 1, bsize: 1 })
    assert.throws(() => checkDisk(out, insufficient), /disk_reserve_reached/)
    await assert.rejects(
      collect({
        out,
        target,
        rpcRead: reader(),
        peerRpcRead: reader(),
        maxChunks: 5,
        stat: ampleDisk,
      }),
      /bound_invalid/,
    )
    await assert.rejects(
      collect({ out, target, rpcRead: reader(), peerRpcRead: reader(), stat: insufficient }),
      /disk_reserve_reached/,
    )
    assert.equal(readdirSync(out).length, 0)
  }))

test('CLI refuses live host selection omission and silently verifies offline', () =>
  withDir(async (out) => {
    assert.equal(CHUNK_BLOCKS, 5000)
    await assert.rejects(main(['--run', '--out', out]), /rpc_host_selection_required/)
    const result = await main(['--verify', '--out', out])
    assert.equal(result.fullEventRange, false)
    assert.equal(result.throughBlock, DEPLOYMENT_BLOCK - 1)
  }))
