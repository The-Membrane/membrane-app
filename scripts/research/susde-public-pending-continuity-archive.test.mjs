import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SILO, VAULT, WITHDRAW_TOPIC, seal } from './susde-public-pending-exit-common.mjs'
import {
  tickContinuity,
  verifyContinuityArchive,
} from './susde-public-pending-continuity-archive.mjs'

const H = '0x1111111111111111111111111111111111111111'
const TX = `0x${'c'.repeat(64)}`
const hash = (number) => `0x${BigInt(number).toString(16).padStart(64, '0')}`
const issue = {
  sequence: 3,
  sha256: 'issue-hash',
  holder: H,
  anchor: { blockNumber: '100', blockHash: hash(100) },
}
const delivery = {
  sha256: 'delivery-hash',
  transactionHash: TX,
  origins: [{ block: { number: '0xc3', hash: hash(195) }, receipt: { transactionIndex: '0x2' } }],
}
const pinned = {
  issue,
  delivery,
  start: 101n,
  end: 195n,
  anchorHash: hash(100),
  deliveryHash: hash(195),
  payoutTxIndex: 2n,
}
const loadTarget = async () => pinned
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`
const header = (number) => ({
  number: `0x${number.toString(16)}`,
  hash: hash(number),
  parentHash: hash(number - 1),
  timestamp: '0x68df2460',
})
const withdraw = (block) => ({
  address: VAULT,
  topics: [WITHDRAW_TOPIC, topic(H), topic(SILO), topic(H)],
  data: `0x${'0'.repeat(127)}1`,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: hash(block),
  transactionHash: TX,
  transactionIndex: '0x1',
  logIndex: '0x1',
  removed: false,
})
const peer = (provider, options = {}) => {
  const calls = []
  const request = async (method, params) => {
    calls.push({ method, params })
    if (method === 'eth_chainId') {
      if (options.chainFailure) throw Error('public_rpc_unavailable')
      return '0x1'
    }
    if (method === 'eth_getBlockByNumber') {
      const n = Number(BigInt(params[0]))
      const value = header(n)
      if (options.badHash && n === 101) value.hash = hash(999)
      return value
    }
    if (method === 'eth_getLogs') {
      if (
        options.transportFailure ||
        (options.failFrom && BigInt(params[0].fromBlock) >= BigInt(options.failFrom))
      )
        throw Error('public_rpc_unavailable')
      return options.withWithdraw &&
        BigInt(params[0].fromBlock) <= 105n &&
        BigInt(params[0].toBlock) >= 105n
        ? [withdraw(105)]
        : []
    }
    throw Error('unexpected_mock_rpc')
  }
  return { provider, request, calls }
}
const out = () => mkdtemp(join(tmpdir(), 'susde-continuity-'))
const tick = (directory, peers) =>
  tickContinuity({
    out: directory,
    clients: () => peers,
    loadTarget,
    now: () => new Date('2026-10-02T02:00:00.000Z'),
  })

test('resumes strict ascending 10-block windows and completes without attribution', async () => {
  const directory = await out()
  const a = peer('https://alchemy.example')
  const b = peer('https://ankr.example')
  const first = await tick(directory, [a, b])
  assert.equal(first.status, 'advanced')
  assert.equal(first.appended, 8)
  assert.equal(first.coveredThroughBlock, '180')
  const second = await tick(directory, [a, b])
  assert.equal(second.status, 'complete')
  assert.equal(second.appended, 2)
  const verified = await verifyContinuityArchive(directory, undefined, undefined, loadTarget)
  assert.equal(verified.summary.startBlock, '101')
  assert.equal(verified.summary.endBlock, '195')
  assert.equal(verified.summary.complete, true)
  assert.equal(verified.summary.windows, 10)
  assert.equal(verified.summary.observedWithdrawLogs, 0)
  assert.deepEqual(verified.summary.providerHostPairs, ['alchemy.example|ankr.example'])
  assert.deepEqual(
    verified.rows.map((row) => row.fromBlock),
    ['101', '111', '121', '131', '141', '151', '161', '171', '181', '191'],
  )
  assert.equal(verified.rows.at(-1).toBlock, '195')
  assert.equal(
    verified.rows.every((row) => row.episodeAttribution === 'unresolved'),
    true,
  )
  assert.equal(a.calls.filter((call) => call.method === 'eth_getLogs').length, 10)
})

test('seals a separate issue 6 window under its own issue identity', async () => {
  const directory = await out()
  const loadIssue6 = async () => ({ ...pinned, issue: { ...issue, sequence: 6 } })
  const result = await tickContinuity({
    issueSequence: 6,
    out: directory,
    clients: () => [peer('https://alchemy.example'), peer('https://ankr.example')],
    loadTarget: loadIssue6,
    now: () => new Date('2026-10-02T02:00:00.000Z'),
  })
  assert.equal(result.status, 'advanced')
  assert.equal(result.issueSequence, 6)
  const verified = await verifyContinuityArchive(directory, undefined, undefined, loadIssue6, 6)
  assert.equal(verified.rows.length, 8)
  assert.ok(verified.rows.every((row) => row.issueSequence === 6))
})

test('new issue uses a larger bounded holder-filtered window without changing prior archives', async () => {
  const directory = await out()
  const loadIssue8 = async () => ({ ...pinned, issue: { ...issue, sequence: 8 } })
  const a = peer('https://infura.example')
  const b = peer('https://ankr.example')
  const result = await tickContinuity({
    issueSequence: 8,
    out: directory,
    clients: () => [a, b],
    loadTarget: loadIssue8,
    now: () => new Date('2026-10-02T02:00:00.000Z'),
  })
  assert.equal(result.status, 'complete')
  assert.equal(result.appended, 1)
  const verified = await verifyContinuityArchive(directory, undefined, undefined, loadIssue8, 8)
  assert.equal(verified.rows[0].fromBlock, '101')
  assert.equal(verified.rows[0].toBlock, '195')
  assert.equal(verified.summary.complete, true)
})

test('standalone disk reserve prevents RPC calls and ledger writes', async () => {
  const directory = await out()
  const a = peer('https://alchemy.example')
  const b = peer('https://ankr.example')
  const result = await tickContinuity({
    out: directory,
    clients: () => [a, b],
    loadTarget,
    freeBytes: async () => 1024n * 1024n * 1024n - 1n,
  })
  assert.equal(result.status, 'susde_continuity_disk_reserve')
  assert.equal(result.appended, 0)
  assert.equal(a.calls.length + b.calls.length, 0)
  assert.equal(
    (await verifyContinuityArchive(directory, undefined, undefined, loadTarget)).rows.length,
    0,
  )
})

test('same-host variants and origin boundary disagreements cannot seal a window', async () => {
  const directory = await out()
  for (const alias of ['http://same.example.', 'https://www.same.example']) {
    const sameHost = await tick(directory, [peer('https://same.example'), peer(alias)])
    assert.equal(sameHost.status, 'susde_continuity_origins_unavailable')
  }
  const disagreed = await tick(directory, [
    peer('https://a.example'),
    peer('https://b.example', { badHash: true }),
  ])
  assert.equal(disagreed.status, 'susde_continuity_origin_disagreement')
  assert.equal(
    (await verifyContinuityArchive(directory, undefined, undefined, loadTarget)).rows.length,
    0,
  )
})

test('transport-failed origin is skipped, but matched pre-payout Withdraw stays ambiguous', async () => {
  const directory = await out()
  const result = await tick(directory, [
    peer('https://a.example', { withWithdraw: true }),
    peer('https://infura.example', { chainFailure: true }),
    peer('https://c.example', { withWithdraw: true }),
  ])
  assert.equal(result.status, 'advanced')
  assert.equal(result.appended, 8)
  const verified = await verifyContinuityArchive(directory, undefined, undefined, loadTarget)
  assert.equal(verified.summary.observedWithdrawLogs, 1)
  assert.equal(verified.summary.preDeliveryWithdrawLogs, 1)
  assert.equal(verified.rows[0].episodeAttribution, 'unresolved')
})

test('resealed cursor tamper fails replay; partial transport failure seals no current window', async () => {
  const directory = await out()
  const failed = await tick(directory, [
    peer('https://a.example'),
    peer('https://b.example', { transportFailure: true }),
  ])
  assert.equal(failed.status, 'susde_continuity_rpc_unavailable')
  assert.equal(
    (await verifyContinuityArchive(directory, undefined, undefined, loadTarget)).rows.length,
    0,
  )
  await tick(directory, [peer('https://a.example'), peer('https://b.example')])
  const file = join(directory, '00000008.json')
  const row = JSON.parse(await readFile(file, 'utf8'))
  const { sha256, ...body } = row
  void sha256
  await writeFile(file, `${JSON.stringify(seal({ ...body, fromBlock: '999' }))}\n`)
  await assert.rejects(
    verifyContinuityArchive(directory, undefined, undefined, loadTarget),
    /susde_continuity_row_invalid/,
  )
})

test('a successful partial witness cannot be contradicted by a later fallback pair', async () => {
  const directory = await out()
  const result = await tick(directory, [
    peer('https://a.example'),
    peer('https://b.example', { transportFailure: true }),
    peer('https://c.example', { badHash: true }),
  ])
  assert.equal(result.status, 'susde_continuity_origin_disagreement')
  assert.equal(
    (await verifyContinuityArchive(directory, undefined, undefined, loadTarget)).rows.length,
    0,
  )
})

test('a later transport failure preserves earlier sealed windows only', async () => {
  const directory = await out()
  const result = await tick(directory, [
    peer('https://a.example'),
    peer('https://b.example', { failFrom: 111 }),
  ])
  assert.equal(result.status, 'susde_continuity_rpc_unavailable')
  assert.equal(result.appended, 1)
  const verified = await verifyContinuityArchive(directory, undefined, undefined, loadTarget)
  assert.equal(verified.summary.coveredThroughBlock, '110')
  assert.equal(verified.summary.complete, false)
})

test('measured Alchemy and Ankr hosts are tried first in seven-origin configuration', async () => {
  const directory = await out()
  const providers = [
    peer('https://eth-mainnet.g.alchemy.com'),
    peer('https://mainnet.infura.io', { transportFailure: true }),
    peer('https://rpc.ankr.com'),
    peer('https://example.ethereum-mainnet.quiknode.pro', { transportFailure: true }),
    peer('https://lb.drpc.live', { transportFailure: true }),
    peer('https://rpc.mevblocker.io', { transportFailure: true }),
    peer('https://rpc.flashbots.net', { transportFailure: true }),
  ]
  const result = await tick(directory, providers)
  assert.equal(result.status, 'advanced')
  assert.equal(result.appended, 8)
  assert.equal(
    providers[0].calls.some((call) => call.method === 'eth_getLogs'),
    true,
  )
  assert.equal(
    providers[2].calls.some((call) => call.method === 'eth_getLogs'),
    true,
  )
  for (const index of [1, 3, 4, 5, 6])
    assert.equal(
      providers[index].calls.some((call) => call.method === 'eth_getLogs'),
      false,
    )
})
