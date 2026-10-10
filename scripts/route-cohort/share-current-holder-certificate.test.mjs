import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionResult, parseAbiItem } from 'viem'
import { append as appendJournal, sourceAnchor } from './alchemy-share-discovery.mjs'
import { TOKENS, TRANSFER_TOPIC, collect } from './share-transfer-source.mjs'
import {
  MAX_CANDIDATES,
  UNDERLYING,
  assertFeasibleCandidateCount,
  collectPage,
  finalize,
  loadManifest,
  main,
  prepare,
  promote,
  reconcile,
  verify,
} from './share-current-holder-certificate.mjs'

const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const address = (n) => `0x${n.toString(16).padStart(40, '0')}`
const topic = (a) => `0x${a.slice(2).padStart(64, '0')}`
const stat = () => ({ bavail: 2_000_000_000, bsize: 1 })
const config = {
  chainId: 1,
  token: 'sGHO',
  address: TOKENS.sGHO,
  deploymentBlock: 10,
  startBlock: 10,
}
const header = (n) => ({
  number: `0x${n.toString(16)}`,
  hash: hash(n),
  parentHash: hash(n - 1),
  timestamp: `0x${n.toString(16)}`,
})
const logs = [
  {
    address: TOKENS.sGHO,
    topics: [TRANSFER_TOPIC, topic(address(0)), topic(address(1))],
    data: hash(2),
    blockNumber: '0xa',
    blockHash: hash(10),
    transactionHash: hash(101),
    logIndex: '0x0',
  },
  {
    address: TOKENS.sGHO,
    topics: [TRANSFER_TOPIC, topic(address(1)), topic(address(2))],
    data: hash(1),
    blockNumber: '0xb',
    blockHash: hash(11),
    transactionHash: hash(102),
    logIndex: '0x0',
  },
]
const rpc = async (method, params) => {
  if (method === 'eth_chainId') return '0x1'
  if (method === 'eth_getBlockByNumber')
    return header(params[0] === 'finalized' ? 11 : Number(BigInt(params[0])))
  if (method === 'eth_getCode') return params[1]?.blockHash === hash(9) ? '0x' : '0x6001'
  if (method === 'eth_getLogs')
    return logs.filter(
      (l) =>
        Number(BigInt(l.blockNumber)) >= Number(BigInt(params[0].fromBlock)) &&
        Number(BigInt(l.blockNumber)) <= Number(BigInt(params[0].toBlock)),
    )
  throw Error('unexpected method')
}

const zeroSlot = `0x${'0'.repeat(64)}`
const assets = parseAbiItem('function asset() view returns (address)')
const supply = parseAbiItem('function totalSupply() view returns (uint256)')
const balance = parseAbiItem('function balanceOf(address) view returns (uint256)')
const selectors = {
  asset: '0x38d52e0f',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
}
const reading =
  (
    balances = new Map([
      [address(1), 1n],
      [address(2), 1n],
    ]),
    assetAddress = UNDERLYING.sGHO,
  ) =>
  async (method, params) => {
    if (method === 'eth_getStorageAt') return zeroSlot
    if (method === 'eth_getCode' && typeof params[1] === 'object') return '0x6001'
    if (method === 'eth_call') {
      const data = params[0].data.toLowerCase()
      if (data.startsWith(selectors.asset))
        return encodeFunctionResult({ abi: [assets], functionName: 'asset', result: assetAddress })
      if (data.startsWith(selectors.totalSupply))
        return encodeFunctionResult({ abi: [supply], functionName: 'totalSupply', result: 2n })
      if (data.startsWith(selectors.balanceOf)) {
        const owner = `0x${data.slice(-40)}`
        return encodeFunctionResult({
          abi: [balance],
          functionName: 'balanceOf',
          result: balances.get(owner) ?? 0n,
        })
      }
    }
    return rpc(method, params)
  }

test('the two-hour certificate window has a hard candidate/page feasibility cap', () => {
  assert.equal(MAX_CANDIDATES, 2_048)
  assert.doesNotThrow(() => assertFeasibleCandidateCount(MAX_CANDIDATES))
  for (const count of [0, MAX_CANDIDATES + 1, NaN, 1.5])
    assert.throws(() => assertFeasibleCandidateCount(count), /candidate_count_infeasible/)
})

test('disk reserve rejects every writer before lock, directory, artifact or RPC', async () => {
  const root = mkdtempSync(join(tmpdir(), 'share-disk-guard-'))
  const out = join(root, 'never-created')
  let rpcCalls = 0
  const forbiddenRead = async () => {
    rpcCalls++
    throw Error('RPC must not be called below disk floor')
  }
  const lowDisk = () => ({ bavail: 0, bsize: 1 })
  try {
    await assert.rejects(
      prepare({
        sourceDir: join(root, 'no-source'),
        out,
        config,
        rpcRead: forbiddenRead,
        peerRpcRead: forbiddenRead,
        stat: lowDisk,
      }),
      /disk_reserve_reached/,
    )
    await assert.rejects(
      collectPage({
        sourceDir: join(root, 'no-source'),
        out,
        config,
        page: 0,
        rpcRead: forbiddenRead,
        stat: lowDisk,
      }),
      /disk_reserve_reached/,
    )
    assert.throws(
      () => finalize({ sourceDir: join(root, 'no-source'), out, config, stat: lowDisk }),
      /disk_reserve_reached/,
    )
    assert.equal(rpcCalls, 0)
    assert.equal(existsSync(out), false)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('full source reconciles exact B, but promotion lacks independent attestation', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'share-cert-source-'))
  const out = mkdtempSync(join(tmpdir(), 'share-cert-out-'))
  try {
    await collect({
      out: sourceDir,
      config,
      rpcRead: rpc,
      peerRpcRead: rpc,
      stat,
      now: () => new Date(11_000),
    })
    await prepare({
      sourceDir,
      out,
      config,
      rpcRead: reading(),
      peerRpcRead: reading(),
      stat,
      now: () => new Date(11_000),
    })
    await collectPage({
      sourceDir,
      out,
      config,
      page: 0,
      rpcRead: reading(),
      stat,
      now: () => new Date(71_000),
    })
    const aggregate = reconcile({ sourceDir, out, config })
    assert.equal(aggregate.totalSupplyRaw, '2')
    assert.equal(aggregate.positiveHolderCount, 2)
    assert.equal(aggregate.contiguousSourceFromDeployment, true)
    assert.equal(aggregate.blockTimestamp, 11)
    assert.equal(aggregate.captureStartedAt, new Date(11_000).toISOString())
    assert.equal(aggregate.captureCompletedAt, new Date(71_000).toISOString())
    assert.equal(aggregate.ageAtCaptureSeconds, 60)
    assert.equal(aggregate.maxCaptureAgeSeconds, 7_200)
    assert.equal(aggregate.freshness, 'historical_as_of_only')
    finalize({ sourceDir, out, config, stat })
    const replay = verify({ sourceDir, out, config })
    assert.equal(replay.candidateCount, 2)
    assert.equal(replay.freshness, 'historical_as_of_only')
    assert.equal(replay.blockTimestamp, 11)
    assert.throws(() => promote(), /attestation_missing/)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('partial history can reconcile by equality; an omitted positive holder cannot', async () => {
  const partial = { ...config, startBlock: 11 }
  const sourceDir = mkdtempSync(join(tmpdir(), 'share-partial-source-'))
  const out = mkdtempSync(join(tmpdir(), 'share-partial-out-'))
  try {
    await collect({
      out: sourceDir,
      config: partial,
      rpcRead: rpc,
      peerRpcRead: rpc,
      stat,
      now: () => new Date(11_000),
    })
    await prepare({
      sourceDir,
      out,
      config: partial,
      rpcRead: reading(),
      peerRpcRead: reading(),
      stat,
      now: () => new Date(11_000),
    })
    await collectPage({
      sourceDir,
      out,
      config: partial,
      page: 0,
      rpcRead: reading(),
      stat,
      now: () => new Date(11_000),
    })
    assert.throws(() => reconcile({ sourceDir, out, config: partial }), /supply_mismatch/)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }

  const equalSource = mkdtempSync(join(tmpdir(), 'share-equal-source-'))
  const equalOut = mkdtempSync(join(tmpdir(), 'share-equal-out-'))
  try {
    await collect({
      out: equalSource,
      config: partial,
      rpcRead: rpc,
      peerRpcRead: rpc,
      stat,
      now: () => new Date(11_000),
    })
    const onlyBob = reading(new Map([[address(2), 2n]]))
    await prepare({
      sourceDir: equalSource,
      out: equalOut,
      config: partial,
      rpcRead: onlyBob,
      peerRpcRead: onlyBob,
      stat,
      now: () => new Date(11_000),
    })
    await collectPage({
      sourceDir: equalSource,
      out: equalOut,
      config: partial,
      page: 0,
      rpcRead: onlyBob,
      stat,
      now: () => new Date(11_000),
    })
    const aggregate = reconcile({ sourceDir: equalSource, out: equalOut, config: partial })
    assert.equal(aggregate.contiguousSourceFromDeployment, false)
    assert.equal(aggregate.positiveHolderCount, 1)
  } finally {
    rmSync(equalSource, { recursive: true, force: true })
    rmSync(equalOut, { recursive: true, force: true })
  }
})

test('wrong underlying, stale or invalid page, and replayed stale seal fail closed', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'share-guard-source-'))
  const out = mkdtempSync(join(tmpdir(), 'share-guard-out-'))
  try {
    await collect({
      out: sourceDir,
      config,
      rpcRead: rpc,
      peerRpcRead: rpc,
      stat,
      now: () => new Date(11_000),
    })
    await prepare({
      sourceDir,
      out,
      config,
      rpcRead: reading(),
      peerRpcRead: reading(),
      stat,
      now: () => new Date(11_000),
    })
    await assert.rejects(
      collectPage({
        sourceDir,
        out,
        config,
        page: 0,
        rpcRead: reading(undefined, address(999)),
        stat,
        now: () => new Date(11_000),
      }),
      /asset_identity_invalid/,
    )
    await assert.rejects(
      collectPage({
        sourceDir,
        out,
        config,
        page: 0,
        rpcRead: reading(),
        stat,
        now: () => new Date(7_212_000),
      }),
      /page_window_expired/,
    )
    await assert.rejects(
      collectPage({ sourceDir, out, config, page: -1, rpcRead: reading(), stat }),
      /page_invalid/,
    )
    assert.equal(readdirSync(out).filter((name) => name.startsWith('page-')).length, 0)
    await collectPage({
      sourceDir,
      out,
      config,
      page: 0,
      rpcRead: reading(),
      stat,
      now: () => new Date(11_000),
    })
    const oldName = readdirSync(out).find((name) => name.startsWith('page-'))
    const oldPath = join(out, oldName)
    const forged = JSON.parse(readFileSync(oldPath, 'utf8'))
    forged.capturedAt = new Date(7_212_000).toISOString()
    const bytes = Buffer.from(JSON.stringify(forged))
    const digest = createHash('sha256').update(bytes).digest('hex')
    unlinkSync(oldPath)
    writeFileSync(join(out, `page-000000-${digest}.json`), bytes)
    assert.throws(() => reconcile({ sourceDir, out, config }), /page_replay_invalid/)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('a verified source suffix may grow after the manifest freezes its exact-B prefix', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'share-prefix-source-'))
  const out = mkdtempSync(join(tmpdir(), 'share-prefix-out-'))
  try {
    await collect({
      out: sourceDir,
      config,
      rpcRead: rpc,
      peerRpcRead: rpc,
      windowBlocks: 1,
      stat,
      now: () => new Date(10_000),
    })
    const onlyFirst = reading(new Map([[address(1), 2n]]))
    await prepare({
      sourceDir,
      out,
      config,
      rpcRead: onlyFirst,
      peerRpcRead: onlyFirst,
      stat,
      now: () => new Date(10_000),
    })
    await collect({
      out: sourceDir,
      config,
      rpcRead: rpc,
      peerRpcRead: rpc,
      windowBlocks: 1,
      stat,
      now: () => new Date(11_000),
    })
    assert.equal(loadManifest({ sourceDir, out, config }).manifest.block, 10)
    await collectPage({
      sourceDir,
      out,
      config,
      page: 0,
      rpcRead: onlyFirst,
      stat,
      now: () => new Date(70_000),
    })
    finalize({ sourceDir, out, config, stat })
    const replay = verify({ sourceDir, out, config })
    assert.equal(replay.block, 10)
    assert.equal(replay.candidateCount, 1)
    assert.equal(replay.ageAtCaptureSeconds, 60)

    const first = readdirSync(sourceDir).find((name) => /^\d{12}-\d{12}-/.test(name))
    writeFileSync(join(sourceDir, first), `${readFileSync(join(sourceDir, first), 'utf8')} `)
    assert.throws(() => verify({ sourceDir, out, config }), /hash_mismatch/)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('a reordered sealed prefix fails replay even if the manifest is rehashed', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'share-reorder-source-'))
  const out = mkdtempSync(join(tmpdir(), 'share-reorder-out-'))
  try {
    await collect({
      out: sourceDir,
      config,
      rpcRead: rpc,
      peerRpcRead: rpc,
      maxChunks: 2,
      windowBlocks: 1,
      stat,
      now: () => new Date(11_000),
    })
    await prepare({
      sourceDir,
      out,
      config,
      rpcRead: reading(),
      peerRpcRead: reading(),
      stat,
      now: () => new Date(11_000),
    })
    const name = readdirSync(out).find((entry) => entry.startsWith('manifest-'))
    const forged = JSON.parse(readFileSync(join(out, name), 'utf8'))
    forged.sourceSegments.reverse()
    const bytes = Buffer.from(JSON.stringify(forged))
    unlinkSync(join(out, name))
    writeFileSync(
      join(out, `manifest-${createHash('sha256').update(bytes).digest('hex')}.json`),
      bytes,
    )
    assert.throws(() => loadManifest({ sourceDir, out, config }), /source_prefix_changed/)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

test('an active source writer or simultaneous certificate writer fails closed', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'share-lock-source-'))
  const out = mkdtempSync(join(tmpdir(), 'share-lock-out-'))
  try {
    await collect({
      out: sourceDir,
      config,
      rpcRead: rpc,
      peerRpcRead: rpc,
      stat,
      now: () => new Date(11_000),
    })
    const sourceLock = join(sourceDir, '.share-transfer-source.lock')
    writeFileSync(sourceLock, 'active')
    await assert.rejects(
      prepare({
        sourceDir,
        out,
        config,
        rpcRead: reading(),
        peerRpcRead: reading(),
        stat,
        now: () => new Date(11_000),
      }),
      /source_writer_active/,
    )
    unlinkSync(sourceLock)

    let entered
    const enteredRead = new Promise((resolve) => {
      entered = resolve
    })
    let resume
    const paused = new Promise((resolve) => {
      resume = resolve
    })
    const read = reading()
    const slowRead = async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') {
        entered()
        await paused
      }
      return read(method, params)
    }
    const first = prepare({
      sourceDir,
      out,
      config,
      rpcRead: slowRead,
      peerRpcRead: read,
      stat,
      now: () => new Date(11_000),
    })
    await enteredRead
    await assert.rejects(
      prepare({
        sourceDir,
        out,
        config,
        rpcRead: read,
        peerRpcRead: read,
        stat,
        now: () => new Date(11_000),
      }),
      /output_lock_held/,
    )
    resume()
    await first
    assert.equal(loadManifest({ sourceDir, out, config }).manifest.block, 11)
  } finally {
    rmSync(sourceDir, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

async function candidateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'share-candidate-union-'))
  const sourceDir = join(root, 'source')
  const journalDir = join(root, 'journal')
  const receiptDir = join(root, 'receipt')
  const out = join(root, 'certificate')
  const { mkdirSync } = await import('node:fs')
  for (const dir of [sourceDir, journalDir, receiptDir, out]) mkdirSync(dir)
  await collect({
    out: sourceDir,
    config,
    rpcRead: rpc,
    peerRpcRead: rpc,
    stat,
    now: () => new Date(11_000),
  })
  const sourceSegment = readdirSync(sourceDir).find((name) => name.endsWith('.json'))
  const sourceBytes = readFileSync(join(sourceDir, sourceSegment))
  const sourceSha = createHash('sha256').update(sourceBytes).digest('hex')
  const sourceBody = JSON.parse(sourceBytes)
  const normalizedRows = sourceBody.logs.map((row) => ({
    blockNumber: row.blockNumber,
    transactionHash: row.transactionHash,
    recipient: row.recipient,
    valueRaw: row.valueRaw,
    logIndex: row.logIndex,
  }))
  const receipt = {
    schemaVersion: 1,
    source: {
      path: sourceDir,
      segment: sourceSegment,
      physicalSha256: sourceSha,
      config,
      fromBlock: 10,
      toBlock: 11,
    },
    normalizedRows,
    pages: 1,
    capturedAt: new Date(11_000).toISOString(),
    result: {
      status: 'matched',
      canonicalCount: 2,
      apiCount: 2,
      duplicateTuples: false,
      apiLogIndexAvailable: true,
      knownLogIndexes: 2,
      exactLogIdentity: true,
      claim: 'one_sealed_segment_comparison_only',
      pages: 1,
    },
  }
  const receiptBytes = Buffer.from(JSON.stringify(receipt))
  const receiptSha = createHash('sha256').update(receiptBytes).digest('hex')
  writeFileSync(join(receiptDir, `${receiptSha}.json`), receiptBytes)
  const anchor = sourceAnchor({
    source: sourceDir,
    config,
    frontierBlock: 11,
    frontierHash: hash(11),
  })
  const capability = {
    token: 'sGHO',
    deploymentBlock: 10,
    sourcePath: sourceDir,
    sourceSegment,
    sourceStartBlock: 10,
    sourcePhysicalSha256: sourceSha,
    sourceFromBlock: 10,
    sourceToBlock: 11,
    receiptPath: receiptDir,
    receiptSha256: receiptSha,
    receiptName: `${receiptSha}.json`,
    comparison: 'one_nonzero_sealed_segment_exact_log_identity',
  }
  const base = {
    anchor,
    capability,
    finalizedHead: 6011,
    finalizedHeadHash: hash(6011),
    capturedAt: new Date(6_011_000).toISOString(),
    pages: 1,
    logCompleteness: 'not_independently_proven',
    currentHolderCertificate: false,
    routeTvlClaim: false,
  }
  const row = (block, id, owner) => ({
    blockNumber: block,
    transactionHash: hash(id),
    logIndex: 0,
    sender: address(1),
    recipient: address(owner),
    valueRaw: '1',
  })
  const first = {
    ...base,
    schemaVersion: 1,
    fromBlock: 12,
    toBlock: 1011,
    fromHash: hash(12),
    fromParentHash: hash(11),
    toHash: hash(1011),
    rows: [row(12, 103, 3)],
    candidateRecipients: [address(3)],
  }
  const second = {
    ...base,
    schemaVersion: 2,
    windowBlocks: 5000,
    windowQualification: 'experimental_page_key_exhausted_only',
    interiorAncestry: 'not_independently_proven',
    fromBlock: 1012,
    toBlock: 6011,
    fromHash: hash(1012),
    fromParentHash: hash(1011),
    toHash: hash(6011),
    rows: [row(1012, 104, 4)],
    candidateRecipients: [address(4)],
  }
  const names = [appendJournal(journalDir, first, stat), appendJournal(journalDir, second, stat)]
  const apiJournal = { out: journalDir, anchor, capability }
  const reader = reading(
    new Map([
      [address(3), 1n],
      [address(4), 1n],
    ]),
  )
  const pinned = async (method, params) => {
    if (method === 'eth_getBlockByNumber')
      return header(params[0] === 'finalized' ? 6011 : Number(BigInt(params[0])))
    return reader(method, params)
  }
  return { root, sourceDir, journalDir, receiptDir, out, apiJournal, pinned, names, first, second }
}

test('v2 unions exact adjacent mixed v1/v2 API candidate segments, preserving conditional limits', async () => {
  const f = await candidateFixture()
  try {
    await prepare({
      sourceDir: f.sourceDir,
      apiJournal: f.apiJournal,
      out: f.out,
      config,
      rpcRead: f.pinned,
      peerRpcRead: f.pinned,
      stat,
      now: () => new Date(6_011_000),
    })
    const { manifest } = loadManifest({
      sourceDir: f.sourceDir,
      apiJournal: f.apiJournal,
      out: f.out,
      config,
    })
    assert.equal(manifest.schemaVersion, 2)
    assert.equal(manifest.block, 6011)
    assert.deepEqual(manifest.candidateRecipients, [1, 2, 3, 4].map(address))
    assert.deepEqual(
      manifest.apiCandidateUnion.segments.map((s) => s.schemaVersion),
      [1, 2],
    )
    await collectPage({
      sourceDir: f.sourceDir,
      apiJournal: f.apiJournal,
      out: f.out,
      config,
      page: 0,
      rpcRead: f.pinned,
      stat,
      now: () => new Date(6_011_000),
    })
    assert.equal(
      reconcile({ sourceDir: f.sourceDir, apiJournal: f.apiJournal, out: f.out, config })
        .positiveHolderCount,
      2,
    )
    finalize({ sourceDir: f.sourceDir, apiJournal: f.apiJournal, out: f.out, config, stat })
    assert.equal(
      verify({ sourceDir: f.sourceDir, apiJournal: f.apiJournal, out: f.out, config })
        .candidateCount,
      4,
    )
    assert.throws(() => promote(), /attestation_missing/)
    await assert.rejects(
      prepare({
        sourceDir: f.sourceDir,
        apiJournal: f.apiJournal,
        out: f.out,
        config,
        rpcRead: f.pinned,
        peerRpcRead: f.pinned,
        stat,
      }),
      /output_not_empty/,
    )
    assert.throws(
      () =>
        finalize({ sourceDir: f.sourceDir, apiJournal: f.apiJournal, out: f.out, config, stat }),
      /reconciliation_duplicate/,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('v2 fails closed on altered capability, source and journal bytes', async () => {
  for (const target of ['receipt', 'source', 'journal']) {
    const f = await candidateFixture()
    try {
      await prepare({
        sourceDir: f.sourceDir,
        apiJournal: f.apiJournal,
        out: f.out,
        config,
        rpcRead: f.pinned,
        peerRpcRead: f.pinned,
        stat,
        now: () => new Date(6_011_000),
      })
      const path =
        target === 'receipt'
          ? join(f.receiptDir, f.apiJournal.capability.receiptName)
          : target === 'source'
            ? join(f.sourceDir, f.apiJournal.capability.sourceSegment)
            : join(f.journalDir, f.names[1])
      writeFileSync(path, `${readFileSync(path, 'utf8')} `)
      assert.throws(
        () =>
          loadManifest({ sourceDir: f.sourceDir, apiJournal: f.apiJournal, out: f.out, config }),
        /hash_mismatch|seal_hash_invalid/,
      )
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
})

test('v2 rejects wrong token, missing source adjacency and mixed-fork transaction logs', async () => {
  for (const mutation of ['wrong-token', 'gap', 'overlap', 'mixed-fork']) {
    const f = await candidateFixture()
    try {
      if (mutation === 'wrong-token') f.apiJournal.capability.token = 'sUSDe'
      else {
        unlinkSync(join(f.journalDir, f.names[1]))
        const changed = { ...f.second }
        if (mutation === 'gap') changed.fromBlock = 1013
        if (mutation === 'overlap') changed.fromBlock = 1011
        if (mutation === 'mixed-fork')
          changed.rows = [{ ...changed.rows[0], transactionHash: hash(103) }]
        appendJournal(f.journalDir, changed, stat)
      }
      await assert.rejects(
        prepare({
          sourceDir: f.sourceDir,
          apiJournal: f.apiJournal,
          out: f.out,
          config,
          rpcRead: f.pinned,
          peerRpcRead: f.pinned,
          stat,
          now: () => new Date(6_011_000),
        }),
        /api_binding_invalid|seal_invalid|duplicate_transaction_log|mixed_fork_duplicate_log/,
      )
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
})

test('v2 union enforces the 2,048-ever-recipient and 64-page ceiling before RPC', async () => {
  const f = await candidateFixture()
  try {
    unlinkSync(join(f.journalDir, f.names[0]))
    unlinkSync(join(f.journalDir, f.names[1]))
    const rows = Array.from({ length: 2047 }, (_, i) => ({
      blockNumber: 12,
      transactionHash: hash(10_000 + i),
      logIndex: 0,
      sender: address(1),
      recipient: address(i + 3),
      valueRaw: '1',
    }))
    const crowded = {
      ...f.first,
      pages: 3,
      rows,
      candidateRecipients: rows.map((row) => row.recipient),
    }
    appendJournal(f.journalDir, crowded, stat)
    await assert.rejects(
      prepare({
        sourceDir: f.sourceDir,
        apiJournal: f.apiJournal,
        out: f.out,
        config,
        rpcRead: f.pinned,
        peerRpcRead: f.pinned,
        stat,
        now: () => new Date(6_011_000),
      }),
      /candidate_count_infeasible/,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('v2 page count follows the union when API candidates cross a 32-address boundary', async () => {
  const f = await candidateFixture()
  try {
    unlinkSync(join(f.journalDir, f.names[0]))
    const rows = Array.from({ length: 31 }, (_, i) => ({
      blockNumber: 12,
      transactionHash: hash(20_000 + i),
      logIndex: 0,
      sender: address(1),
      recipient: address(i + 3),
      valueRaw: '1',
    }))
    appendJournal(
      f.journalDir,
      {
        ...f.first,
        rows,
        candidateRecipients: rows.map((row) => row.recipient),
      },
      stat,
    )
    await prepare({
      sourceDir: f.sourceDir,
      apiJournal: f.apiJournal,
      out: f.out,
      config,
      rpcRead: f.pinned,
      peerRpcRead: f.pinned,
      stat,
      now: () => new Date(6_011_000),
    })
    const { manifest } = loadManifest({
      sourceDir: f.sourceDir,
      apiJournal: f.apiJournal,
      out: f.out,
      config,
    })
    assert.equal(manifest.candidateRecipients.length, 33)
    assert.equal(manifest.pageCount, 2)
    for (const page of [0, 1]) {
      await collectPage({
        sourceDir: f.sourceDir,
        apiJournal: f.apiJournal,
        out: f.out,
        config,
        page,
        rpcRead: f.pinned,
        stat,
        now: () => new Date(6_011_000),
      })
    }
    assert.equal(
      reconcile({
        sourceDir: f.sourceDir,
        apiJournal: f.apiJournal,
        out: f.out,
        config,
      }).candidateCount,
      33,
    )
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('v2 CLI replays the sealed capability and journal offline without RPC on verify', async () => {
  const f = await candidateFixture()
  const shared = [
    '--token',
    'sGHO',
    '--deployment-block',
    '10',
    '--source',
    f.sourceDir,
    '--out',
    f.out,
    '--api-journal',
    f.journalDir,
    '--capability-source',
    f.sourceDir,
    '--capability-segment',
    f.apiJournal.capability.sourceSegment,
    '--capability-start-block',
    '10',
    '--capability-receipt',
    f.receiptDir,
  ]
  try {
    await main(['--prepare', '--run', ...shared], {
      rpcRead: f.pinned,
      peerRpcRead: f.pinned,
      stat,
      now: () => new Date(6_011_000),
    })
    await main(['--page', '0', '--run', ...shared], {
      rpcRead: f.pinned,
      stat,
      now: () => new Date(6_011_000),
    })
    await main(['--finalize', '--run', ...shared], { stat })
    const receipt = await main(['--verify', ...shared], {
      rpcRead: async () => {
        throw Error('offline verify must not use RPC')
      },
    })
    assert.equal(receipt.schemaVersion, 2)
    assert.equal(receipt.block, 6011)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('certificate CLI selects exact hosts from RECORDER_RPC_URL without exposing keys', async () => {
  const f = await candidateFixture()
  const out = join(f.root, 'host-selected-certificate')
  const key = 'private-test-key-do-not-print'
  const ring = [
    `https://mainnet.infura.io/v3/${key}`,
    `https://rpc.ankr.com/eth/${key}`,
    `https://third.example.org/${key}`,
  ].join(',')
  const env = { get: (name) => (name === 'RECORDER_RPC_URL' ? ring : undefined) }
  const selected = ['--rpc-hosts', 'mainnet.infura.io,rpc.ankr.com']
  const shared = [
    '--token',
    'sGHO',
    '--deployment-block',
    '10',
    '--source',
    f.sourceDir,
    '--out',
    out,
  ]
  let clientCalls = 0
  let rpcCalls = 0
  const makeClient = (url) => {
    clientCalls++
    assert.ok(!url.includes('third.example.org'))
    return {
      request: async ({ method, params }) => {
        rpcCalls++
        return f.pinned(method, params)
      },
    }
  }
  const deps = { env, makeClient, stat, now: () => new Date(11_000) }
  try {
    await assert.rejects(main(['--prepare', '--run', ...shared], deps), (error) => {
      assert.equal(error.message.includes(key), false)
      return /two_rpc_hosts_required/.test(error.message)
    })
    assert.equal(clientCalls, 0)
    assert.equal(rpcCalls, 0)
    assert.equal(existsSync(out), false)
    for (const invalid of [
      'mainnet.infura.io,mainnet.infura.io',
      'mainnet.infura.io,missing.example.org',
    ]) {
      await assert.rejects(
        main(['--prepare', '--run', ...shared, '--rpc-hosts', invalid], deps),
        (error) => {
          assert.equal(error.message.includes(key), false)
          return /rpc_host_selection_invalid|rpc_host_missing/.test(error.message)
        },
      )
    }
    assert.equal(rpcCalls, 0)
    await main(['--prepare', '--run', ...shared, ...selected], deps)
    assert.equal(clientCalls, 2)
    assert.ok(rpcCalls > 0)
    const beforePage = rpcCalls
    await assert.rejects(main(['--page', '0', '--run', ...shared], deps), /two_rpc_hosts_required/)
    assert.equal(rpcCalls, beforePage)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('certificate output nested under a strict source or API evidence root fails before mkdir or RPC', async () => {
  const f = await candidateFixture()
  let calls = 0
  const forbiddenRead = async () => {
    calls++
    throw Error('RPC should not run')
  }
  try {
    for (const [out, apiJournal] of [
      [join(f.sourceDir, 'nested'), null],
      [join(f.journalDir, 'nested'), f.apiJournal],
      [join(f.receiptDir, 'nested'), f.apiJournal],
      [join(f.sourceDir, 'nested-v2'), f.apiJournal],
    ]) {
      await assert.rejects(
        prepare({
          sourceDir: f.sourceDir,
          apiJournal,
          out,
          config,
          rpcRead: forbiddenRead,
          peerRpcRead: forbiddenRead,
          stat,
        }),
        /out_inside_source_or_receipt/,
      )
      assert.equal(existsSync(out), false)
    }
    assert.equal(calls, 0)
  } finally {
    rmSync(f.root, { recursive: true, force: true })
  }
})
