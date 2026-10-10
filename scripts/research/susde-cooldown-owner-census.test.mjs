import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FIRST_CODE_BLOCK,
  ROUTE,
  WITHDRAW_TOPIC,
  WINDOW_BLOCKS,
  captureSusdeCooldownOwnerSegment,
  cliOptions,
  collectSusdeCooldownOwnerSegment,
  normalizeWithdrawLogs,
  ownersFromSusdeCooldownArtifact,
  readSusdeCooldownOwnerArtifact,
  verifySusdeCooldownOwnerArtifact,
} from './susde-cooldown-owner-census.mjs'

const A = FIRST_CODE_BLOCK
const SENDER = '0x1111111111111111111111111111111111111111'
const OWNER = '0x2222222222222222222222222222222222222222'
const OTHER_OWNER = '0x3333333333333333333333333333333333333333'
const topic = (value) => `0x${value.slice(2).padStart(64, '0')}`
const word = (value) => BigInt(value).toString(16).padStart(64, '0')
const hash = (number) =>
  number === A ? ROUTE.firstCodeHash : `0x${BigInt(number).toString(16).padStart(64, '0')}`
const header = (number) => ({
  number: `0x${number.toString(16)}`,
  hash: hash(number),
  parentHash: hash(number - 1),
  timestamp: `0x${(1_700_000_000 + number - A).toString(16)}`,
})
const log = ({
  block = A + 1,
  sender = SENDER,
  owner = OWNER,
  logIndex = 0,
  assets = 7n,
  shares = 5n,
} = {}) => ({
  address: ROUTE.vault,
  topics: [WITHDRAW_TOPIC, topic(sender), topic(ROUTE.silo), topic(owner)],
  data: `0x${word(assets)}${word(shares)}`,
  blockNumber: `0x${block.toString(16)}`,
  blockHash: hash(block),
  transactionHash: `0x${BigInt(block * 100 + logIndex)
    .toString(16)
    .padStart(64, '0')}`,
  transactionIndex: '0x0',
  logIndex: `0x${logIndex.toString(16)}`,
  removed: false,
})
const resign = (artifact) => {
  const copy = structuredClone(artifact)
  const { sha256: _old, ...body } = copy
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
}

function transport({
  rows = [log()],
  missingOnAnkr = false,
  rateLimit = false,
  oversize = false,
  onCancel,
  corruptBoundary = false,
  requests = [],
} = {}) {
  return async (url, init) => {
    const request = JSON.parse(init.body)
    const ankr = url.includes('ankr.com')
    requests.push({
      host: ankr ? 'ankr' : 'infura',
      method: request.method,
      params: request.params,
    })
    if (rateLimit && request.method === 'eth_getLogs')
      return new Response('rate limited', { status: 429 })
    let result
    if (request.method === 'eth_chainId') result = '0x1'
    else if (request.method === 'eth_getBlockByNumber') {
      const value = request.params[0]
      const number = value === 'finalized' ? A + WINDOW_BLOCKS + 100 : Number(BigInt(value))
      result = header(number)
      if (corruptBoundary && number === A + WINDOW_BLOCKS)
        result.parentHash = hash(A + WINDOW_BLOCKS - 2)
    } else if (request.method === 'eth_getLogs') {
      const filter = request.params[0]
      const first = Number(BigInt(filter.fromBlock))
      const last = Number(BigInt(filter.toBlock))
      result = (ankr && missingOnAnkr ? rows.slice(1) : rows).filter(
        (row) =>
          Number(BigInt(row.blockNumber)) >= first && Number(BigInt(row.blockNumber)) <= last,
      )
    } else throw Error('unexpected method')
    if (oversize && request.method === 'eth_getLogs')
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1))
          },
          cancel() {
            onCancel?.()
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const URLS = ['https://mainnet.infura.io/v3/fixture', 'https://rpc.ankr.com/eth/fixture']
const collect = (input = {}) =>
  collectSusdeCooldownOwnerSegment({
    fromBlock: A,
    toBlock: A + 2,
    urls: URLS,
    fetchImpl: transport(input),
    sleepImpl: async () => {},
    nowMs: () => 1_700_000_100_000,
  })

test('receiver is the indexed silo topic while owner is wildcard and may differ from sender', async () => {
  const requests = []
  const { artifact, rpcBudget } = await collect({ requests })
  assert.equal(artifact.logs.length, 1)
  assert.deepEqual(artifact.logs[0], {
    blockNumber: A + 1,
    blockHash: hash(A + 1),
    transactionHash: log().transactionHash,
    transactionIndex: 0,
    logIndex: 0,
    sender: SENDER,
    receiver: ROUTE.silo,
    owner: OWNER,
    assetsRaw: '7',
    sharesRaw: '5',
  })
  assert.deepEqual(ownersFromSusdeCooldownArtifact(artifact), [OWNER])
  assert.deepEqual(requests.find((item) => item.method === 'eth_getLogs').params[0].topics, [
    WITHDRAW_TOPIC,
    null,
    topic(ROUTE.silo),
  ])
  assert.equal(artifact.windows[0].fromBlock, A)
  assert.equal(artifact.windows[0].toBlock, A + 2)
  assert.equal(artifact.originHosts[0], 'mainnet.infura.io')
  assert.equal(artifact.originHosts[1], 'rpc.ankr.com')
  assert.ok(rpcBudget.calls <= 90)
  assert.ok(verifySusdeCooldownOwnerArtifact(artifact))
})

test('a provider omission fails even when remaining rows look valid', async () => {
  const rows = [log(), log({ block: A + 2, owner: OTHER_OWNER, logIndex: 1 })]
  await assert.rejects(collect({ rows, missingOnAnkr: true }), /provider_log_divergence/)
})

test('a dense range can be retried as fixed smaller windows', async () => {
  const { artifact } = await collectSusdeCooldownOwnerSegment({
    fromBlock: A,
    toBlock: A + 2,
    windowBlocks: 1,
    urls: URLS,
    fetchImpl: transport(),
    sleepImpl: async () => {},
    nowMs: () => 1_700_000_100_000,
  })
  assert.equal(artifact.windows.length, 3)
  assert.equal(artifact.windowBlocks, 1)
  assert.deepEqual(ownersFromSusdeCooldownArtifact(artifact), [OWNER])
})

test('two successful 10k windows cover the boundary once with exact rows', async () => {
  const requests = []
  const rows = [
    log({ block: A + WINDOW_BLOCKS - 1, owner: OWNER }),
    log({ block: A + WINDOW_BLOCKS, owner: OTHER_OWNER }),
  ]
  const { artifact } = await collectSusdeCooldownOwnerSegment({
    fromBlock: A,
    toBlock: A + WINDOW_BLOCKS,
    urls: URLS,
    fetchImpl: transport({ rows, requests }),
    sleepImpl: async () => {},
    nowMs: () => 1_700_000_100_000,
  })
  assert.deepEqual(
    artifact.windows.map(({ fromBlock, toBlock, logCount }) => [fromBlock, toBlock, logCount]),
    [
      [A, A + WINDOW_BLOCKS - 1, 1],
      [A + WINDOW_BLOCKS, A + WINDOW_BLOCKS, 1],
    ],
  )
  assert.deepEqual(
    artifact.logs.map((row) => row.blockNumber),
    [A + WINDOW_BLOCKS - 1, A + WINDOW_BLOCKS],
  )
  assert.deepEqual(ownersFromSusdeCooldownArtifact(artifact), [OWNER, OTHER_OWNER])
  assert.equal(requests.filter((item) => item.method === 'eth_getLogs').length, 4)
})

test('duplicate log index and receiver mismatch fail closed', () => {
  const first = log()
  const start = { hash: hash(A), number: A }
  const end = { hash: hash(A + 2), number: A + 2 }
  assert.throws(() => normalizeWithdrawLogs([first, first], A, A + 2, start, end), /log_duplicate/)
  const wrongReceiver = {
    ...first,
    topics: [WITHDRAW_TOPIC, topic(SENDER), topic(OWNER), topic(OWNER)],
  }
  assert.throws(
    () => normalizeWithdrawLogs([wrongReceiver], A, A + 2, start, end),
    /receiver_filter_mismatch/,
  )
})

test('window boundary mismatch and offline coverage gap fail closed', async () => {
  await assert.rejects(
    collectSusdeCooldownOwnerSegment({
      fromBlock: A,
      toBlock: A + WINDOW_BLOCKS,
      urls: URLS,
      fetchImpl: transport({ rows: [], corruptBoundary: true }),
      sleepImpl: async () => {},
      nowMs: () => 1_700_000_100_000,
    }),
    /window_boundary_invalid/,
  )
  const { artifact } = await collect({ rows: [] })
  const gap = resign({ ...artifact, windows: [{ ...artifact.windows[0], fromBlock: A + 1 }] })
  assert.throws(() => verifySusdeCooldownOwnerArtifact(gap), /artifact_window_gap/)
})

test('tampering fails both the body seal and a recomputed window digest', async () => {
  const { artifact } = await collect()
  const changed = structuredClone(artifact)
  changed.logs[0].assetsRaw = '8'
  assert.throws(() => verifySusdeCooldownOwnerArtifact(changed), /artifact_seal_invalid/)
  assert.throws(
    () => verifySusdeCooldownOwnerArtifact(resign(changed)),
    /artifact_window_digest_invalid/,
  )
})

test('rate limit and oversized responses are errors, not shortened log sets', async () => {
  await assert.rejects(collect({ rateLimit: true }), /rpc_rate_limited/)
  let cancelled = 0
  await assert.rejects(
    collect({ oversize: true, onCancel: () => cancelled++ }),
    /response_oversize/,
  )
  assert.equal(cancelled, 2)
})

test('disk floor rejects capture before any RPC request', async () => {
  let called = false
  await assert.rejects(
    captureSusdeCooldownOwnerSegment({
      outPath: '/tmp/susde-owner-census-guard-fixture.json',
      fromBlock: A,
      toBlock: A,
      urls: URLS,
      freeBytesImpl: () => 0,
      fetchImpl: async () => {
        called = true
        throw Error('unexpected RPC')
      },
    }),
    /disk_floor/,
  )
  assert.equal(called, false)
})

test('capture writes one new artifact and offline verifier can read it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'susde-owner-census-'))
  const outPath = join(directory, 'slice.json')
  try {
    const options = {
      fromBlock: A,
      toBlock: A + 2,
      urls: URLS,
      outPath,
      fetchImpl: transport(),
      sleepImpl: async () => {},
      nowMs: () => 1_700_000_100_000,
      freeBytesImpl: () => 2 * 1024 ** 3,
    }
    const result = await captureSusdeCooldownOwnerSegment(options)
    assert.equal(result.nextFromBlock, A + 3)
    assert.equal((await readSusdeCooldownOwnerArtifact(outPath)).sha256, result.artifact.sha256)
    assert.match(await readFile(outPath, 'utf8'), /"owner": "0x2222/)
    let repeatedRpc = false
    await assert.rejects(
      captureSusdeCooldownOwnerSegment({
        ...options,
        fetchImpl: async () => {
          repeatedRpc = true
          throw Error('unexpected RPC')
        },
      }),
      /out_exists/,
    )
    assert.equal(repeatedRpc, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI range stays at or after deployment and within one 100k slice', () => {
  assert.deepEqual(cliOptions(['--capture', `--from=${A}`, '--blocks=100000', '--out=x.json']), {
    mode: '--capture',
    fromBlock: A,
    toBlock: A + 99_999,
    windowBlocks: WINDOW_BLOCKS,
    outPath: 'x.json',
  })
  assert.deepEqual(
    cliOptions([
      '--capture',
      `--from=${A}`,
      '--blocks=10000',
      '--window-blocks=1000',
      '--out=x.json',
    ]).windowBlocks,
    1_000,
  )
  assert.throws(
    () => cliOptions(['--capture', `--from=${A}`, '--blocks=100001', '--out=x.json']),
    /range_invalid/,
  )
  assert.throws(
    () => cliOptions(['--capture', `--from=${A - 1}`, '--blocks=1', '--out=x.json']),
    /range_invalid/,
  )
  assert.throws(
    () =>
      cliOptions([
        '--capture',
        `--from=${A}`,
        '--blocks=100000',
        '--window-blocks=1000',
        '--out=x.json',
      ]),
    /window_range_invalid/,
  )
})
