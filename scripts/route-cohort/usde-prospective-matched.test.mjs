import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'

import { POOL, SUSDE, USDE, collect as collectSegments } from './usde-prospective-entrants.mjs'
import { MAX_BLOCK_AGE_MS } from './usde-susde-matched.mjs'
import {
  MAX_CANDIDATES,
  MAX_SOURCE_AGE_MS,
  PRIVATE_OUTPUT_DIR,
  collectMatched,
  loadSource,
  main,
  validateMatched,
} from './usde-prospective-matched.mjs'

const BORROW = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
const DEPOSIT = parseAbiItem(
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
)
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)
const DEBT = '0x1111111111111111111111111111111111111111'
const OWNER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const USER = '0x4444444444444444444444444444444444444444'
const NOW = Date.UTC(2026, 8, 27, 20)
const hash = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const hex = (n) => `0x${BigInt(n).toString(16)}`
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const ownerAt = (n) => `0x${BigInt(n).toString(16).padStart(40, '0')}`

function event(kind, options = {}) {
  const blockNumber = options.block ?? 104
  const index = options.index ?? 0
  let address, topics, data
  if (kind === 'borrow') {
    address = POOL
    topics = encodeEventTopics({
      abi: [BORROW],
      eventName: 'Borrow',
      args: {
        reserve: USDE,
        onBehalfOf: options.owner ?? OWNER,
        referralCode: 0,
      },
    })
    data = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'uint256' }],
      [USER, 10n, options.mode ?? 2, 0n],
    )
  } else if (kind === 'deposit') {
    address = SUSDE
    topics = encodeEventTopics({
      abi: [DEPOSIT],
      eventName: 'Deposit',
      args: {
        sender: USER,
        owner: options.owner ?? OTHER,
      },
    })
    data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }],
      [10n, options.shares ?? 9n],
    )
  } else {
    address = SUSDE
    topics = encodeEventTopics({
      abi: [TRANSFER],
      eventName: 'Transfer',
      args: {
        from: options.from ?? OWNER,
        to: options.to ?? OTHER,
      },
    })
    data = encodeAbiParameters([{ type: 'uint256' }], [options.shares ?? 9n])
  }
  return {
    address,
    topics,
    data,
    blockNumber: hex(blockNumber),
    blockHash: hash(blockNumber),
    transactionHash: hash(1_000_000 + index),
    logIndex: hex(index),
    removed: false,
  }
}

function scanRpc(events = [], options = {}) {
  return async (method, params) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'finalized' ? 110 : Number(BigInt(params[0]))
      return {
        number: hex(number),
        hash: hash(number),
        parentHash: hash(number - 1),
        timestamp: hex(Math.floor(NOW / 1000) - (110 - number) * 12 - 1200),
      }
    }
    if (method === 'eth_getLogs') {
      const filter = params[0]
      const from = Number(BigInt(filter.fromBlock)),
        to = Number(BigInt(filter.toBlock))
      return events.filter((log) => {
        const block = Number(BigInt(log.blockNumber))
        return (
          block >= from &&
          block <= to &&
          log.address === filter.address &&
          log.topics[0].toLowerCase() === filter.topics[0].toLowerCase() &&
          (!filter.topics[1] || log.topics[1].toLowerCase() === filter.topics[1].toLowerCase())
        )
      })
    }
    throw new Error(`unexpected scanner method ${method}`)
  }
}

async function fixture(events) {
  const dir = await mkdtemp(join(tmpdir(), 'usde-prospective-source-'))
  await collectSegments({
    rpcRead: scanRpc(events),
    peerRpcRead: scanRpc(events),
    fromBlock: 100,
    out: dir,
    now: () => new Date(NOW),
  })
  const names = (await readdir(dir)).sort()
  const segmentSha256s = await Promise.all(
    names.map(async (name) => sha256(await readFile(join(dir, name)))),
  )
  const source = await loadSource({ dir, fromBlock: 100, segmentSha256s })
  return { dir, source, segmentSha256s }
}

function reserveWords() {
  const words = Array.from({ length: 11 }, () => '0'.repeat(64))
  words[10] = DEBT.slice(2).padStart(64, '0')
  return `0x${words.join('')}`
}

function client(overrides = {}) {
  const block = overrides.block ?? {
    number: 112n,
    hash: hash(112),
    timestamp: BigInt(Math.floor((NOW - 60_000) / 1000)),
  }
  return {
    getChainId: async () => overrides.chainId ?? 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      assert.ok(blockTag === 'finalized' || blockNumber === block.number)
      return blockTag === 'finalized' ? block : (overrides.afterBlock ?? block)
    },
    request: async ({ method, params }) => {
      assert.equal(method, 'eth_call')
      assert.equal(params[0].to, POOL)
      assert.equal(params[1], hex(block.number))
      return overrides.reserve ?? reserveWords()
    },
    readContract: async ({ address, functionName, args, blockNumber }) => {
      assert.equal(blockNumber, block.number)
      if (address.toLowerCase() === DEBT && functionName === 'UNDERLYING_ASSET_ADDRESS')
        return overrides.underlying ?? USDE
      if (address.toLowerCase() === DEBT && functionName === 'POOL') return overrides.pool ?? POOL
      if (address.toLowerCase() === DEBT && functionName === 'decimals')
        return overrides.debtDecimals ?? 18
      if (address.toLowerCase() === USDE && functionName === 'decimals')
        return overrides.assetDecimals ?? 18
      if (address.toLowerCase() === SUSDE && functionName === 'asset')
        return overrides.vaultAsset ?? USDE
      if (address.toLowerCase() === SUSDE && functionName === 'decimals')
        return overrides.shareDecimals ?? 18
      if (address.toLowerCase() === SUSDE && functionName === 'totalAssets')
        return overrides.totalAssets ?? 1000n
      if (functionName === 'balanceOf' && args?.[0] === overrides.missingOwner)
        throw new Error('incomplete wallet read')
      if (address.toLowerCase() === DEBT && functionName === 'balanceOf')
        return overrides.debtByOwner?.[args[0]] ?? overrides.debt ?? 5n
      if (address.toLowerCase() === SUSDE && functionName === 'balanceOf')
        return overrides.sharesByOwner?.[args[0]] ?? overrides.shares ?? 4n
      if (address.toLowerCase() === SUSDE && functionName === 'convertToAssets')
        return overrides.holding ?? args[0]
      throw new Error(`unexpected ${functionName}`)
    },
  }
}

const eventSet = () => [
  event('borrow', { owner: OWNER, index: 0 }),
  event('deposit', { owner: OTHER, index: 1 }),
  event('transfer', { from: OWNER, to: OTHER, index: 2 }),
  event('transfer', { from: USER, to: OTHER, shares: 0n, index: 3 }),
]

function reseal(document) {
  const { documentSha256: _old, ...body } = document
  return { ...body, documentSha256: sha256(JSON.stringify(body)) }
}

test('verified source retains full positive-activity union and explicit physical hashes', async () => {
  const f = await fixture(eventSet())
  try {
    assert.deepEqual(f.source.candidates, [
      { owner: OWNER, sourceLabel: 'both' },
      { owner: OTHER, sourceLabel: 'vault' },
    ])
    assert.equal(f.source.coverage.variableBorrowEvents, 1)
    assert.equal(f.source.coverage.vaultActivityEvents, 2)
    assert.equal(f.source.coverage.segmentCount, 1)
    await assert.rejects(
      () => loadSource({ dir: f.dir, fromBlock: 100, segmentSha256s: [sha256('wrong')] }),
      /usde_prospective_match_source_hash_mismatch/,
    )
    await assert.rejects(
      () => loadSource({ dir: f.dir, fromBlock: 101, segmentSha256s: f.segmentSha256s }),
      /usde_prospective_match_source_verification_failed/,
    )
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('complete finalized read gives exact lesser-of overlap and distinct all-depositor assets', async () => {
  const f = await fixture(eventSet())
  try {
    const result = await collectMatched(client(), f.source, () => NOW)
    assert.equal(result.status, 'ok')
    const doc = result.document
    assert.equal(doc.candidateWalletCount, 2)
    assert.equal(doc.completeWalletCount, 2)
    assert.equal(doc.unknownWalletCount, 0)
    assert.equal(doc.matchedRaw, '8')
    assert.equal(doc.destinationVaultTotalAssetsRaw, '1000')
    assert.equal(doc.rows[0].sourceLabel, 'both')
    assert.equal(doc.rows[1].sourceLabel, 'vault')
    assert.equal(doc.blockHash, hash(112))
    assert.equal(doc.collectionElapsedMs, 0)
    assert.equal(validateMatched(doc, f.source), doc)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('quiet scanner means none observed, while complete candidates with no overlap mean exact zero', async () => {
  const quiet = await fixture([])
  const active = await fixture(eventSet())
  try {
    const none = await collectMatched(client(), quiet.source, () => NOW)
    assert.equal(none.status, 'none_observed')
    assert.equal(none.data, null)
    assert.equal(none.window.fromBlock, 100)
    assert.equal(none.window.throughBlock, 110)
    assert.equal(none.window.sourceManifestSha256, quiet.source.coverage.sourceManifestSha256)
    assert.ok(none.window.sourceCaptureAgeSeconds >= 0)
    const zero = await collectMatched(client({ debt: 0n }), active.source, () => NOW)
    assert.equal(zero.status, 'ok')
    assert.equal(zero.document.matchedRaw, '0')
    assert.equal(zero.document.completeWalletCount, 2)
  } finally {
    await rm(quiet.dir, { recursive: true, force: true })
    await rm(active.dir, { recursive: true, force: true })
  }
})

test('over-capacity is explicit before RPC and never measures a subset', async () => {
  const events = [
    ...Array.from({ length: 126 }, (_, i) =>
      event('borrow', { owner: ownerAt(i + 10_000), index: i }),
    ),
    ...Array.from({ length: 125 }, (_, i) =>
      event('deposit', { owner: ownerAt(i + 20_000), index: i + 126 }),
    ),
  ]
  const f = await fixture(events)
  try {
    assert.equal(f.source.candidates.length, MAX_CANDIDATES + 1)
    const result = await collectMatched(
      {
        getChainId: () => {
          throw new Error('RPC must not run')
        },
      },
      f.source,
      () => NOW,
    )
    assert.equal(result.status, 'over_capacity')
    assert.equal(result.candidateWalletCount, 251)
    assert.equal(result.cap, MAX_CANDIDATES)
    assert.equal(result.data, null)
    assert.equal(result.window.throughBlock, 110)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('old quiet and over-capacity sources report stale window without any RPC', async () => {
  const quiet = await fixture([])
  const active = await fixture(eventSet())
  const noRpc = {
    getChainId: () => {
      throw new Error('RPC must not run')
    },
  }
  try {
    const old = NOW + MAX_SOURCE_AGE_MS + 1
    const empty = await collectMatched(noRpc, quiet.source, () => old)
    assert.equal(empty.status, 'source_stale')
    assert.equal(empty.candidateWalletCount, 0)
    assert.equal(empty.data, null)
    assert.ok(empty.window.sourceCaptureAgeSeconds >= MAX_SOURCE_AGE_MS / 1000)
    const over = {
      ...active.source,
      candidates: Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({
        owner: ownerAt(i + 10_000),
        sourceLabel: 'borrow',
      })),
    }
    const staleCap = await collectMatched(noRpc, over, () => old)
    assert.equal(staleCap.status, 'source_stale')
    assert.equal(staleCap.candidateWalletCount, MAX_CANDIDATES + 1)
    const staleActive = await collectMatched(noRpc, active.source, () => old)
    assert.equal(staleActive.status, 'source_stale')
  } finally {
    await rm(quiet.dir, { recursive: true, force: true })
    await rm(active.dir, { recursive: true, force: true })
  }
})

test('one failed wallet, identity mismatch, or hash change cannot seal an aggregate', async () => {
  const f = await fixture(eventSet())
  try {
    for (const changed of [
      { missingOwner: OWNER },
      { underlying: SUSDE },
      { pool: SUSDE },
      { debtDecimals: 6 },
      { assetDecimals: 6 },
      { vaultAsset: DEBT },
      { shareDecimals: 6 },
      {
        afterBlock: {
          number: 112n,
          hash: hash(999),
          timestamp: BigInt(Math.floor((NOW - 60_000) / 1000)),
        },
      },
    ])
      await assert.rejects(() => collectMatched(client(changed), f.source, () => NOW))
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('source and finalized freshness are rechecked after slow wallet collection', async () => {
  const f = await fixture(eventSet())
  try {
    let calls = 0
    const slow = await collectMatched(client(), f.source, () => NOW + 1000 * calls++)
    assert.equal(slow.document.collectionElapsedMs, 1000)
    calls = 0
    await assert.rejects(
      () => collectMatched(client(), f.source, () => NOW + (calls++ ? MAX_BLOCK_AGE_MS : 0)),
      /usde_prospective_match_finalized_header_stale/,
    )
    const stale = await collectMatched(client(), f.source, () => NOW + MAX_SOURCE_AGE_MS + 1)
    assert.equal(stale.status, 'source_stale')
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('offline validation rejects resealed row, coverage and aggregate corruption', async () => {
  const f = await fixture(eventSet())
  try {
    const doc = (await collectMatched(client(), f.source, () => NOW)).document
    const row = structuredClone(doc)
    row.rows[0].matchedRaw = '5'
    assert.throws(() => validateMatched(reseal(row), f.source), /row_bounds_invalid/)
    const missing = structuredClone(doc)
    missing.rows.pop()
    assert.throws(() => validateMatched(reseal(missing), f.source), /document_identity_invalid/)
    const source = structuredClone(doc)
    source.sourceManifestSha256 = sha256('other')
    assert.throws(() => validateMatched(reseal(source), f.source), /document_identity_invalid/)
  } finally {
    await rm(f.dir, { recursive: true, force: true })
  }
})

test('CLI requires source physical SHA and independent output SHA; output is immutable', async () => {
  const f = await fixture(eventSet())
  const out = join(PRIVATE_OUTPUT_DIR, `usde-prospective-match-test-${randomUUID()}.json`)
  const args = [
    '--source-dir',
    f.dir,
    '--from-block',
    '100',
    '--segment-sha256',
    f.segmentSha256s[0],
    '--out',
    out,
  ]
  try {
    await assert.rejects(
      () => main(['--run', ...args.slice(0, -1), join(tmpdir(), 'public-reading.json')]),
      /output_path_not_private/,
    )
    await assert.rejects(
      () =>
        main([
          '--run',
          ...args.slice(0, -1),
          resolve(PRIVATE_OUTPUT_DIR, '../../../components/Carry/route-capital.json'),
        ]),
      /output_path_not_private/,
    )
    await assert.rejects(
      () =>
        main([
          '--verify',
          ...args.slice(0, -1),
          join(tmpdir(), 'public-reading.json'),
          '--out-sha256',
          sha256('wrong'),
        ]),
      /output_path_not_private/,
    )
    await assert.rejects(
      () => main(['--run', '--source-dir', f.dir, '--from-block', '100', '--out', out]),
      /cli_invalid/,
    )
    const sealed = await main(['--run', ...args], { client: client(), clock: () => NOW })
    assert.equal(sealed.status, 'sealed')
    const verified = await main(['--verify', ...args, '--out-sha256', sealed.outputSha256])
    assert.equal(verified.status, 'verified')
    assert.equal(verified.matchedRaw, '8')
    await assert.rejects(() => main(['--run', ...args], { client: client(), clock: () => NOW }), {
      code: 'EEXIST',
    })
    await assert.rejects(
      () => main(['--verify', ...args, '--out-sha256', sha256('wrong')]),
      /output_hash_mismatch/,
    )
    await writeFile(out, `${await readFile(out, 'utf8')} `)
    await assert.rejects(
      () => main(['--verify', ...args, '--out-sha256', sealed.outputSha256]),
      /output_hash_mismatch/,
    )
  } finally {
    await rm(f.dir, { recursive: true, force: true })
    await unlink(out).catch(() => {})
  }
})
