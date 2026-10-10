import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi } from 'viem'
import {
  chooseControls,
  FACTORY_SHA,
  MANIFEST_SHA,
  pageDisposition,
} from './morpho-v2-full-cohort-controls.mjs'
import {
  STUDY,
  ESTIMAND,
  TREATED_SHA,
  CONTROL_SHA,
  candidatePlan,
  loadFrozen,
  screen,
  verify,
} from './morpho-v2-first-anchor-controls-v2.mjs'

const paths = {
  manifestPath: 'data/research/venue-signals/morpho-v2-full-cohort-manifest.json',
  factoryPath: `data/research/venue-signals/${FACTORY_SHA}.json`,
  treatedPath: 'data/research/venue-signals/morpho-v2-full-cohort-baseline.json',
  controlPath: 'data/research/venue-signals/morpho-v2-full-cohort-controls.json',
}
const seal = (value) => ({
  ...value,
  checkpointSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
})
const dead = `0x${'0'.repeat(36)}dead`

test('dry source pins four original candidates and excludes burn holder without replacement', () => {
  const frozen = loadFrozen(paths)
  assert.equal(frozen.sources.length, 4)
  assert.equal(frozen.oldRow.selected.length, 2)
  assert.equal(frozen.oldRow.selected[0].holder, dead)
  assert.deepEqual(
    frozen.sources.map(
      (source) => candidatePlan(source.raw.logs).filter((x) => x.exclusionReason).length,
    ),
    [1, 1, 1, 1],
  )
  assert.deepEqual(candidatePlan(frozen.sources[3].raw.logs), [
    { holder: dead, shares: '1000000000000000000', exclusionReason: 'dead-address' },
  ])
  assert.equal(TREATED_SHA.length, 64)
  assert.equal(CONTROL_SHA.length, 64)
})

test('B−1 screen never asks code or withdraw from sole dead holder', async () => {
  const frozen = loadFrozen(paths)
  const source = frozen.sources[3]
  source.old.runtimeCodeHash = keccak256('0x6000')
  const abi = parseAbi([
    'function totalSupply() view returns (uint256)',
    'function totalAssets() view returns (uint256)',
  ])
  const names = Object.fromEntries(
    ['totalSupply', 'totalAssets'].map((name) => [
      encodeFunctionData({ abi, functionName: name }).slice(0, 10),
      name,
    ]),
  )
  const calls = []
  const client = {
    request: async ({ method, params }) => {
      calls.push({ method, params })
      if (method === 'eth_getBlockByNumber') {
        const block = Number(BigInt(params[0]))
        return {
          number: params[0],
          hash:
            block === source.old.preBlock
              ? frozen.anchor.baseline.preBlockHash
              : frozen.anchor.row.anchorBlockHash,
        }
      }
      if (method === 'eth_getCode') {
        assert.equal(params[0], source.old.vault)
        return '0x6000'
      }
      if (method === 'eth_call') {
        assert.equal(params[1].blockHash, source.old.preBlockHash)
        const name = names[params[0].data.slice(0, 10)]
        return encodeAbiParameters([{ type: 'uint256' }], [BigInt(source.old[name])])
      }
      throw new Error('Unexpected RPC')
    },
  }
  const row = await screen({
    client,
    frozen,
    index: 3,
    out: '/tmp/morpho-v2-controls-test.json',
    stat: () => ({ bavail: 5_000_000_000, bsize: 1 }),
  })
  assert.equal(row.status, 'no-successful-eoa-holder')
  assert.equal(row.v1Status, 'baseline-success')
  assert.deepEqual(
    row.holderAttempts.map((x) => x.status),
    ['excluded-sentinel'],
  )
  assert.ok(!calls.some((x) => x.method === 'eth_getCode' && x.params[0] === dead))
  assert.ok(!calls.some((x) => x.method === 'eth_call' && x.params[0].from === dead))
})

test('offline verifier rejects re-sealed sentinel selection; disk guard blocks before RPC', async () => {
  const frozen = loadFrozen(paths)
  const old = frozen.sources[3].old
  const row = {
    ...old,
    v1Status: old.status,
    v1RawSha256: old.rawSha256,
    v1HolderAttempts: old.holderAttempts,
    holderAttempts: [
      {
        holder: dead,
        shares: '1000000000000000000',
        status: 'excluded-sentinel',
        exclusionReason: 'dead-address',
      },
    ],
    sentinelExclusions: candidatePlan(frozen.sources[3].raw.logs).filter((x) => x.exclusionReason),
    status: 'no-successful-eoa-holder',
    rpcCalls: 5,
  }
  delete row.holder
  delete row.holderShares
  delete row.holderClaimAssets
  delete row.withdrawShares
  const base = {
    study: STUDY,
    estimand: ESTIMAND,
    status: 'partial',
    manifestSha256: MANIFEST_SHA,
    factorySha256: FACTORY_SHA,
    treatedPhysicalSha256: TREATED_SHA,
    controlPhysicalSha256: CONTROL_SHA,
    anchorIndex: 0,
    denominator: 304,
    screened: [],
    selected: [],
    disposition: pageDisposition(frozen.anchor, []),
  }
  assert.doesNotThrow(() => verify(seal(base), frozen))
  const tampered = {
    ...base,
    screened: [{ ...row, holder: dead, status: 'baseline-success' }],
    selected: chooseControls(
      [{ ...row, holder: dead, status: 'baseline-success' }],
      frozen.oldRow.treatedState,
      frozen.anchor.treatedAgeSeconds,
    ),
    disposition: pageDisposition(frozen.anchor, [row]),
  }
  assert.throws(() => verify(seal(tampered), frozen), /candidate frontier mismatch/)
  let rpcCalls = 0
  await assert.rejects(
    screen({
      client: {
        request: async () => {
          rpcCalls++
          return null
        },
      },
      frozen,
      index: 3,
      out: '/tmp/morpho-v2-controls-test.json',
      stat: () => ({ bavail: 2_499_999_999, bsize: 1 }),
    }),
    /Disk reserve/,
  )
  assert.equal(rpcCalls, 0)
})

test('first-anchor screen retains transport and bounded-budget censors', async () => {
  const frozen = loadFrozen(paths)
  const options = {
    frozen,
    index: 3,
    out: '/tmp/morpho-v2-controls-test.json',
    stat: () => ({ bavail: 5_000_000_000, bsize: 1 }),
  }
  const transport = await screen({
    ...options,
    client: {
      request: async () => {
        throw new Error('archive unavailable')
      },
    },
  })
  assert.equal(transport.status, 'candidate-rpc-ambiguous')
  assert.equal(transport.rpcCalls, 1)
  let calls = 0
  const budgeted = await screen({
    ...options,
    rpcLimit: 1,
    client: {
      request: async () => {
        calls++
        return {
          number: `0x${frozen.sources[3].old.preBlock.toString(16)}`,
          hash: frozen.anchor.baseline.preBlockHash,
        }
      },
    },
  })
  assert.equal(budgeted.status, 'rpc-budget-censored')
  assert.equal(budgeted.rpcCalls, 1)
  assert.equal(calls, 1)
})
