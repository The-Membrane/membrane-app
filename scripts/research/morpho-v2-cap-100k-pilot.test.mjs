import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toHex } from 'viem'
import { B, B_HASH, TREATED, USDC } from './morpho-v2-cap-prospective-baseline.mjs'
import {
  Q,
  classifySourceResult,
  collect,
  probe,
  readiness,
  verify,
} from './morpho-v2-cap-100k-pilot.mjs'

const ABI = parseAbi([
  'function asset() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function liquidityAdapter() view returns (address)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const HOLDER = '0xcf46bbab1f7bdd392be98ec08e653cb8bb6cc94a'
const ADAPTER = '0xedee08b242d4cd94127cec8a4c334cd2d0ca3f65'
const source = {
  vault: TREATED,
  baselineBlock: B,
  baselineHash: B_HASH,
  qRaw: '1000000000000',
  status: 'holder-claim-below-fixed-q',
  holder: HOLDER,
  holderShares: '234946085631000000000000',
  balanceOf: '234946085631000000000000',
  replayedSupply: '16013022342138891438837923',
  totalSupply: '16013022342138891438837923',
  totalAssets: '16042526414242',
  asset: USDC,
  liquidityAdapter: ADAPTER,
  runtimeCodeHash: '0xb87264448eb495fa597c09eb4a576b7d6f029cb98957d3cb2491904a39abd8e9',
  previewRedeemable: '235370615137',
  examinedHolders: [{ holder: HOLDER, shares: '234946085631000000000000', codeHash: null }],
}
const row = {
  index: 0,
  role: 'treated',
  vault: TREATED,
  status: 'fixed-holder-ready',
  sourceStatus: source.status,
  sourceResult: source,
}

function requestFor(claimRaw, { revert = false } = {}) {
  let withdraws = 0
  const request = async (method, params) => {
    if (method === 'eth_getCode') return params[0] === HOLDER ? '0x' : '0x6000'
    assert.equal(method, 'eth_call')
    assert.deepEqual(params[1], { blockHash: B_HASH, requireCanonical: true })
    assert.equal(params[0].gas, toHex(30_000_000))
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: params[0].data })
    if (functionName === 'withdraw') {
      withdraws++
      assert.equal(args[0], Q)
      assert.equal(args[1].toLowerCase(), HOLDER)
      assert.equal(args[2].toLowerCase(), HOLDER)
      assert.equal(params[0].from, HOLDER)
      if (revert) throw Object.assign(new Error('execution reverted'), { code: 3 })
    }
    const values = {
      asset: USDC,
      totalSupply: BigInt(source.totalSupply),
      totalAssets: BigInt(source.totalAssets),
      balanceOf: BigInt(source.holderShares),
      previewRedeem: BigInt(claimRaw),
      liquidityAdapter: ADAPTER,
      withdraw: 1n,
    }
    return encodeFunctionResult({ abi: ABI, functionName, result: values[functionName] })
  }
  return { request, getWithdraws: () => withdraws }
}

test('frozen q is $100k raw, not a rescaled $1m row', () => {
  assert.equal(Q, 100_000_000_000n)
  assert.equal(source.previewRedeemable, '235370615137')
})

test('low claim censors before withdraw without changing holder', async () => {
  const rpc = requestFor('99999999999')
  const matching = {
    ...row,
    sourceResult: {
      ...source,
      runtimeCodeHash: keccak256('0x6000'),
      previewRedeemable: '99999999999',
    },
  }
  const result = await probe({ row: matching, request: rpc.request })
  assert.equal(result.status, 'holder-claim-below-fixed-q')
  assert.equal(result.holder, HOLDER)
  assert.equal(rpc.getWithdraws(), 0)
})

test('matching B claim above q attempts same-holder withdrawal and captures revert', async () => {
  const rpc = requestFor(source.previewRedeemable, { revert: true })
  const matching = { ...row, sourceResult: { ...source, runtimeCodeHash: keccak256('0x6000') } }
  const result = await probe({ row: matching, request: rpc.request })
  assert.equal(result.status, 'baseline-revert')
  assert.equal(rpc.getWithdraws(), 1)
})

test('success is not assumed from source low-$1m result', async () => {
  const rpc = requestFor(source.previewRedeemable)
  const matching = { ...row, sourceResult: { ...source, runtimeCodeHash: keccak256('0x6000') } }
  const result = await probe({ row: matching, request: rpc.request })
  assert.equal(result.status, 'baseline-success')
  assert.equal(result.holder, HOLDER)
  assert.equal(rpc.getWithdraws(), 1)
})

test('incomplete control prefixes stay pending; collector does not fabricate them', async () => {
  const plan = {
    baselineBlock: B,
    baselineHash: B_HASH,
    vaults: [
      { index: 0, role: 'treated', vault: TREATED },
      ...[
        '0x195b3a57dd0480534c84a5607a52a92304fa81f2',
        '0x3833c5f51c1af6435e34d2fbddb4ba94612f1a79',
        '0x0bd9bc3c61406b3851c9c09950235205ff3a2d5f',
        '0x49379379529ef1ff7c4adc5364be33ba8666df4e',
      ].map((vault, i) => ({ index: i + 1, role: 'control', vault })),
    ],
  }
  // The original full verifier exposes incomplete prefixes, not invented holders.
  const sourceState = readiness({ plan, million: '/nonexistent-100k-source' })
  assert.equal(sourceState.transferPrefixesComplete, false)
  assert.equal(sourceState.rows.length, 5)
  const ready = {
    plan,
    rows: plan.vaults.map((v) => ({
      ...v,
      status: 'transfer-prefix-incomplete',
      throughBlock: B - 1,
    })),
  }
  const result = await collect({
    client: {
      request: () => {
        throw new Error('unexpected RPC')
      },
    },
    ready,
    out: '/tmp/morpho-100k-test-not-created',
    maxRows: 5,
  })
  assert.equal(result.collected, 0)
  assert.equal(result.pendingPrefixes.length, 5)
})

test('only exact no-positive-EOA source gets a clean no-holder label', () => {
  assert.equal(classifySourceResult(null), 'transfer-prefix-incomplete')
  assert.equal(
    classifySourceResult({ status: 'no-positive-code-empty-eoa' }),
    'source-no-fixed-holder',
  )
  assert.equal(
    classifySourceResult({ status: 'holder-code-rpc-ambiguous' }),
    'source-baseline-unusable',
  )
  assert.equal(
    classifySourceResult({ status: 'historical-state-rpc-ambiguous' }),
    'source-baseline-unusable',
  )
})

function checkReSealed(result, sourceResult = source, status = 'fixed-holder-ready') {
  const out = mkdtempSync(join(tmpdir(), 'morpho-100k-verify-'))
  try {
    const plan = {
      proposalTx: `0x${'1'.repeat(64)}`,
      watcherFrontierSha256: '2'.repeat(64),
      factorySha256: '3'.repeat(64),
      submitSha256: '4'.repeat(64),
    }
    const testRow = {
      index: 0,
      role: 'treated',
      vault: TREATED,
      status,
      sourceStatus: sourceResult.status,
      sourceSha256: '5'.repeat(64),
      sourceSegmentSha256: '6'.repeat(64),
      sourceResult,
    }
    const saved = {
      study: 'morpho-v2-cap-prospective-fixed-exit-100k-exploratory-v1',
      schemaVersion: 1,
      chainId: 1,
      index: 0,
      role: 'treated',
      vault: TREATED,
      baselineBlock: B,
      baselineHash: B_HASH,
      qRaw: Q.toString(),
      proposalTx: plan.proposalTx,
      watcherFrontierSha256: plan.watcherFrontierSha256,
      factorySha256: plan.factorySha256,
      submitSha256: plan.submitSha256,
      sourceMillionResultSha256: testRow.sourceSha256,
      sourceMillionResultSegmentSha256: testRow.sourceSegmentSha256,
      sourceMillionStatus: sourceResult.status,
      holder: sourceResult.holder || null,
      result,
    }
    saved.payloadSha256 = createHash('sha256').update(JSON.stringify(saved)).digest('hex')
    writeFileSync(join(out, '00-baseline.json'), JSON.stringify(saved))
    return verify({ ready: { plan, rows: [testRow] }, out })
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

test('offline verifier rejects a re-sealed success whose claim differs from pinned B source', () => {
  const result = {
    status: 'baseline-success',
    holder: HOLDER,
    holderShares: source.holderShares,
    sourceStatus: source.status,
    sourceClaimRaw: source.previewRedeemable,
    runtimeCodeHash: source.runtimeCodeHash,
    asset: USDC,
    liquidityAdapter: ADAPTER,
    totalSupply: source.totalSupply,
    totalAssets: source.totalAssets,
    holderBalance: source.holderShares,
    claimRaw: '999999999999',
    withdrawShares: '100000000000000000000000',
  }
  assert.throws(() => checkReSealed(result), /false fixed-exit status/)
  result.claimRaw = source.previewRedeemable
  assert.equal(checkReSealed(result).success, 1)
})

test('offline verifier rejects a clean no-EOA label from ambiguous source and a revert without fixed holder', () => {
  const ambiguous = { ...source, status: 'holder-code-rpc-ambiguous', holder: undefined }
  assert.throws(
    () =>
      checkReSealed(
        { status: 'source-no-fixed-holder', holder: null, sourceStatus: ambiguous.status },
        ambiguous,
        'source-baseline-unusable',
      ),
    /false source-holder censor/,
  )
  assert.throws(
    () =>
      checkReSealed(
        { status: 'baseline-revert', holder: null, claimRaw: source.previewRedeemable },
        ambiguous,
        'source-baseline-unusable',
      ),
    /false (source-holder censor|fixed-exit status)/,
  )
})
