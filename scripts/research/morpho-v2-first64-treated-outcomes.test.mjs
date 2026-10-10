import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { encodeAbiParameters, keccak256 } from 'viem'
import {
  empty,
  firstAtOrAfter,
  loadPlan,
  observe,
  requestBudget,
  run,
  verifyProbe,
  verifySnapshot,
} from './morpho-v2-first64-treated-outcomes.mjs'
import { FACTORY_SHA } from './morpho-v2-full-cohort-baseline.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'

const baseDir = 'data/research/venue-signals/'
const paths = {
  treatedPath: `${baseDir}morpho-v2-signer-baseline-v2.json`,
  manifestPath: `${baseDir}morpho-v2-full-cohort-manifest.json`,
  factoryPath: `${baseDir}${FACTORY_SHA}.json`,
  stage1Path: `${baseDir}${STAGE1_SHA}.json`,
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
function seal(value) {
  const copy = structuredClone(value)
  delete copy.checkpointSha256
  return { ...copy, checkpointSha256: sha(JSON.stringify(copy)) }
}
const plan = loadPlan(paths)

test('source plan preserves all first64 strata, frozen holders/q and manifest ancestry', () => {
  assert.equal(plan.length, 64)
  assert.equal(plan.filter((r) => r.baselineStatus === 'baseline-success').length, 58)
  assert.equal(plan.filter((r) => r.baselineStatus === 'baseline-revert').length, 1)
  assert.equal(
    plan.filter((r) => r.baselineStatus === 'no-non-sentinel-code-empty-holder').length,
    5,
  )
  assert.deepEqual(
    plan.map((r) => r.index),
    Array.from({ length: 64 }, (_, i) => i),
  )
  assert.equal(plan[0].qAssets, '11024')
  assert.equal(plan[0].holder, '0xdd1e0799211d06217d4ddf34586f994cc9b4e6f0')
  assert.equal(plan[0].qOverVaultAssets.numerator, '11024')
  assert.equal(plan[5].holder, null)
  assert.equal(plan[5].qAssets, null)
  assert.equal(plan[27].baselineStatus, 'baseline-revert')
  assert.equal(plan[27].qAssets, '11452798423')
  assert.equal(plan[27].holder, '0x84d1b180d67ba40a4cb7aeb78af6a8bf80fc5c63')
  assert.equal(
    sha(readFileSync(paths.treatedPath)),
    '9bf2a8705910c65eae377a2f63eec73dd6a82f907d9ec1ccee7ead015dcc754e',
  )
})

test('offline snapshot rejects lost rows, reselection and mutated frozen holder/q', () => {
  const initial = seal(empty(plan))
  assert.equal(verifySnapshot(initial, plan).rows.length, 64)
  const fewer = seal({ ...initial, rows: initial.rows.slice(0, 63) })
  assert.throws(() => verifySnapshot(fewer, plan), /64-row denominator/)
  const holder = structuredClone(initial)
  holder.rows[0].holder = plan[1].holder
  assert.throws(() => verifySnapshot(seal(holder), plan), /frozen row 0 holder/i)
  const q = structuredClone(initial)
  q.rows[0].qAssets = '1'
  assert.throws(() => verifySnapshot(seal(q), plan), /frozen row 0 qAssets/i)
  const quiet = structuredClone(initial)
  quiet.rows[5].status = 'pending'
  assert.throws(() => verifySnapshot(seal(quiet), plan), /ineligible row reselected/i)
  const status = structuredClone(initial)
  status.status = 'complete'
  assert.throws(() => verifySnapshot(seal(status), plan), /incomplete cohort/i)
})

test('source physical pin rejects a substituted treated file', () => {
  assert.throws(
    () => loadPlan({ ...paths, treatedPath: paths.manifestPath }),
    /physical SHA mismatch/,
  )
})

test('target search proves first block and predecessor with finalized bound', async () => {
  const times = new Map([
    [18, 100],
    [19, 104],
    [20, 110],
    [21, 120],
    [22, 130],
  ])
  const request = async (_method, [number]) => {
    const block = Number(BigInt(number))
    return {
      number,
      timestamp: `0x${times.get(block).toString(16)}`,
      gasLimit: '0x1c9c380',
      hash: `0x${block.toString(16).padStart(64, '0')}`,
      parentHash: `0x${(block - 1).toString(16).padStart(64, '0')}`,
    }
  }
  const result = await firstAtOrAfter(request, 105, 18, { block: 22, timestamp: 130 })
  assert.equal(result.found.block, 20)
  assert.equal(result.previous.block, 19)
  assert.equal(await firstAtOrAfter(request, 131, 18, { block: 22, timestamp: 130 }), null)
})

test('verifier rejects early target, missing finality, and missing attrition censor', () => {
  const row = {
    ...plan[0],
    baseline: {
      asset: '0x0000000000000000000000000000000000000001',
      adapter: '0x0000000000000000000000000000000000000002',
      proxyImplementation: null,
      proxyImplementationCodeHash: undefined,
    },
  }
  const target = row.executableAt + 86400
  const probe = {
    block: 100,
    hash: `0x${'1'.repeat(64)}`,
    parentHash: `0x${'3'.repeat(64)}`,
    timestamp: target,
    gasLimit: '30000000',
    targetTimestamp: target,
    scheduledLeadSeconds: target - row.anchorTimestamp,
    previousHeader: { block: 99, hash: `0x${'3'.repeat(64)}`, timestamp: target - 1 },
    finalizedHead: { block: 101, hash: `0x${'2'.repeat(64)}` },
    canonicalRecheck: {
      targetHash: `0x${'1'.repeat(64)}`,
      finalizedHash: `0x${'2'.repeat(64)}`,
    },
    runtimeCodeHash: row.baselineRuntimeCodeHash,
    holderCodeHash: null,
    holderShares: '1',
    holderClaimAssets: row.qAssets,
    asset: row.baseline.asset,
    adapter: row.baseline.adapter,
    proxyImplementation: null,
    call: 'success',
    gasStatus: 'observed',
    gasEstimate: '100000',
    shares: '1',
    output: '0x01',
    status: 'success',
    censoring: [],
  }
  verifyProbe(probe, row, 'plus24h')
  assert.throws(
    () => verifyProbe({ ...probe, timestamp: target - 1 }, row, 'plus24h'),
    /before target/,
  )
  assert.throws(
    () => verifyProbe({ ...probe, finalizedHead: { block: 99, hash: probe.hash } }, row, 'plus24h'),
    /Finality/,
  )
  assert.throws(
    () => verifyProbe({ ...probe, canonicalRecheck: undefined }, row, 'plus24h'),
    /Canonical recheck/,
  )
  assert.throws(
    () => verifyProbe({ ...probe, holderClaimAssets: '0' }, row, 'plus24h'),
    /attrition/,
  )
  assert.throws(
    () =>
      verifyProbe(
        { ...probe, adapter: '0x0000000000000000000000000000000000000003' },
        row,
        'plus24h',
      ),
    /adapter drift/,
  )
  assert.throws(
    () =>
      verifyProbe({ ...probe, gasStatus: 'unavailable', gasEstimate: undefined }, row, 'plus24h'),
    /gas estimate not censored/,
  )
  assert.throws(
    () => verifyProbe({ ...probe, gasEstimate: '30000001' }, row, 'plus24h'),
    /Over-limit gas/,
  )
})

test('observed fixed-q revert remains recorded but holder attrition and adapter drift censor it', async () => {
  const vault = '0x0000000000000000000000000000000000000011'
  const holder = '0x0000000000000000000000000000000000000022'
  const asset = '0x0000000000000000000000000000000000000033'
  const adapter = '0x0000000000000000000000000000000000000044'
  const other = '0x0000000000000000000000000000000000000055'
  const code = '0x6001'
  const row = {
    vault,
    holder,
    qAssets: '100',
    baselineRuntimeCodeHash: keccak256(code),
    baselineClaimAssets: '1000',
    baseline: {
      asset,
      adapter,
      adapterCodeHash: keccak256(code),
      adapterImplementation: null,
      proxyImplementation: null,
      proxyImplementationCodeHash: undefined,
    },
  }
  const h = { block: 20, hash: `0x${'a'.repeat(64)}`, timestamp: 200, gasLimit: '30000000' }
  let mode = 'revert'
  let adapterAddress = other
  let adapterCode = code
  const request = async (method, params) => {
    if (method === 'eth_getCode') {
      if (params[0] === vault) return code
      if (params[0] === adapterAddress) return adapterCode
      return '0x'
    }
    if (method === 'eth_getStorageAt') return `0x${'0'.repeat(64)}`
    if (method === 'eth_estimateGas') throw new Error('archive estimate unavailable')
    if (method !== 'eth_call') throw new Error('Unexpected RPC method')
    const selector = params[0].data.slice(0, 10)
    if (selector === '0xb460af94') {
      if (mode === 'revert') throw new Error('execution reverted')
      return encodeAbiParameters([{ type: 'uint256' }], [7n])
    }
    const selectors = {
      '0x38d52e0f': asset,
      '0x70a08231': 10n,
      '0xad468d11': adapterAddress,
      '0x4cdad506': 50n,
    }
    if (selector in selectors) {
      const value = selectors[selector]
      return encodeAbiParameters(
        [{ type: typeof value === 'bigint' ? 'uint256' : 'address' }],
        [value],
      )
    }
    throw new Error('Unexpected function selector')
  }
  const probe = await observe(request, row, h, false)
  assert.equal(probe.status, 'censored')
  assert.equal(probe.call, 'evm-revert')
  assert.ok(probe.censoring.includes('adapter-changed'))
  assert.ok(probe.censoring.includes('holder-claim-below-frozen-q'))
  assert.ok(!probe.censoring.includes('gas-estimate-unavailable'))
  mode = 'success'
  const success = await observe(request, row, h, false)
  assert.equal(success.call, 'success')
  assert.equal(success.gasStatus, 'unavailable')
  assert.ok(success.censoring.includes('gas-estimate-unavailable'))
  adapterAddress = adapter
  adapterCode = '0x6002'
  const sameAddressDrift = await observe(request, row, h, false)
  assert.ok(sameAddressDrift.censoring.includes('adapterCodeHash-changed'))
})

test('disk floor and per-scope/global RPC caps are fatal, not outcome censors', async () => {
  const client = { request: async () => 'ok' }
  const denied = requestBudget(client, '/tmp/fake.json', () => {
    throw new Error('disk')
  })
  await assert.rejects(denied('eth_getCode', []), /Disk reserve reached/)
  const scoped = requestBudget(client, '/tmp/fake.json', () => {})
  for (let i = 0; i < 100; i++) await scoped('eth_getCode', [])
  await assert.rejects(scoped('eth_getCode', []), /Per-row\/horizon RPC cap/)
  const global = requestBudget(client, '/tmp/fake.json', () => {})
  for (let i = 0; i < 400; i++) {
    if (i % 100 === 0) global.scope()
    await global('eth_getCode', [])
  }
  global.scope()
  await assert.rejects(global('eth_getCode', []), /RPC cap reached/)
})

test('live run rejects a wrong chain before any outcome read', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-outcome-chain-'))
  try {
    const calls = []
    const client = {
      request: async ({ method }) => {
        calls.push(method)
        if (method === 'eth_chainId') return '0x89'
        assert.fail('Wrong chain reached historical read')
      },
    }
    await assert.rejects(
      run({ client, ...paths, out: resolve(dir, 'out.json'), maxRows: 1, guard: () => {} }),
      /Wrong chain ID/,
    )
    assert.deepEqual(calls, ['eth_chainId'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resumed baseline rechecks frozen B-1 hash before its outcome', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-outcome-resume-'))
  try {
    const out = resolve(dir, 'out.json')
    const snapshot = empty(plan)
    snapshot.rows[0].baseline = {
      block: plan[0].preBlock,
      hash: plan[0].preBlockHash,
      runtimeCodeHash: plan[0].baselineRuntimeCodeHash,
      holderClaimAssets: plan[0].baselineClaimAssets,
      holderCodeHash: null,
      censoring: [],
      gasLimit: '30000000',
      asset: '0x0000000000000000000000000000000000000001',
      adapter: '0x0000000000000000000000000000000000000002',
      adapterCodeHash: `0x${'a'.repeat(64)}`,
      adapterImplementation: null,
      proxyImplementation: null,
    }
    writeFileSync(out, JSON.stringify(seal(snapshot)))
    const calls = []
    const client = {
      request: async ({ method, params }) => {
        calls.push(method)
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber')
          return {
            number: params[0] === 'finalized' ? '0xfffffff' : params[0],
            timestamp: '0xfffffff',
            gasLimit: '0x1c9c380',
            hash: `0x${'b'.repeat(64)}`,
            parentHash: `0x${'c'.repeat(64)}`,
          }
        assert.fail('Hash mismatch reached outcome read')
      },
    }
    await assert.rejects(
      run({ client, ...paths, out, maxRows: 1, guard: () => {} }),
      /B-1 canonical hash mismatch/,
    )
    assert.deepEqual(calls, ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('atomic saves retain both horizons and complete the touched row', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'morpho-outcome-atomic-'))
  try {
    const out = resolve(dir, 'out.json')
    const selected = plan[0]
    const blockHash = (n) => `0x${n.toString(16).padStart(64, '0')}`
    const header = (n) => ({
      number: `0x${n.toString(16)}`,
      timestamp: `0x${(selected.executableAt + (n - selected.anchorBlock) * 12).toString(16)}`,
      gasLimit: '0x1c9c380',
      hash: n === selected.preBlock ? selected.preBlockHash : blockHash(n),
      parentHash: blockHash(n - 1),
    })
    const client = {
      request: async ({ method, params }) => {
        if (method === 'eth_chainId') return '0x1'
        if (method === 'eth_getBlockByNumber')
          return header(
            params[0] === 'finalized' ? selected.anchorBlock + 60000 : Number(BigInt(params[0])),
          )
        assert.fail(`Unexpected ${method}`)
      },
    }
    const observeFn = async (_request, row, h, baseline) =>
      baseline
        ? {
            ...h,
            runtimeCodeHash: row.baselineRuntimeCodeHash,
            holderCodeHash: null,
            holderClaimAssets: row.baselineClaimAssets,
            gasLimit: '30000000',
            asset: '0x0000000000000000000000000000000000000001',
            adapter: '0x0000000000000000000000000000000000000000',
            proxyImplementation: null,
            censoring: [],
            status: 'baseline-observed',
          }
        : {
            ...h,
            runtimeCodeHash: row.baselineRuntimeCodeHash,
            holderCodeHash: null,
            holderShares: '1',
            holderClaimAssets: row.qAssets,
            asset: row.baseline.asset,
            adapter: row.baseline.adapter,
            proxyImplementation: null,
            call: 'success',
            shares: '1',
            output: '0x01',
            gasStatus: 'observed',
            gasEstimate: '100000',
            censoring: [],
            status: 'success',
          }
    const result = await run({
      client,
      ...paths,
      out,
      maxRows: 1,
      guard: () => {},
      observeFn,
    })
    assert.equal(result.rows[0].status, 'complete')
    assert.deepEqual(Object.keys(result.rows[0].outcomes), ['plus24h', 'plus7d'])
    assert.equal(verifySnapshot(JSON.parse(readFileSync(out)), plan).rows[0].status, 'complete')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
