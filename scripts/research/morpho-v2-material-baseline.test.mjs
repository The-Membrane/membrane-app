import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { FACTORY_SHA } from './morpho-v2-full-cohort-baseline.mjs'
import { STAGE1_SHA } from './morpho-v2-exit-baseline-pilot.mjs'
import {
  FIRST,
  N,
  Q,
  loadMaterialPlan,
  measureRow,
  run,
  verifySnapshot,
} from './morpho-v2-material-baseline.mjs'
import { createHash } from 'node:crypto'
import { encodeFunctionResult, keccak256, parseAbi, toFunctionSelector } from 'viem'

const base = 'data/research/venue-signals/'
const paths = {
  treatedPath: resolve(`${base}morpho-v2-signer-baseline-v2.json`),
  manifestPath: resolve(`${base}morpho-v2-full-cohort-manifest.json`),
  factoryPath: resolve(`${base}${FACTORY_SHA}.json`),
  stage1Path: resolve(`${base}${STAGE1_SHA}.json`),
}
const plan = loadMaterialPlan(paths)
const seal = (body) => ({
  ...body,
  checkpointSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
})
const withdrawAbi = parseAbi(['function withdraw(uint256,address,address) returns (uint256)'])
const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])

test('the material-size test keeps the frozen 304 anchors and one fixed holder', () => {
  assert.equal(plan.length, N)
  assert.equal(plan.filter((row) => row.status === 'ready').length, 14)
  assert.equal(plan.filter((row) => row.status === 'low-prestate-claim').length, 24)
  assert.equal(plan.filter((row) => row.status === 'corrected-baseline-unavailable').length, 157)
  assert.equal(plan.filter((row) => row.index < FIRST).length, FIRST)
  assert.ok(plan.every((row) => row.qAssets === Q))
  assert.ok(plan.filter((row) => row.status === 'ready').every((row) => row.holder))
})

test('offline verifier rejects a different holder or asset even with a new seal', () => {
  const body = {
    study: 'morpho-v2-material-baseline-v1',
    denominator: N,
    qAssets: Q,
    manifestSha256: '6c37829c74cf1897c6a86a409fddc1bdaf1e94b64169695df589f49214f1dbf5',
    factorySha256: FACTORY_SHA,
    stage1Sha256: STAGE1_SHA,
    prospective: false,
    rows: plan,
  }
  assert.equal(verifySnapshot(seal(body), plan).rows.length, N)
  const index = plan.findIndex((row) => row.status === 'ready')
  const tampered = structuredClone(body)
  tampered.rows[index].holder = '0x1111111111111111111111111111111111111111'
  assert.throws(() => verifySnapshot(seal(tampered), plan), /Frozen row field changed/)
  tampered.rows[index] = { ...plan[index], asset: plan[index].vault }
  assert.throws(() => verifySnapshot(seal(tampered), plan), /Frozen row field changed/)
})

test('B-1 material call is pinned, identity checked, and independent of later outcomes', async () => {
  const row = plan.find((item) => item.status === 'ready')
  const calls = []
  const client = {
    async request({ method, params }) {
      calls.push({ method, params })
      assert.equal(method, 'eth_getBlockByNumber')
      const number = Number(BigInt(params[0]))
      return {
        number: params[0],
        hash: number === row.preBlock ? row.preBlockHash : row.anchorBlockHash,
        parentHash: row.preBlockHash,
        timestamp: '0x1',
        gasLimit: '0x1c9c380',
      }
    },
  }
  const observed = await measureRow(client, row, {
    out: '/tmp/material-baseline-test.json',
    guard: () => {},
    observeFn: async (_request, sampled, header, baseline) => {
      assert.equal(sampled.qAssets, Q)
      assert.equal(sampled.holder, row.holder)
      assert.equal(header.hash, row.preBlockHash)
      return baseline
        ? { asset: row.asset, adapter: '0x0000000000000000000000000000000000000000' }
        : { status: 'success', censoring: [], asset: row.asset, hash: row.preBlockHash }
    },
  })
  assert.equal(observed.status, 'baseline-success')
  assert.deepEqual(
    calls.map((call) => Number(BigInt(call.params[0]))),
    [row.preBlock, row.anchorBlock, row.preBlock],
  )
})

test('one-row run persists a sealed 304-row checkpoint without a future block read', async () => {
  const target = plan.find((row) => row.status === 'ready')
  const requested = []
  const client = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0x1'
      requested.push(Number(BigInt(params[0])))
      const number = Number(BigInt(params[0]))
      assert.ok([target.preBlock, target.anchorBlock].includes(number))
      return {
        number: params[0],
        hash: number === target.preBlock ? target.preBlockHash : target.anchorBlockHash,
        parentHash: target.preBlockHash,
        timestamp: '0x1',
        gasLimit: '0x1c9c380',
      }
    },
  }
  const out = resolve(mkdtempSync(`${tmpdir()}/material-baseline-`), 'snapshot.json')
  const saved = await run({
    client,
    paths,
    out,
    maxRows: 1,
    guard: () => {},
    observeFn: async (_request, row, _header, baseline) =>
      baseline
        ? {
            status: 'baseline-observed',
            censoring: [],
            asset: row.asset,
            runtimeCodeHash: row.baselineRuntimeCodeHash,
            holderCodeHash: null,
            holderClaimAssets: row.holderClaimAssets,
            adapter: '0x0000000000000000000000000000000000000000',
            proxyImplementation: null,
          }
        : {
            status: 'success',
            call: 'success',
            censoring: [],
            asset: row.asset,
            hash: row.preBlockHash,
            runtimeCodeHash: row.baselineRuntimeCodeHash,
            holderCodeHash: null,
            holderClaimAssets: row.holderClaimAssets,
            adapter: '0x0000000000000000000000000000000000000000',
            proxyImplementation: null,
            gasStatus: 'observed',
            gasEstimate: '100000',
            gasLimit: '30000000',
            output: encodeFunctionResult({
              abi: withdrawAbi,
              functionName: 'withdraw',
              result: 1n,
            }),
            shares: '1',
          },
  })
  assert.equal(saved.rows.length, N)
  assert.equal(saved.rows[target.index].status, 'baseline-success')
  assert.equal(verifySnapshot(JSON.parse(readFileSync(out)), plan).rows.length, N)
  assert.deepEqual(requested, [target.preBlock, target.anchorBlock, target.preBlock])
})

test('real observer and offline verifier agree on a hash-pinned 30m-gas material call', async () => {
  const original = plan.find((item) => item.status === 'ready')
  const row = {
    ...original,
    baselineRuntimeCodeHash: keccak256('0x6000'),
    holderClaimAssets: Q,
  }
  const methodName = (data) => {
    const selector = data.slice(0, 10)
    return vaultAbi.find(
      (entry) => entry.type === 'function' && toFunctionSelector(entry) === selector,
    )?.name
  }
  const rpcMethods = []
  const client = {
    async request({ method, params }) {
      rpcMethods.push(method)
      if (method === 'eth_getBlockByNumber') {
        const number = Number(BigInt(params[0]))
        assert.ok([row.preBlock, row.anchorBlock].includes(number))
        return {
          number: params[0],
          hash: number === row.preBlock ? row.preBlockHash : row.anchorBlockHash,
          parentHash: row.preBlockHash,
          timestamp: '0x1',
          gasLimit: '0x1c9c380',
        }
      }
      assert.equal(params.at(-1).blockHash, row.preBlockHash)
      if (method === 'eth_getCode') return params[0] === row.vault ? '0x6000' : '0x'
      if (method === 'eth_getStorageAt') return `0x${'0'.repeat(64)}`
      if (method === 'eth_estimateGas') return '0x186a0'
      if (method === 'eth_call') {
        assert.equal(params[0].gas, '0x1c9c380')
        const name = methodName(params[0].data)
        const result =
          name === 'asset'
            ? row.asset
            : name === 'liquidityAdapter'
              ? '0x0000000000000000000000000000000000000000'
              : BigInt(Q)
        assert.ok(name)
        return encodeFunctionResult({ abi: vaultAbi, functionName: name, result })
      }
      throw new Error(`Unexpected RPC: ${method}`)
    },
  }
  const measured = await measureRow(client, row, {
    out: '/tmp/material-real-observer-test.json',
    guard: () => {},
  })
  assert.equal(measured.status, 'baseline-success')
  const body = {
    study: 'morpho-v2-material-baseline-v1',
    denominator: N,
    qAssets: Q,
    manifestSha256: '6c37829c74cf1897c6a86a409fddc1bdaf1e94b64169695df589f49214f1dbf5',
    factorySha256: FACTORY_SHA,
    stage1Sha256: STAGE1_SHA,
    prospective: false,
    rows: plan.map((item) => (item.index === row.index ? measured : item)),
  }
  const syntheticPlan = plan.map((item) => (item.index === row.index ? row : item))
  assert.equal(verifySnapshot(seal(body), syntheticPlan).rows[row.index].status, 'baseline-success')
  assert.equal(rpcMethods.filter((method) => method === 'eth_getBlockByNumber').length, 3)
  assert.equal(rpcMethods.filter((method) => method === 'eth_call').length, 9)
})

test('a swallowed resource failure remains fatal, never a censored outcome', async () => {
  const row = plan.find((item) => item.status === 'ready')
  let guardCalls = 0
  const client = {
    async request({ method, params }) {
      if (method !== 'eth_getBlockByNumber') throw new Error('Unexpected RPC')
      const number = Number(BigInt(params[0]))
      return {
        number: params[0],
        hash: number === row.preBlock ? row.preBlockHash : row.anchorBlockHash,
        parentHash: row.preBlockHash,
        timestamp: '0x1',
        gasLimit: '0x1c9c380',
      }
    },
  }
  await assert.rejects(
    measureRow(client, row, {
      out: '/tmp/material-resource-test.json',
      guard: () => {
        if (++guardCalls > 2) throw new Error('Morpho disk reserve reached')
      },
      observeFn: async (request) => {
        try {
          await request('eth_getCode', [row.vault, { blockHash: row.preBlockHash }])
        } catch {
          // Simulate the production observer catching an RPC error internally.
        }
        return { asset: row.asset }
      },
    }),
    /Morpho disk reserve reached/,
  )
})
