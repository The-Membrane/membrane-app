import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'

import { GHO, POOL, collect } from './prospective-entrants.mjs'
import {
  loadProspectiveBorrowers,
  MAX_PROSPECTIVE_OWNERS,
  readProspectiveOverlap,
} from './prospective-matched.mjs'
import { GHO_SGHO } from '../route-rates/exact-leg-spread.mjs'

const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`
const hex = (n) => `0x${n.toString(16).padStart(64, '0')}`
const owner = addr(11)
const delegate = addr(12)
const debtToken = addr(13)
const vault = GHO_SGHO.destination.toLowerCase()
const start = 26_069_513
const roomyDisk = () => ({ bavail: 2_000_000_000, bsize: 1 })
const BORROW = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)

const header = (n) => ({
  number: `0x${n.toString(16)}`,
  hash: hex(n + 1000),
  parentHash: hex(n + 999),
  timestamp: `0x${(Math.floor(Date.parse('2026-09-27T14:55:00Z') / 1000) + n - start).toString(16)}`,
})

function borrow(mode = 2) {
  return {
    address: POOL,
    blockNumber: `0x${start.toString(16)}`,
    blockHash: header(start).hash,
    transactionHash: hex(mode + 40),
    logIndex: '0x0',
    removed: false,
    topics: encodeEventTopics({
      abi: [BORROW],
      eventName: 'Borrow',
      args: { reserve: GHO, onBehalfOf: owner, referralCode: 0 },
    }),
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }],
      [delegate, 100n, mode, 1n],
    ),
  }
}

async function sealed(logs = [], witnessed = logs.length > 0) {
  const out = mkdtempSync(join(tmpdir(), 'prospective-matched-'))
  const rpcRead = async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber')
      return header(params[0] === 'finalized' ? start : Number(BigInt(params[0])))
    if (method === 'eth_getLogs') {
      const q = params[0]
      return logs.filter((log) => log.address === q.address && log.topics[0] === q.topics[0])
    }
    throw new Error(`unexpected ${method}`)
  }
  await collect({
    rpcRead,
    peerRpcRead: witnessed ? rpcRead : undefined,
    fromBlock: start,
    out,
    stat: roomyDisk,
  })
  return out
}

function client({ failHolding = false } = {}) {
  const calls = []
  return {
    calls,
    getChainId: async () => 1,
    getBlock: async () => ({
      number: BigInt(start + 1),
      hash: hex(999),
      timestamp: BigInt(Math.floor(Date.parse('2026-09-27T15:00:00Z') / 1000)),
    }),
    request: async () => {
      const words = Array(11).fill('0'.repeat(64))
      words[10] = debtToken.slice(2).padStart(64, '0')
      return `0x${words.join('')}`
    },
    readContract: async (call) => {
      calls.push(call)
      if (call.functionName === 'UNDERLYING_ASSET_ADDRESS') return GHO
      if (call.functionName === 'POOL') return POOL
      if (call.functionName === 'asset') return GHO
      if (call.functionName === 'decimals') return 18
      if (call.functionName === 'balanceOf' && call.address.toLowerCase() === debtToken)
        return 8n * 10n ** 18n
      if (call.functionName === 'balanceOf' && call.address.toLowerCase() === vault) {
        if (failHolding) throw new Error('RPC unavailable')
        return 10n * 10n ** 18n
      }
      if (call.functionName === 'convertToAssets') return 9n * 10n ** 18n
      throw new Error(`unexpected ${call.functionName}`)
    },
  }
}

test('quiet verified coverage reports none observed, never zero capital', async () => {
  const out = await sealed()
  try {
    const cohort = loadProspectiveBorrowers({ out, fromBlock: start })
    assert.deepEqual(cohort.owners, [])
    assert.equal(cohort.coverage.throughBlock, start)
    assert.equal(cohort.coverage.segmentCount, 1)
    assert.equal((await readProspectiveOverlap({}, cohort)).status, 'none_observed')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('candidate is variable-rate debt owner, not delegate; August exclusion remains separate', async () => {
  const out = await sealed([borrow(2), borrow(1)])
  try {
    const cohort = loadProspectiveBorrowers({ out, fromBlock: start })
    assert.deepEqual(cohort.owners, [owner])
    assert.equal(cohort.coverage.variableBorrowEvents, 1)
    assert.deepEqual(
      loadProspectiveBorrowers({ out, fromBlock: start, excludedOwners: [owner] }).owners,
      [],
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('a single-provider variable Borrow cannot become a numeric prospective sample', async () => {
  const out = await sealed([borrow()], false)
  try {
    assert.throws(
      () => loadProspectiveBorrowers({ out, fromBlock: start }),
      /prospective_variable_borrow_unwitnessed/,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('same-finalized-block current debt/holding overlap is aggregate-only', async () => {
  const out = await sealed([borrow()])
  try {
    const cohort = loadProspectiveBorrowers({ out, fromBlock: start })
    const fake = client()
    const result = await readProspectiveOverlap(fake, cohort, Date.parse('2026-09-27T15:05:00Z'))
    assert.equal(result.status, 'ok')
    assert.equal(result.data.matchedGho, 8)
    assert.equal(result.data.candidateWalletCount, 1)
    assert.equal(result.data.unknownWalletCount, 0)
    assert.equal(JSON.stringify(result).includes(owner), false)
    assert.equal(
      fake.calls.every((call) => call.blockNumber === BigInt(start + 1)),
      true,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('a lagging finalized provider cannot read state before the sealed source frontier', async () => {
  const out = await sealed([borrow()])
  try {
    const cohort = loadProspectiveBorrowers({ out, fromBlock: start })
    const fake = client()
    fake.getBlock = async () => ({
      number: BigInt(start - 1),
      hash: hex(998),
      timestamp: BigInt(Math.floor(Date.parse('2026-09-27T15:00:00Z') / 1000)),
    })
    await assert.rejects(
      readProspectiveOverlap(fake, cohort, Date.parse('2026-09-27T15:05:00Z')),
      /prospective_finalized_block_before_source/,
    )
    assert.equal(fake.calls.length, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('a stale discovery frontier does not create a fresh capital reading', async () => {
  const out = await sealed([borrow()])
  try {
    const cohort = loadProspectiveBorrowers({ out, fromBlock: start })
    cohort.coverage.throughBlockTime = '2026-09-25T00:00:00.000Z'
    const fake = client()
    const result = await readProspectiveOverlap(fake, cohort, Date.parse('2026-09-27T15:05:00Z'))
    assert.equal(result.status, 'source_stale')
    assert.equal(fake.calls.length, 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('unknown wallet read suppresses aggregate and over-capacity never truncates', async () => {
  const out = await sealed([borrow()])
  try {
    const cohort = loadProspectiveBorrowers({ out, fromBlock: start })
    const result = await readProspectiveOverlap(
      client({ failHolding: true }),
      cohort,
      Date.parse('2026-09-27T15:05:00Z'),
    )
    assert.equal(result.status, 'incomplete')
    assert.equal(result.data.matchedGho, null)
    assert.equal(result.data.unknownWalletCount, 1)
    const huge = {
      ...cohort,
      owners: Array.from({ length: MAX_PROSPECTIVE_OWNERS + 1 }, (_, i) => addr(i + 100)),
    }
    assert.equal((await readProspectiveOverlap({}, huge)).status, 'over_capacity')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
