import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'
import {
  B,
  B_HASH,
  CHUNK_BLOCKS,
  CONTROLS,
  PROPOSAL_TX,
  Q,
  STUDY,
  TREATED,
  TRANSFER_TOPIC,
  USDC,
  collect,
  loadPlan,
  probeBaseline,
  replay,
  verifyArtifacts,
} from './morpho-v2-cap-prospective-baseline.mjs'

const ABI = parseAbi([
  'function asset() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function liquidityAdapter() view returns (address)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const HOLDER = '0x1111111111111111111111111111111111111111'
const ADAPTER = '0x2222222222222222222222222222222222222222'
const HASH = `0x${'a'.repeat(64)}`
const TX = `0x${'b'.repeat(64)}`
const ZERO = `0x${'0'.repeat(40)}`
const topicAddress = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`
const highDisk = () => ({ bavail: 1_000_000, bsize: 4096 })
function reseal(segment) {
  const { segmentSha256: ignored, ...payload } = segment
  void ignored
  return {
    ...payload,
    segmentSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  }
}
function fixturePlan() {
  return {
    study: STUDY,
    factorySha256: 'f'.repeat(64),
    submitSha256: 'e'.repeat(64),
    watcherFrontierSha256: 'd'.repeat(64),
    proposalSegmentSha256: 'c'.repeat(64),
    baselineBlock: B,
    baselineHash: B_HASH,
    proposalTx: PROPOSAL_TX,
    qRaw: Q.toString(),
    vaults: [TREATED, ...CONTROLS].map((vault, index) => ({
      index,
      role: index ? 'control' : 'treated',
      vault,
      creationBlock: B - 1,
      creationHash: HASH,
      asset: USDC,
    })),
  }
}
function mint(vault = TREATED, shares = 2n * Q) {
  return {
    address: vault,
    removed: false,
    blockNumber: `0x${(B - 1).toString(16)}`,
    blockHash: HASH,
    transactionHash: TX,
    logIndex: '0x0',
    topics: [TRANSFER_TOPIC, topicAddress(ZERO), topicAddress(HOLDER)],
    data: `0x${shares.toString(16).padStart(64, '0')}`,
  }
}
function replayMint(shares = 2n * Q) {
  return [
    {
      block: B - 1,
      blockHash: HASH,
      txHash: TX,
      logIndex: 0,
      from: ZERO,
      to: HOLDER,
      value: shares.toString(),
    },
  ]
}
function fakeRpc({
  logs = [mint()],
  shares = 2n * Q,
  claim = 2n * Q,
  revert = false,
  holderCode = '0x',
  malformed = false,
  canonical = true,
} = {}) {
  const seen = []
  return {
    seen,
    request: async ({ method, params }) => {
      seen.push({ method, params })
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_getBlockByNumber') {
        const n = params[0] === 'finalized' ? B + 10 : Number(BigInt(params[0]))
        return {
          number: `0x${n.toString(16)}`,
          hash: n === B ? (canonical ? B_HASH : HASH) : HASH,
          parentHash: HASH,
        }
      }
      if (method === 'eth_getLogs') return logs
      if (method === 'eth_getCode') return params[0] === HOLDER ? holderCode : '0x6001'
      if (method === 'eth_call') {
        assert.equal(params[1].blockHash, B_HASH)
        assert.equal(params[1].requireCanonical, true)
        assert.equal(Number(BigInt(params[0].gas)), 30_000_000)
        const { functionName } = decodeFunctionData({ abi: ABI, data: params[0].data })
        if (functionName === 'withdraw' && revert)
          throw Object.assign(new Error('execution reverted'), { code: 3 })
        const values = {
          asset: USDC,
          totalSupply: shares,
          totalAssets: 20n * Q,
          balanceOf: shares,
          previewRedeem: claim,
          liquidityAdapter: ADAPTER,
          withdraw: Q,
        }
        return encodeFunctionResult({
          abi: ABI,
          functionName,
          result: malformed && functionName === 'totalSupply' ? 0n : values[functionName],
        })
      }
      throw new Error(`Unexpected RPC method ${method}`)
    },
  }
}
function row(logs = replayMint()) {
  return { vault: fixturePlan().vaults[0], logs }
}
const probe = (rpc, logs) =>
  probeBaseline({
    request: (method, params) => rpc.request({ method, params }),
    getBlock: async () => ({ number: B, hash: B_HASH }),
    row: row(logs),
  })

test('real frozen sources prove one proposal transaction and deterministic four controls', () => {
  const plan = loadPlan()
  assert.equal(plan.vaults.length, 5)
  assert.deepEqual(
    plan.vaults.map((x) => x.vault),
    [TREATED, ...CONTROLS],
  )
  assert.equal(plan.baselineHash, B_HASH)
})
test('quiet vault and missing EOA are explicit and never lower q', async () => {
  assert.equal(
    (await probe(fakeRpc({ logs: [], shares: 0n, claim: 0n }), [])).status,
    'no-positive-code-empty-eoa',
  )
  assert.equal(
    (await probe(fakeRpc({ holderCode: '0x6001' }))).status,
    'no-positive-code-empty-eoa',
  )
})
test('low claim, success, revert and ledger mismatch remain separate', async () => {
  assert.equal((await probe(fakeRpc({ claim: Q - 1n }))).status, 'holder-claim-below-fixed-q')
  const success = await probe(fakeRpc())
  assert.equal(success.status, 'baseline-success')
  assert.equal(success.qRaw, Q.toString())
  assert.equal(success.holder, HOLDER)
  assert.equal(success.liquidityAdapter, ADAPTER)
  assert.equal((await probe(fakeRpc({ revert: true }))).status, 'baseline-revert')
  assert.equal(
    (await probe(fakeRpc({ malformed: true }))).status,
    'transfer-ledger-supply-mismatch',
  )
})
test('replay forbids impossible underflow and retains address tie-break', () => {
  const other = '0x3333333333333333333333333333333333333333'
  const logs = replayMint(10n)
  logs.push({ ...logs[0], logIndex: 1, to: other })
  assert.deepEqual(
    replay(logs).map(([address]) => address),
    [HOLDER, other],
  )
  assert.throws(() => replay([{ ...logs[0], from: HOLDER, to: ZERO }]), /underflow/)
})
test('append-only transfer stage resumes, then offline verifier rejects tamper', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-cap-baseline-'))
  const plan = fixturePlan(),
    rpc = fakeRpc()
  const first = await collect({ client: rpc, out, plan, maxSteps: 1, stat: highDisk })
  assert.equal(first.frontier[0].throughBlock, B)
  assert.equal(first.baselineRowsCompleted, 0)
  const second = await collect({ client: rpc, out, plan, maxSteps: 1, stat: highDisk })
  assert.equal(second.baselineRowsCompleted, 1)
  assert.equal(second.baselineSuccessCount, 1)
  assert.equal(second.frontier[0].status, 'baseline-success')
  assert.equal(verifyArtifacts({ out, plan }).files, 2)
  const file = join(
    out,
    readdirSync(out).find((name) => name.endsWith('baseline.json')),
  )
  const segment = JSON.parse(readFileSync(file))
  segment.result.qRaw = '1'
  writeFileSync(file, JSON.stringify(segment))
  assert.throws(() => verifyArtifacts({ out, plan }), /seal|continuity/i)
})
test('canonical B mismatch halts without writing an artifact', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-cap-reorg-'))
  await assert.rejects(
    collect({
      client: fakeRpc({ canonical: false }),
      out,
      plan: fixturePlan(),
      maxSteps: 1,
      stat: highDisk,
    }),
    /canonical hash mismatch/,
  )
  assert.equal(readdirSync(out).length, 0)
})
test('offline verifier rejects a re-sealed final transfer chunk with a forged B hash', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-cap-forged-b-'))
  const plan = fixturePlan()
  await collect({ client: fakeRpc(), out, plan, maxSteps: 1, stat: highDisk })
  const file = join(
    out,
    readdirSync(out).find((name) => name.endsWith('transfer.json')),
  )
  const segment = JSON.parse(readFileSync(file))
  assert.equal(segment.to, B)
  segment.toHash = HASH
  writeFileSync(file, JSON.stringify(reseal(segment)))
  assert.throws(() => verifyArtifacts({ out, plan }), /Transfer segment range mismatch/)
})
test('offline verifier rejects a re-sealed quiet first chunk with a forged creation hash', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-cap-forged-creation-'))
  const plan = fixturePlan()
  await collect({ client: fakeRpc({ logs: [] }), out, plan, maxSteps: 1, stat: highDisk })
  const file = join(
    out,
    readdirSync(out).find((name) => name.endsWith('transfer.json')),
  )
  const segment = JSON.parse(readFileSync(file))
  assert.equal(segment.from, plan.vaults[0].creationBlock)
  assert.equal(segment.logs.length, 0)
  segment.fromHash = B_HASH
  writeFileSync(file, JSON.stringify(reseal(segment)))
  assert.throws(() => verifyArtifacts({ out, plan }), /Transfer segment range mismatch/)
})
test('an orphan interior Transfer log stops before append', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-cap-orphan-log-'))
  const plan = fixturePlan()
  plan.vaults[0].creationBlock = B - 2
  const orphan = mint()
  orphan.blockHash = `0x${'c'.repeat(64)}`
  await assert.rejects(
    collect({ client: fakeRpc({ logs: [orphan] }), out, plan, maxSteps: 1, stat: highDisk }),
    /noncanonical block/,
  )
  assert.equal(readdirSync(out).length, 0)
})
test('completed but ineligible baseline row is not counted as a success', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-cap-ineligible-'))
  const plan = fixturePlan()
  const result = await collect({
    client: fakeRpc({ holderCode: '0x6001' }),
    out,
    plan,
    maxSteps: 2,
    stat: highDisk,
  })
  assert.equal(result.baselineRowsCompleted, 1)
  assert.equal(result.baselineSuccessCount, 0)
  assert.equal(result.statusCounts['no-positive-code-empty-eoa'], 1)
})
test('offline verifier rejects a re-sealed success missing B supply or claim calls', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-cap-forged-success-'))
  const plan = fixturePlan()
  await collect({ client: fakeRpc(), out, plan, maxSteps: 2, stat: highDisk })
  const file = join(
    out,
    readdirSync(out).find((name) => name.endsWith('baseline.json')),
  )
  const original = JSON.parse(readFileSync(file))
  for (const field of ['totalSupply', 'totalAssets', 'balanceOf', 'examinedHolders']) {
    const forged = structuredClone(original)
    delete forged.result[field]
    writeFileSync(file, JSON.stringify(reseal(forged)))
    assert.throws(() => verifyArtifacts({ out, plan }), /baseline|holder/i, field)
  }
})
test('bounded transfer chunk and fixed q remain unchanged', () => {
  assert.equal(CHUNK_BLOCKS, 1000)
  assert.equal(Q, 1_000_000_000_000n)
})
