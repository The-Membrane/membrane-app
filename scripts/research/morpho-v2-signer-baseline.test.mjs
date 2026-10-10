import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem'
import {
  FIRST_ROWS,
  RESERVE_BYTES,
  STUDY,
  V1_SHA,
  guardDisk,
  holderPlan,
  loadInputs,
  probe,
  sentinelReason,
  signerStratum,
  verifyCheckpoint,
} from './morpho-v2-signer-baseline.mjs'

const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`
const dead = `0x${'0'.repeat(36)}dead`
const blockHash = `0x${'a'.repeat(64)}`
const txHash = `0x${'b'.repeat(64)}`
const log = (index, to, amount) => ({
  block: 1,
  blockHash,
  logIndex: index,
  txHash,
  from: addr(0),
  to,
  value: String(amount),
})

test('zero, dead and 0x1..0xff are excluded before the first code read', () => {
  assert.equal(sentinelReason(addr(0)), 'zero-address')
  assert.equal(sentinelReason(dead), 'dead-address')
  assert.equal(sentinelReason(addr(1)), 'low-reserved-address')
  assert.equal(sentinelReason(addr(255)), 'low-reserved-address')
  assert.equal(sentinelReason(addr(256)), null)
  const plan = holderPlan([log(0, dead, 1_000), log(1, addr(1), 500), log(2, addr(256), 100)])
  assert.equal(plan.replayedSupply, '1600')
  assert.deepEqual(
    plan.excluded.map((x) => x.reason),
    ['dead-address', 'low-reserved-address'],
  )
  assert.deepEqual(
    plan.candidates.map((x) => x.holder),
    [addr(256)],
  )
  assert.equal(holderPlan([log(0, dead, 1_000)]).candidates.length, 0)
})

test('account nonce is contextual, never proof of EOA signing or present key control', () => {
  assert.equal(signerStratum(0), 'code-empty-zero-account-nonce')
  assert.equal(signerStratum(1), 'code-empty-positive-account-nonce')
  assert.throws(() => signerStratum(-1))
})

function mockPrefix() {
  const vault = addr(500),
    holder = addr(256)
  return {
    anchor: {
      index: 0,
      proposalIndex: 42,
      vault,
      anchorBlock: 10,
      anchorBlockHash: blockHash,
      preBlock: 9,
    },
    old: { status: 'baseline-success', preBlockHash: blockHash, totalAssets: '1000' },
    rawSha256: 'c'.repeat(64),
    raw: { logs: [log(0, dead, 1000), log(1, holder, 100)] },
  }
}

function mockClient(prefix, nonce = 2, { redeemable = 100, withdrawError = null } = {}) {
  const abi = parseAbi([
    'function totalSupply() view returns (uint256)',
    'function totalAssets() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function previewRedeem(uint256) view returns (uint256)',
    'function withdraw(uint256,address,address) returns (uint256)',
  ])
  const selected = addr(256),
    calls = []
  const names = Object.fromEntries(
    ['totalSupply', 'totalAssets', 'balanceOf', 'previewRedeem', 'withdraw'].map((name) => [
      encodeFunctionData({
        abi,
        functionName: name,
        args:
          name === 'balanceOf'
            ? [selected]
            : name === 'previewRedeem'
              ? [100n]
              : name === 'withdraw'
                ? [1n, selected, selected]
                : [],
      }).slice(0, 10),
      name,
    ]),
  )
  const uint = (n) => encodeAbiParameters([{ type: 'uint256' }], [BigInt(n)])
  return {
    calls,
    client: {
      request: async ({ method, params }) => {
        calls.push({ method, params })
        if (method === 'eth_getBlockByNumber') return { number: params[0], hash: blockHash }
        if (method === 'eth_getCode') {
          assert.notEqual(params[0], dead)
          assert.equal(params[1].blockHash, blockHash)
          return params[0] === prefix.anchor.vault ? '0x6000' : '0x'
        }
        if (method === 'eth_getTransactionCount') {
          assert.equal(params[0], selected)
          assert.equal(params[1].blockHash, blockHash)
          return `0x${nonce.toString(16)}`
        }
        if (method !== 'eth_call') throw new Error('unexpected RPC')
        assert.equal(params[1].blockHash, blockHash)
        const name = names[params[0].data.slice(0, 10)]
        if (name === 'totalSupply') return uint(1100)
        if (name === 'totalAssets') return uint(1000)
        if (name === 'balanceOf') return uint(100)
        if (name === 'previewRedeem') return uint(redeemable)
        if (name === 'withdraw') {
          assert.equal(params[0].from, selected)
          if (withdrawError) throw withdrawError
          return uint(10)
        }
        throw new Error('unknown contract call')
      },
    },
  }
}

test('B−1 probe chooses non-sentinel code-empty holder, pins nonce and recomputes q', async () => {
  const prefix = mockPrefix(),
    mock = mockClient(prefix, 2)
  const row = await probe({
    client: mock.client,
    prefix,
    out: '/tmp/signer-unit.json',
    stat: () => ({ bavail: 5_000_000_000, bsize: 1 }),
  })
  assert.equal(row.status, 'baseline-success')
  assert.equal(row.holder, addr(256))
  assert.equal(row.qAssets, '1')
  assert.equal(row.accountNonceContext.stratum, 'code-empty-positive-account-nonce')
  assert.deepEqual(
    row.excludedSentinels.map((x) => x.holder),
    [dead],
  )
  assert.ok(mock.calls.every((x) => x.method !== 'eth_getLogs'))
  const zeroNonce = await probe({
    client: mockClient(prefix, 0).client,
    prefix,
    out: '/tmp/signer-unit.json',
    stat: () => ({ bavail: 5_000_000_000, bsize: 1 }),
  })
  assert.equal(zeroNonce.status, 'baseline-success')
  assert.equal(zeroNonce.accountNonceContext.stratum, 'code-empty-zero-account-nonce')
})

test('v2 preserves zero-size, revert, and transport strata without changing selected holder', async () => {
  const prefix = mockPrefix(),
    stat = () => ({ bavail: 5_000_000_000, bsize: 1 })
  const options = { prefix, out: '/tmp/signer-unit.json', stat }
  const zero = await probe({ ...options, client: mockClient(prefix, 0, { redeemable: 1 }).client })
  assert.equal(zero.status, 'zero-baseline-size')
  assert.equal(zero.qAssets, '0')
  assert.equal(zero.holder, addr(256))
  const reverted = await probe({
    ...options,
    client: mockClient(prefix, 1, {
      withdrawError: Object.assign(new Error('execution reverted'), { code: 3 }),
    }).client,
  })
  assert.equal(reverted.status, 'baseline-revert')
  assert.equal(reverted.holder, addr(256))
  const transport = await probe({
    ...options,
    client: mockClient(prefix, 1, { withdrawError: new Error('archive timeout') }).client,
  })
  assert.equal(transport.status, 'withdraw-rpc-ambiguous')
  assert.equal(transport.holder, addr(256))
})

test('frozen first64 source and raw prefixes verify offline without new logs', () => {
  const prefixes = loadInputs({
    manifestPath: 'data/research/venue-signals/morpho-v2-full-cohort-manifest.json',
    factoryPath:
      'data/research/venue-signals/745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa.json',
    v1Path: 'data/research/venue-signals/morpho-v2-full-cohort-baseline.json',
  })
  assert.equal(prefixes.length, FIRST_ROWS)
  assert.equal(
    prefixes.filter((x) => holderPlan(x.raw.logs).excluded.some((e) => e.reason === 'dead-address'))
      .length,
    59,
  )
  assert.equal(V1_SHA.length, 64)
})

test('v2 checkpoint rejects sentinel-selected holder and preserves 2.5 GB floor', () => {
  const prefix = mockPrefix()
  const row = {
    index: 0,
    proposalIndex: 42,
    vault: prefix.anchor.vault,
    anchorBlock: 10,
    preBlock: 9,
    preBlockHash: blockHash,
    v1RawSha256: prefix.rawSha256,
    excludedSentinels: holderPlan(prefix.raw.logs).excluded,
    examinedHolders: [],
    holder: dead,
    rpcCalls: 1,
    status: 'baseline-success',
  }
  const payload = {
    study: STUDY,
    status: 'partial',
    manifestSha256: '6c37829c74cf1897c6a86a409fddc1bdaf1e94b64169695df589f49214f1dbf5',
    factorySha256: '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa',
    v1PhysicalSha256: V1_SHA,
    rows: [row],
  }
  const saved = {
    ...payload,
    checkpointSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  }
  assert.throws(() => verifyCheckpoint(saved, [prefix]), /result frontier mismatch/)
  assert.equal(RESERVE_BYTES, 2_500_000_000)
  assert.throws(
    () => guardDisk('/tmp/signer-unit.json', 0, () => ({ bavail: RESERVE_BYTES - 1, bsize: 1 })),
    /Disk reserve/,
  )
})

test('offline checkpoint rejects re-sealed holder, ordering, q, and result tampering', async () => {
  const prefix = mockPrefix()
  const row = await probe({
    client: mockClient(prefix).client,
    prefix,
    out: '/tmp/signer-unit.json',
    stat: () => ({ bavail: 5_000_000_000, bsize: 1 }),
  })
  const base = {
    study: STUDY,
    status: 'partial',
    manifestSha256: '6c37829c74cf1897c6a86a409fddc1bdaf1e94b64169695df589f49214f1dbf5',
    factorySha256: '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa',
    v1PhysicalSha256: V1_SHA,
    rows: [row],
  }
  const reseal = (value) => ({
    ...value,
    checkpointSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  })
  assert.doesNotThrow(() => verifyCheckpoint(reseal(base), [prefix]))
  for (const change of [
    { holder: addr(257) },
    { holderShares: '99' },
    { examinedHolders: [{ ...row.examinedHolders[0], holder: addr(257) }] },
    { qAssets: '2' },
    { withdrawShares: undefined },
    { accountNonceContext: { nonce: 2, stratum: 'historical-outbound-tx-evidence' } },
  ]) {
    const tampered = { ...base, rows: [{ ...row, ...change }] }
    assert.throws(() => verifyCheckpoint(reseal(tampered), [prefix]))
  }
})
