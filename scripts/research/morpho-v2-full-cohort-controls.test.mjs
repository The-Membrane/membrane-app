import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem'
import { TransferLedgerError, TransferRpcError } from './morpho-v2-full-cohort-baseline.mjs'
import {
  FACTORY_SHA,
  FIRST_PAGE,
  FIRST_TREATED,
  MANIFEST_SHA,
  MAX_CANDIDATE_RPC,
  RESERVE_BYTES,
  STUDY,
  budgetClient,
  chooseControls,
  distance,
  guardDisk,
  loadSources,
  pageDisposition,
  screenCandidate,
  treatedPrefixCommitment,
  verifyCheckpoint,
} from './morpho-v2-full-cohort-controls.mjs'

const vault = (n) => `0x${n.toString(16).padStart(40, '0')}`
const blockHash = `0x${'a'.repeat(64)}`
const source = (nextCleanOffset = null) => ({
  row: {
    proposalIndex: 42,
    vault: vault(1),
    asset: vault(9),
    anchorBlock: 100,
    controls: { nextCleanOffset },
  },
  baseline: { status: 'baseline-success', qAssets: '100', preBlockHash: blockHash },
  treatedAgeSeconds: 2 * 86_400,
  candidates: [
    { vault: vault(2), creationBlock: 50, ageSeconds: 86_400 },
    { vault: vault(3), creationBlock: 40, ageSeconds: 86_400 },
  ],
})
const treatedState = { totalAssets: '1000', idleFraction: 0.3, adapterPresent: true }
const screened = (n, status = 'baseline-success', extras = {}) => ({
  vault: vault(n),
  preBlockHash: blockHash,
  status,
  holderAttempts: [
    {
      holder: vault(n + 10),
      status: status === 'baseline-success' ? 'success' : 'withdraw-revert',
    },
  ],
  totalAssets: n === 2 ? '1100' : '900',
  idleFraction: n === 2 ? 0.3 : 0.5,
  adapterPresent: n === 2,
  ageSeconds: 86_400,
  ...extras,
})
const seal = (value) => ({
  ...value,
  checkpointSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
})
const checkpoint = (anchor, rows) =>
  seal({
    study: STUDY,
    status: 'partial',
    manifestSha256: MANIFEST_SHA,
    factorySha256: FACTORY_SHA,
    treatedPrefixSha256: '1'.repeat(64),
    treatedSourceShaHistory: ['2'.repeat(64), '3'.repeat(64)],
    denominator: 304,
    firstPageAnchors: FIRST_TREATED,
    rows,
  })
const row = (anchor, items) => ({
  index: 0,
  proposalIndex: anchor.row.proposalIndex,
  vault: anchor.row.vault,
  anchorBlock: anchor.row.anchorBlock,
  preBlockHash: anchor.baseline.preBlockHash,
  treatedStatus: 'baseline-success',
  qAssets: '100',
  treatedAgeSeconds: anchor.treatedAgeSeconds,
  treatedState,
  screened: items,
  selected: items.length ? chooseControls(items, treatedState, anchor.treatedAgeSeconds) : null,
  disposition: pageDisposition(anchor, items),
})

test('treated prefix commitment is stable across appended baseline rows and changes on prefix edit', () => {
  const first = Array.from({ length: FIRST_TREATED }, (_, index) => ({ index, qAssets: '100' }))
  const commitment = treatedPrefixCommitment(first)
  assert.equal(
    treatedPrefixCommitment([...first, { index: FIRST_TREATED, qAssets: '200' }]),
    commitment,
  )
  assert.notEqual(
    treatedPrefixCommitment([{ index: 0, qAssets: '101' }, ...first.slice(1)]),
    commitment,
  )
  assert.throws(() => treatedPrefixCommitment(first.slice(0, -1)), /Incomplete treated prefix/)
})

test('matching distance uses only pre-B assets, age, idle and adapter, then ranks at most two', () => {
  const c2 = screened(2),
    c3 = screened(3),
    c4 = screened(4, 'baseline-revert')
  assert.ok(distance(c2, treatedState, 2 * 86_400) < distance(c3, treatedState, 2 * 86_400))
  assert.deepEqual(
    chooseControls([c3, c4, c2], treatedState, 2 * 86_400).map((x) => x.vault),
    [c2.vault, c3.vault],
  )
  assert.throws(() => distance({ ...c2, totalAssets: 'not-a-number' }, treatedState, 0))
})

test('first page does not claim exhaustion if additional clean candidates remain', () => {
  const anchor = source(FIRST_PAGE)
  assert.equal(pageDisposition(anchor, []), 'first-page-in-progress')
  assert.equal(
    pageDisposition(anchor, [screened(2), screened(3, 'baseline-revert')]),
    'continuation-required',
  )
  assert.equal(
    pageDisposition(source(null), [screened(2), screened(3, 'baseline-revert')]),
    'first-page-exhausted-under-matched',
  )
  assert.equal(
    pageDisposition(source(null), [screened(2), screened(3, 'state-rpc-ambiguous')]),
    'first-page-exhausted-unresolved',
  )
  assert.equal(pageDisposition(anchor, [screened(2), screened(3)]), 'first-page-matched')
})

test('sealed checkpoint retains source lineage and rejects wrong prefix or altered selection', () => {
  const anchor = source(),
    items = [screened(2), screened(3)]
  const saved = checkpoint(anchor, [row(anchor, items)])
  assert.equal(verifyCheckpoint(saved, [anchor], '1'.repeat(64)), saved)
  assert.throws(() => verifyCheckpoint(saved, [anchor], '9'.repeat(64)), /seal\/metadata/)
  const changed = { ...saved, rows: [{ ...saved.rows[0], selected: [saved.rows[0].selected[1]] }] }
  assert.throws(
    () =>
      verifyCheckpoint(seal({ ...changed, checkpointSha256: undefined }), [anchor], '1'.repeat(64)),
    /selected ranking/,
  )
  assert.throws(
    () => verifyCheckpoint({ ...saved, status: 'complete' }, [anchor], '1'.repeat(64)),
    /seal\/metadata/,
  )
})

test('the 2.5 GB reserve is enforced before RPC/checkpoint writes', () => {
  const stat = () => ({ bavail: RESERVE_BYTES - 1, bsize: 1 })
  assert.equal(RESERVE_BYTES, 2_500_000_000)
  assert.throws(() => guardDisk('/tmp/control-test.json', 0, stat), /Disk reserve/)
})

test('candidate screen tries the next positive EOA after a revert, preserving attempts and fixed q', async () => {
  const anchor = source(),
    candidate = anchor.candidates[0]
  const first = vault(10),
    second = vault(11),
    seenCalls = []
  const abi = parseAbi([
    'function totalSupply() view returns (uint256)',
    'function totalAssets() view returns (uint256)',
    'function asset() view returns (address)',
    'function liquidityAdapter() view returns (address)',
    'function balanceOf(address) view returns (uint256)',
    'function previewRedeem(uint256) view returns (uint256)',
    'function withdraw(uint256,address,address) returns (uint256)',
  ])
  const selector = Object.fromEntries(
    [
      'totalSupply',
      'totalAssets',
      'asset',
      'liquidityAdapter',
      'balanceOf',
      'previewRedeem',
      'withdraw',
    ].map((functionName) => [
      encodeFunctionData({
        abi,
        functionName,
        args:
          functionName === 'balanceOf'
            ? [first]
            : functionName === 'previewRedeem'
              ? [100n]
              : functionName === 'withdraw'
                ? [100n, first, first]
                : [],
      }).slice(0, 10),
      functionName,
    ]),
  )
  const uint = (n) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)])
  const address = (x) => encodeAbiParameters([{ type: 'address' }], [x])
  const client = {
    request: async ({ method, params }) => {
      seenCalls.push({ method, params })
      if (method === 'eth_getBlockByNumber') return { number: '0x63', hash: blockHash }
      if (method === 'eth_getCode') return params[0] === candidate.vault ? '0x6000' : '0x'
      if (method !== 'eth_call') throw new Error('unexpected RPC')
      const call = params[0],
        name = selector[call.data.slice(0, 10)]
      assert.equal(params[1].blockHash, blockHash)
      if (name === 'totalSupply') return uint(150)
      if (name === 'totalAssets') return uint(1000)
      if (name === 'asset') return address(anchor.row.asset)
      if (name === 'liquidityAdapter') return address(vault(0))
      if (name === 'balanceOf')
        return uint(
          call.to === anchor.row.asset ? 300 : call.data.endsWith(second.slice(2)) ? 50 : 100,
        )
      if (name === 'previewRedeem') return uint(200)
      if (name === 'withdraw') {
        const decoded = decodeFunctionData({ abi, data: call.data })
        assert.equal(decoded.args[0], 100n)
        assert.equal(decoded.args[1].toLowerCase(), call.from)
        assert.equal(decoded.args[2].toLowerCase(), call.from)
        if (call.from === first) throw Object.assign(new Error('execution reverted'), { code: 3 })
        assert.equal(call.from, second)
        return uint(10)
      }
      throw new Error('unknown call')
    },
  }
  const logs = [
    {
      block: 50,
      blockHash,
      logIndex: 0,
      txHash: `0x${'b'.repeat(64)}`,
      from: vault(0),
      to: first,
      value: '100',
    },
    {
      block: 50,
      blockHash,
      logIndex: 1,
      txHash: `0x${'c'.repeat(64)}`,
      from: vault(0),
      to: second,
      value: '50',
    },
  ]
  const result = await screenCandidate({
    client,
    anchor,
    candidate,
    rawDir: '/tmp/unused',
    out: '/tmp/control-unit.json',
    stat: () => ({ bavail: 5_000_000_000, bsize: 1 }),
    collectPrefix: async () => ({
      raw: { logs },
      rawPath: '/tmp/unused-raw',
      physicalSha256: 'a'.repeat(64),
    }),
  })
  assert.equal(result.status, 'baseline-success')
  assert.equal(result.holder, second)
  assert.deepEqual(
    result.holderAttempts.map((x) => x.status),
    ['withdraw-revert', 'success'],
  )
  const withdrawals = seenCalls.filter(
    (x) =>
      x.method === 'eth_call' &&
      x.params[0].data.slice(0, 10) ===
        Object.keys(selector).find((x) => selector[x] === 'withdraw'),
  )
  assert.equal(withdrawals.length, 2)
})

test('per-candidate budget counts every RPC and censors before an unlimited holder scan', async () => {
  let calls = 0
  const counted = budgetClient(
    {
      request: async () => {
        calls++
        return 'ok'
      },
    },
    2,
  )
  assert.equal(await counted.client.request({ method: 'a' }), 'ok')
  assert.equal(await counted.client.request({ method: 'b' }), 'ok')
  await assert.rejects(counted.client.request({ method: 'c' }), /budget reached/)
  assert.equal(calls, 2)
  assert.equal(MAX_CANDIDATE_RPC, 4_000)
  const result = await screenCandidate({
    client: {
      request: async ({ method }) =>
        method === 'eth_getBlockByNumber' ? { number: '0x63', hash: blockHash } : '0x6000',
    },
    anchor: source(),
    candidate: source().candidates[0],
    out: '/tmp/control-budget-unit.json',
    rawDir: '/tmp/unused',
    stat: () => ({ bavail: 5_000_000_000, bsize: 1 }),
    rpcLimit: 1,
  })
  assert.equal(result.status, 'rpc-budget-censored')
  assert.deepEqual(result.holderAttempts, [])
})

function preTransferClient(anchor, candidate) {
  const abi = parseAbi([
    'function totalSupply() view returns (uint256)',
    'function totalAssets() view returns (uint256)',
    'function asset() view returns (address)',
    'function liquidityAdapter() view returns (address)',
    'function balanceOf(address) view returns (uint256)',
  ])
  const names = Object.fromEntries(
    ['totalSupply', 'totalAssets', 'asset', 'liquidityAdapter', 'balanceOf'].map((name) => [
      encodeFunctionData({
        abi,
        functionName: name,
        args: name === 'balanceOf' ? [candidate.vault] : [],
      }).slice(0, 10),
      name,
    ]),
  )
  const uint = (n) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)])
  const address = (x) => encodeAbiParameters([{ type: 'address' }], [x])
  return {
    request: async ({ method, params }) => {
      if (method === 'eth_getBlockByNumber') return { number: '0x63', hash: blockHash }
      if (method === 'eth_getCode') return '0x6000'
      if (method !== 'eth_call') throw new Error('unexpected RPC')
      const name = names[params[0].data.slice(0, 10)]
      if (name === 'totalSupply') return uint(150)
      if (name === 'totalAssets') return uint(1000)
      if (name === 'asset') return address(anchor.row.asset)
      if (name === 'liquidityAdapter') return address(vault(0))
      if (name === 'balanceOf') return uint(300)
      throw new Error('unknown pre-transfer call')
    },
  }
}

test('only typed Transfer RPC/ledger errors become censored candidates; raw-cache errors stay fatal', async () => {
  const anchor = source(),
    candidate = anchor.candidates[0]
  const common = {
    client: preTransferClient(anchor, candidate),
    anchor,
    candidate,
    out: '/tmp/control-transfer-unit.json',
    rawDir: '/tmp/unused',
    stat: () => ({ bavail: 5_000_000_000, bsize: 1 }),
  }
  assert.equal(
    (
      await screenCandidate({
        ...common,
        collectPrefix: async () => {
          throw new TransferRpcError('archive unavailable')
        },
      })
    ).status,
    'transfer-rpc-censored',
  )
  assert.equal(
    (
      await screenCandidate({
        ...common,
        collectPrefix: async () => {
          throw new TransferLedgerError('ledger mismatch')
        },
      })
    ).status,
    'transfer-ledger-censored',
  )
  await assert.rejects(
    screenCandidate({
      ...common,
      collectPrefix: async () => {
        throw new Error('Raw prefix metadata mismatch')
      },
    }),
    /Raw prefix metadata mismatch/,
  )
})

test('holder code archive failure is retained as an attempt before another EOA succeeds', async () => {
  const anchor = source(),
    candidate = anchor.candidates[0]
  const first = vault(10),
    second = vault(11)
  const baseline = preTransferClient(anchor, candidate)
  const abi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function previewRedeem(uint256) view returns (uint256)',
    'function withdraw(uint256,address,address) returns (uint256)',
  ])
  const preview = encodeFunctionData({ abi, functionName: 'previewRedeem', args: [50n] }).slice(
    0,
    10,
  )
  const withdraw = encodeFunctionData({
    abi,
    functionName: 'withdraw',
    args: [100n, second, second],
  }).slice(0, 10)
  const balance = encodeFunctionData({ abi, functionName: 'balanceOf', args: [second] }).slice(
    0,
    10,
  )
  const uint = (n) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)])
  const client = {
    request: async (args) => {
      if (args.method === 'eth_getCode' && args.params[0] === first)
        throw new Error('archive unavailable')
      if (args.method === 'eth_getCode' && args.params[0] === second) return '0x'
      if (args.method === 'eth_call') {
        const selector = args.params[0].data.slice(0, 10)
        if (selector === preview) return uint(200)
        if (selector === withdraw) return uint(10)
        if (selector === balance && args.params[0].to === candidate.vault) return uint(50)
      }
      return baseline.request(args)
    },
  }
  const raw = {
    logs: [
      {
        block: 50,
        blockHash,
        logIndex: 0,
        txHash: `0x${'b'.repeat(64)}`,
        from: vault(0),
        to: first,
        value: '100',
      },
      {
        block: 50,
        blockHash,
        logIndex: 1,
        txHash: `0x${'c'.repeat(64)}`,
        from: vault(0),
        to: second,
        value: '50',
      },
    ],
  }
  const result = await screenCandidate({
    client,
    anchor,
    candidate,
    out: '/tmp/control-holder-code-unit.json',
    rawDir: '/tmp/unused',
    stat: () => ({ bavail: 5_000_000_000, bsize: 1 }),
    collectPrefix: async () => ({
      raw,
      rawPath: '/tmp/unused-raw',
      physicalSha256: 'a'.repeat(64),
    }),
  })
  assert.equal(result.status, 'baseline-success')
  assert.equal(result.holder, second)
  assert.deepEqual(
    result.holderAttempts.map((x) => x.status),
    ['holder-code-rpc-ambiguous', 'success'],
  )
})

test('offline verification checks raw-prefix metadata and seal, not just physical file hash', () => {
  const anchor = source(),
    dir = mkdtempSync(join(tmpdir(), 'control-raw-'))
  try {
    const rawPath = join(dir, 'raw.json')
    writeFileSync(rawPath, '{}')
    const bytes = readFileSync(rawPath)
    const item = screened(2, 'transfer-ledger-censored', {
      creationBlock: 50,
      preBlock: 99,
      rawPath,
      rawSha256: createHash('sha256').update(bytes).digest('hex'),
    })
    const saved = checkpoint(anchor, [row(anchor, [item])])
    assert.throws(() => verifyCheckpoint(saved, [anchor], '1'.repeat(64)), /Missing seal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('current dry inputs accept an explicit physical SHA and preserve the first-32 prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'control-dry-source-'))
  try {
    const base = resolve('data/research/venue-signals')
    const manifestPath = join(base, 'morpho-v2-full-cohort-manifest.json')
    const factoryPath = join(base, `${FACTORY_SHA}.json`)
    const treatedPath = join(dir, 'treated.json')
    copyFileSync(join(base, 'morpho-v2-full-cohort-baseline.json'), treatedPath)
    const treatedSha = createHash('sha256').update(readFileSync(treatedPath)).digest('hex')
    const loaded = loadSources(manifestPath, treatedPath, factoryPath, treatedSha)
    assert.equal(loaded.anchors.length, FIRST_TREATED)
    assert.equal(loaded.anchors.filter((x) => x.baseline.status === 'baseline-success').length, 29)
    assert.equal(
      loaded.treatedPrefixSha256,
      '09f7ebf94afe16dece97729fb29206360b94a1143ac4b58085cd76a9ead2a25d',
    )
    assert.throws(
      () => loadSources(manifestPath, treatedPath, factoryPath, '0'.repeat(64)),
      /Pinned source SHA mismatch/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
