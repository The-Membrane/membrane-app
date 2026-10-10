import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'

import {
  CHUNK_BLOCKS,
  POOL,
  SUSDE,
  USDE,
  appendSegment,
  assertDiskFloor,
  candidateOwners,
  collect,
  main,
  normalizeLog,
  verify,
} from './usde-prospective-entrants.mjs'

const BORROW = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const USER = '0x1111111111111111111111111111111111111111'
const OWNER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const hex = (value) => `0x${BigInt(value).toString(16)}`
const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const NOW = Date.UTC(2026, 8, 27, 19, 0)
const NOW_DATE = () => new Date(NOW)

function block(number, options = {}) {
  const changed = options.changedBlock === number
  return {
    number: hex(number),
    hash: changed ? hash(number + 9000) : hash(number),
    parentHash: hash(number - 1),
    timestamp: hex(Math.floor(NOW / 1000) - (options.head ?? 110) * 12 + number * 12 - 1200),
  }
}

function event(kind, options = {}) {
  const number = options.block ?? 104
  const logIndex = options.index ?? 0
  let topics, data, address
  if (kind === 'borrow') {
    address = POOL
    topics = encodeEventTopics({
      abi: [BORROW],
      eventName: 'Borrow',
      args: {
        reserve: options.reserve ?? USDE,
        onBehalfOf: options.owner ?? OWNER,
        referralCode: 0,
      },
    })
    data = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }],
      [options.user ?? USER, 10n, options.mode ?? 2, 0n],
    )
  } else if (kind === 'deposit') {
    address = SUSDE
    topics = encodeEventTopics({
      abi: [DEPOSIT],
      eventName: 'Deposit',
      args: {
        sender: USER,
        owner: options.owner ?? OWNER,
      },
    })
    data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [options.assets ?? 10n, options.shares ?? 9n],
    )
  } else {
    address = SUSDE
    topics = encodeEventTopics({
      abi: [TRANSFER],
      eventName: 'Transfer',
      args: {
        from: options.from ?? USER,
        to: options.to ?? OTHER,
      },
    })
    data = encodeAbiParameters([{ type: 'uint256' }], [options.shares ?? 9n])
  }
  return {
    address,
    topics,
    data,
    blockNumber: hex(number),
    blockHash: hash(number),
    transactionHash: hash(1_000_000 + number * 100 + logIndex),
    logIndex: hex(logIndex),
    removed: false,
  }
}

function rpc(events = [], options = {}) {
  const head = options.head ?? 110
  return async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'finalized' ? head : Number(BigInt(params[0]))
      return block(number, { head, changedBlock: options.changedBlock })
    }
    if (method === 'eth_getLogs') {
      const filter = params[0]
      const from = Number(BigInt(filter.fromBlock))
      const to = Number(BigInt(filter.toBlock))
      if (
        options.forceSplit &&
        to > from &&
        to - from >= 9 &&
        filter.address.toLowerCase() === POOL
      )
        return Array.from({ length: 250 }, (_, i) => ({ i }))
      if (options.forceSingletonCap && from === to && filter.address.toLowerCase() === POOL)
        return Array.from({ length: 250 }, (_, i) => ({ i }))
      return events.filter(
        (item) =>
          Number(BigInt(item.blockNumber)) >= from &&
          Number(BigInt(item.blockNumber)) <= to &&
          item.address.toLowerCase() === filter.address.toLowerCase() &&
          item.topics[0].toLowerCase() === filter.topics[0].toLowerCase(),
      )
    }
    throw new Error(`unexpected ${method}`)
  }
}

function folder() {
  return mkdtempSync(join(tmpdir(), 'usde-prospective-'))
}
function saved(dir) {
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  return files.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
}

test('quiet finalized range seals contiguous three-stream coverage and offline verifies', async () => {
  const out = folder()
  try {
    const result = await collect({
      rpcRead: rpc(),
      peerRpcRead: rpc(),
      fromBlock: 100,
      out,
      now: NOW_DATE,
    })
    assert.equal(result.appended, 1)
    assert.equal(result.throughBlock, 110)
    assert.equal(result.hostCount, 2)
    const segment = saved(out)[0]
    assert.equal(segment.coverage, 'two_rpc_readers_exact_agreement_not_provider_independence')
    assert.equal(segment.peerWitness.distinctHostnames, false)
    assert.deepEqual(
      segment.scans.map((entry) => entry.rawCount),
      [0, 0, 0],
    )
    assert.deepEqual(segment.candidates.variableBorrowOwners, [])
    assert.equal(segment.firstObservedAt, new Date(NOW).toISOString())
    assert.equal(verify({ out, fromBlock: 100 }).throughBlock, 110)
    assert.equal((await main(['--verify', '--from-block', '100', '--out', out])).segmentCount, 1)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('delegated Borrow uses onBehalfOf owner; nonvariable Borrow is evidence, not candidate', async () => {
  const out = folder()
  try {
    const events = [
      event('borrow', { index: 0, user: USER, owner: OWNER, mode: 2 }),
      event('borrow', { index: 1, user: USER, owner: OTHER, mode: 1 }),
      event('deposit', { index: 2, owner: OWNER }),
      event('transfer', { index: 3, from: USER, to: OTHER }),
    ]
    await collect({
      rpcRead: rpc(events),
      peerRpcRead: rpc(events),
      fromBlock: 100,
      out,
      now: NOW_DATE,
    })
    const segment = saved(out)[0]
    assert.equal(segment.logs.length, 4)
    assert.deepEqual(segment.candidates.variableBorrowOwners, [OWNER])
    assert.deepEqual(segment.candidates.vaultActivityOwners, [USER, OWNER, OTHER].sort())
    assert.notEqual(segment.logs[0].args.user, segment.logs[0].args.onBehalfOf)
    assert.equal(verify({ out, fromBlock: 100 }).throughBlock, 110)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('wrong reserve is rejected and mode 1 never becomes a variable borrower', () => {
  assert.throws(
    () => normalizeLog(event('borrow', { reserve: SUSDE }), 'borrow', 100, 110),
    /usde_scan_borrow_identity_mismatch/,
  )
  const stable = normalizeLog(event('borrow', { mode: 1 }), 'borrow', 100, 110)
  assert.deepEqual(candidateOwners([stable]).variableBorrowOwners, [])
})

test('zero-share vault events stay as raw evidence but do not seed activity owners', () => {
  const zeroDeposit = normalizeLog(event('deposit', { shares: 0n }), 'deposit', 100, 110)
  const zeroTransfer = normalizeLog(event('transfer', { shares: 0n }), 'transfer', 100, 110)
  assert.equal(zeroDeposit.args.sharesRaw, '0')
  assert.equal(zeroTransfer.args.sharesRaw, '0')
  assert.deepEqual(candidateOwners([zeroDeposit, zeroTransfer]).vaultActivityOwners, [])
  const nonzeroTransfer = normalizeLog(event('transfer', { shares: 1n }), 'transfer', 100, 110)
  assert.deepEqual(candidateOwners([nonzeroTransfer]).vaultActivityOwners, [USER, OTHER].sort())
})

test('peer log disagreement or block-hash divergence never seals a segment', async () => {
  const out = folder()
  try {
    const events = [event('borrow')]
    await assert.rejects(
      () =>
        collect({ rpcRead: rpc(events), peerRpcRead: rpc(), fromBlock: 100, out, now: NOW_DATE }),
      /usde_scan_peer_logs_mismatch/,
    )
    assert.deepEqual(readdirSync(out), [])
    await assert.rejects(
      () =>
        collect({
          rpcRead: rpc(),
          peerRpcRead: rpc([], { changedBlock: 110 }),
          fromBlock: 100,
          out,
          now: NOW_DATE,
        }),
      /usde_scan_peer_chain_mismatch/,
    )
    assert.deepEqual(readdirSync(out), [])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('saved frontier hash is rechecked before appending after a reorg', async () => {
  const out = folder()
  try {
    await collect({ rpcRead: rpc(), fromBlock: 100, out, now: NOW_DATE })
    await assert.rejects(
      () =>
        collect({
          rpcRead: rpc([], { head: 120, changedBlock: 110 }),
          fromBlock: 100,
          out,
          now: NOW_DATE,
        }),
      /usde_scan_frontier_reorg/,
    )
    assert.equal(verify({ out, fromBlock: 100 }).segmentCount, 1)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('CLI chooses distinct healthy hostnames, checks log support, and labels single-host fallback', async () => {
  const out = folder()
  const outSingle = folder()
  try {
    const made = []
    const makeClient = (url) => {
      made.push(new URL(url).hostname)
      const read = rpc()
      return {
        getChainId: async () => 1,
        getBlock: async () => ({ number: 110n, hash: hash(110) }),
        request: ({ method, params }) => read(method, params),
      }
    }
    const paired = await main(['--run', '--from-block', '100', '--out', out], {
      rpcUrls:
        'https://one.invalid/secretA,https://one.invalid/secretB,https://two.invalid/secretC',
      makeClient,
      now: NOW_DATE,
    })
    assert.equal(paired.hostCount, 2)
    assert.equal(paired.preflightRpcCalls, 12)
    assert.ok(paired.rpcCalls > paired.preflightRpcCalls)
    assert.deepEqual(made, ['one.invalid', 'two.invalid'])
    assert.equal(
      saved(out)[0].coverage,
      'two_rpc_readers_exact_agreement_not_provider_independence',
    )
    assert.equal(saved(out)[0].peerWitness.distinctHostnames, true)
    assert.ok(!readFileSync(join(out, readdirSync(out)[0]), 'utf8').includes('secret'))

    const one = await main(['--run', '--from-block', '100', '--out', outSingle], {
      rpcUrls: 'https://bad.invalid/token,https://good.invalid/token',
      now: NOW_DATE,
      makeClient: (url) => {
        const read = rpc()
        return {
          getChainId: async () => 1,
          getBlock: async () => ({ number: 110n, hash: hash(110) }),
          request: ({ method, params }) => {
            if (url.includes('bad.invalid') && method === 'eth_getLogs')
              throw new Error('provider unavailable')
            return read(method, params)
          },
        }
      },
    })
    assert.equal(one.hostCount, 1)
    assert.equal(saved(outSingle)[0].coverage, 'single_host')
    assert.equal(saved(outSingle)[0].peerWitness.distinctHostnames, false)
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(outSingle, { recursive: true, force: true })
  }
})

test('response caps split a bounded range; single-block ambiguity fails closed', async () => {
  const out = folder()
  try {
    const result = await collect({
      rpcRead: rpc([], { head: 109, forceSplit: true }),
      fromBlock: 100,
      out,
      maxChunks: 2,
      now: NOW_DATE,
    })
    assert.equal(result.segmentCount, 2)
    assert.equal(result.throughBlock, 109)
    assert.equal(verify({ out, fromBlock: 100 }).segmentCount, 2)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
  const singleton = folder()
  try {
    await assert.rejects(
      () =>
        collect({
          rpcRead: rpc([], { head: 110, forceSingletonCap: true }),
          fromBlock: 110,
          out: singleton,
          now: NOW_DATE,
        }),
      /usde_scan_ambiguous_singleton/,
    )
    assert.deepEqual(readdirSync(singleton), [])
  } finally {
    rmSync(singleton, { recursive: true, force: true })
  }
})

test('explicit bounds, 1 GiB floor, physical hash, and immutability are enforced', async () => {
  const out = folder()
  try {
    assert.equal(CHUNK_BLOCKS, 1000)
    assert.throws(() => verify({ out }), /usde_scan_explicit_from_block_required/)
    assert.throws(
      () => assertDiskFloor(out, () => ({ bavail: 0, bsize: 1 })),
      /usde_scan_disk_reserve_reached/,
    )
    await assert.rejects(
      () => collect({ rpcRead: rpc(), fromBlock: 100, out, maxChunks: 5 }),
      /usde_scan_invalid_max_chunks/,
    )
    await collect({ rpcRead: rpc(), fromBlock: 100, out, now: NOW_DATE })
    const segment = saved(out)[0]
    assert.throws(() => appendSegment(out, segment), { code: 'EEXIST' })
    assert.throws(() => verify({ out, fromBlock: 101 }), /usde_scan_segment_invalid/)
    const path = join(out, readdirSync(out)[0])
    writeFileSync(path, `${readFileSync(path, 'utf8')} `)
    assert.throws(() => verify({ out, fromBlock: 100 }), /usde_scan_segment_invalid/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('future block time cannot seal a negative first-observed lag', async () => {
  const out = folder()
  try {
    await assert.rejects(
      () =>
        collect({
          rpcRead: rpc(),
          fromBlock: 100,
          out,
          now: () => new Date(NOW - 3_600_000),
        }),
      /usde_scan_negative_capture_lag/,
    )
    assert.deepEqual(readdirSync(out), [])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
