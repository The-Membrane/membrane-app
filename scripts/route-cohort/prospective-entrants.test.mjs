import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'

import { appendSegment, collect, GHO, POOL, SGHO, verify } from './prospective-entrants.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`
const owner = addr(11)
const BORROW = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const roomyDisk = () => ({ bavail: 2_000_000_000, bsize: 1 })
const temporary = () => mkdtempSync(join(tmpdir(), 'carry-entrants-'))

function header(n) {
  return {
    number: `0x${n.toString(16)}`,
    hash: hash(n + 1000),
    parentHash: hash(n + 999),
    timestamp: `0x${(1_700_000_000 + n).toString(16)}`,
  }
}

function eventLogs(block = 1, borrowMode = 2) {
  const base = {
    blockNumber: `0x${block.toString(16)}`,
    blockHash: header(block).hash,
    transactionHash: hash(77),
    removed: false,
  }
  return [
    {
      ...base,
      address: POOL,
      logIndex: '0x0',
      topics: encodeEventTopics({
        abi: [BORROW],
        eventName: 'Borrow',
        args: { reserve: GHO, onBehalfOf: owner, referralCode: 0 },
      }),
      data: encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }],
        [owner, 100n, borrowMode, 1n],
      ),
    },
    {
      ...base,
      address: SGHO,
      logIndex: '0x1',
      topics: encodeEventTopics({
        abi: [DEPOSIT],
        eventName: 'Deposit',
        args: { sender: owner, owner },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [100n, 90n]),
    },
    {
      ...base,
      address: SGHO,
      logIndex: '0x2',
      topics: encodeEventTopics({
        abi: [TRANSFER],
        eventName: 'Transfer',
        args: { from: addr(0), to: owner },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }], [90n]),
    },
  ]
}

function fakeRpc({
  final = 2,
  logs = [],
  errorKind = null,
  split = false,
  capped = false,
  chain = '0x1',
} = {}) {
  return async (method, params) => {
    if (method === 'eth_chainId') return chain
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? final : Number(BigInt(params[0]))
      return header(n)
    }
    if (method === 'eth_getLogs') {
      const query = params[0]
      const from = Number(BigInt(query.fromBlock)),
        to = Number(BigInt(query.toBlock))
      const kind =
        query.address.toLowerCase() === POOL
          ? 'borrow'
          : query.topics[0].toLowerCase() === eventLogs()[1].topics[0].toLowerCase()
            ? 'deposit'
            : 'transfer'
      if (errorKind === kind || (split && from !== to)) throw new Error('too many results')
      if (capped && kind === 'borrow' && from !== to) return Array(250).fill({})
      return logs.filter(
        (entry) =>
          entry.address.toLowerCase() === query.address.toLowerCase() &&
          entry.topics[0].toLowerCase() === query.topics[0].toLowerCase() &&
          Number(BigInt(entry.blockNumber)) >= from &&
          Number(BigInt(entry.blockNumber)) <= to,
      )
    }
    throw new Error(`unexpected ${method}`)
  }
}

test('quiet atomic three-stream segment is sealed and verifies contiguously', async () => {
  const out = temporary()
  try {
    const result = await collect({
      rpcRead: fakeRpc(),
      fromBlock: 1,
      out,
      maxChunks: 1,
      stat: roomyDisk,
      now: () => new Date('2026-09-27T11:00:00Z'),
    })
    assert.equal(result.throughBlock, 2)
    assert.equal(result.segmentCount, 1)
    const segment = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'))
    assert.deepEqual(
      segment.scans.map((scan) => scan.rawCount),
      [0, 0, 0],
    )
    assert.deepEqual(segment.logs, [])
    assert.ok(segment.captureLagSeconds > 0)
    assert.equal(verify({ out, fromBlock: 1 }).throughBlock, 2)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('two-provider quiet coverage seals agreement at their common finalized head', async () => {
  const out = temporary()
  try {
    const result = await collect({
      rpcRead: fakeRpc({ final: 2 }),
      peerRpcRead: fakeRpc({ final: 1 }),
      fromBlock: 1,
      out,
      stat: roomyDisk,
    })
    assert.equal(result.throughBlock, 1)
    const segment = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'))
    assert.equal(segment.schemaVersion, 3)
    assert.deepEqual(
      segment.peerWitness.scans.map((scan) => scan.rawCount),
      [0, 0, 0],
    )
    assert.equal(verify({ out, fromBlock: 1 }).throughBlock, 1)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('two-provider event agreement seals a witnessed segment', async () => {
  const out = temporary()
  try {
    await collect({
      rpcRead: fakeRpc({ final: 1, logs: eventLogs() }),
      peerRpcRead: fakeRpc({ final: 1, logs: eventLogs() }),
      fromBlock: 1,
      out,
      stat: roomyDisk,
    })
    const segment = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'))
    assert.equal(segment.schemaVersion, 3)
    assert.equal(segment.peerWitness.scans[0].rawCount, 1)
    assert.equal(segment.logs.length, 3)
    assert.equal(verify({ out, fromBlock: 1 }).throughBlock, 1)
    const tampered = temporary()
    try {
      appendSegment(
        tampered,
        {
          ...segment,
          peerWitness: { ...segment.peerWitness, normalizedLogsSha256: '0'.repeat(64) },
        },
        roomyDisk,
      )
      assert.throws(() => verify({ out: tampered, fromBlock: 1 }), /entrant_peer_digest_invalid/)
    } finally {
      rmSync(tampered, { recursive: true, force: true })
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('two-provider log disagreement writes no sealed segment', async () => {
  const out = temporary()
  try {
    await assert.rejects(
      collect({
        rpcRead: fakeRpc({ final: 1, logs: eventLogs() }),
        peerRpcRead: fakeRpc({ final: 1 }),
        fromBlock: 1,
        out,
        stat: roomyDisk,
      }),
      /entrant_peer_logs_mismatch/,
    )
    assert.deepEqual(readdirSync(out), [])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('Borrow, Deposit and Transfer are decoded as candidate evidence, not retained capital', async () => {
  const out = temporary()
  try {
    await collect({
      rpcRead: fakeRpc({ final: 1, logs: eventLogs() }),
      fromBlock: 1,
      out,
      stat: roomyDisk,
    })
    const segment = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'))
    assert.deepEqual(
      segment.scans.map((scan) => scan.rawCount),
      [1, 1, 1],
    )
    assert.equal(segment.logs[0].args.onBehalfOf, owner)
    assert.equal(segment.logs[1].args.owner, owner)
    assert.equal(segment.logs[2].args.to, owner)
    assert.equal(verify({ out, fromBlock: 1 }).segmentCount, 1)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('a non-variable-rate GHO Borrow is retained as candidate evidence, not a segment failure', async () => {
  const out = temporary()
  try {
    await collect({
      rpcRead: fakeRpc({ final: 1, logs: eventLogs(1, 1) }),
      fromBlock: 1,
      out,
      stat: roomyDisk,
    })
    const segment = JSON.parse(readFileSync(join(out, readdirSync(out)[0]), 'utf8'))
    assert.equal(segment.logs[0].args.interestRateMode, 1)
    assert.equal(verify({ out, fromBlock: 1 }).segmentCount, 1)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('a successful response at the conservative silent-cap ceiling is split', async () => {
  const out = temporary()
  try {
    const result = await collect({
      rpcRead: fakeRpc({ capped: true }),
      fromBlock: 1,
      out,
      maxChunks: 2,
      stat: roomyDisk,
    })
    assert.equal(result.appended, 2)
    assert.equal(result.throughBlock, 2)
    assert.deepEqual(
      readdirSync(out)
        .sort()
        .map((name) => name.slice(0, 25)),
      ['000000000001-000000000001', '000000000002-000000000002'],
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('a failed stream writes nothing; near provider cap splits into bounded contiguous leaves', async () => {
  const out = temporary()
  try {
    await assert.rejects(
      collect({ rpcRead: fakeRpc({ errorKind: 'deposit' }), fromBlock: 1, out, stat: roomyDisk }),
      /entrant_ambiguous_singleton/,
    )
    assert.deepEqual(readdirSync(out), [])
    const result = await collect({
      rpcRead: fakeRpc({ split: true }),
      fromBlock: 1,
      out,
      maxChunks: 2,
      stat: roomyDisk,
    })
    assert.equal(result.appended, 2)
    assert.equal(result.throughBlock, 2)
    assert.deepEqual(
      readdirSync(out)
        .sort()
        .map((name) => name.slice(0, 25)),
      ['000000000001-000000000001', '000000000002-000000000002'],
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('wrong chain, missing start, and disk floor reject before append', async () => {
  const out = temporary()
  try {
    await assert.rejects(
      collect({ rpcRead: fakeRpc({ chain: '0xa' }), fromBlock: 1, out, stat: roomyDisk }),
      /mainnet_required/,
    )
    await assert.rejects(collect({ rpcRead: fakeRpc(), out, stat: roomyDisk }), /from_block/)
    await assert.rejects(
      collect({ rpcRead: fakeRpc(), fromBlock: 1, out, stat: () => ({ bavail: 100, bsize: 1 }) }),
      /disk_reserve/,
    )
    assert.deepEqual(readdirSync(out), [])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('physical tamper and a mismatched operator start fail offline verification', async () => {
  const out = temporary()
  try {
    await collect({ rpcRead: fakeRpc(), fromBlock: 1, out, stat: roomyDisk })
    assert.throws(() => verify({ out, fromBlock: 0 }), /segment_invalid/)
    const path = join(out, readdirSync(out)[0])
    writeFileSync(path, `${readFileSync(path, 'utf8')} `)
    assert.throws(() => verify({ out, fromBlock: 1 }), /segment_invalid|artifact/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
