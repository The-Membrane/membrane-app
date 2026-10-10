import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toHex } from 'viem'
import { B, B_HASH, TREATED, USDC } from './morpho-v2-cap-prospective-baseline.mjs'
import { Q } from './morpho-v2-cap-100k-pilot.mjs'
import {
  ELIGIBLE_AT,
  HOLDER,
  SOURCE_SHA,
  collect,
  probe,
  selectTarget,
  verify,
} from './morpho-v2-cap-100k-outcomes.mjs'

const ABI = parseAbi([
  'function asset() view returns (address)',
  'function liquidityAdapter() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
])
const H0 = `0x${'1'.repeat(64)}`
const H1 = `0x${'2'.repeat(64)}`
const H2 = `0x${'3'.repeat(64)}`
const ADAPTER = '0xedee08b242d4cd94127cec8a4c334cd2d0ca3f65'
const target = ELIGIBLE_AT + 6 * 3600
const source = {
  payloadSha256: `a`.repeat(64),
  result: { runtimeCodeHash: keccak256('0x6000'), liquidityAdapter: ADAPTER },
}
const frozen = { source, sourceSha256: SOURCE_SHA, comparison: 'uncontrolled-single-treated' }
const b = (number, timestamp, hash, parentHash) => ({ number, timestamp, hash, parentHash })
const blocks = new Map([
  [B, b(B, target - 20, B_HASH, H0)],
  [B + 1, b(B + 1, target - 10, H1, B_HASH)],
  [B + 2, b(B + 2, target, H2, H1)],
])
const rpcBlock = (value) => ({
  number: toHex(value.number),
  timestamp: toHex(value.timestamp),
  hash: value.hash,
  parentHash: value.parentHash,
})
function mockClient({ due = true, reorg = false } = {}) {
  let selectedReads = 0,
    withdraws = 0
  const request = async ({ method, params }) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? (due ? B + 2 : B + 1) : Number(BigInt(params[0]))
      if (n === B + 2 && reorg && ++selectedReads >= 3)
        return rpcBlock({ ...blocks.get(n), hash: `0x${'4'.repeat(64)}` })
      return rpcBlock(blocks.get(n))
    }
    if (method === 'eth_getCode') return params[0] === HOLDER ? '0x' : '0x6000'
    assert.equal(method, 'eth_call')
    assert.deepEqual(params[1], { blockHash: H2, requireCanonical: true })
    assert.equal(params[0].gas, toHex(30_000_000))
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: params[0].data })
    if (functionName === 'withdraw') {
      withdraws++
      assert.equal(params[0].from, HOLDER)
      assert.equal(args[0], Q)
      assert.equal(args[1].toLowerCase(), HOLDER)
      assert.equal(args[2].toLowerCase(), HOLDER)
    }
    const values = {
      asset: USDC,
      liquidityAdapter: ADAPTER,
      balanceOf: 200_000_000_000_000_000_000_000n,
      previewRedeem: 235_000_000_000n,
      withdraw: 100_000_000_000n,
    }
    return encodeFunctionResult({ abi: ABI, functionName, result: values[functionName] })
  }
  return { request, getWithdraws: () => withdraws }
}

test('fixed targets, holder, q and source SHA stay explicit', () => {
  assert.equal(Q, 100_000_000_000n)
  assert.equal(HOLDER, '0xcf46bbab1f7bdd392be98ec08e653cb8bb6cc94a')
  assert.equal(SOURCE_SHA.length, 64)
  assert.equal(target, 1_790_606_711)
})

test('before due refuses any outcome call or file', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-outcome-'))
  try {
    const client = mockClient({ due: false })
    const result = await collect({ client, frozen, out, stat: () => ({ bavail: 2, bsize: 1e9 }) })
    assert.equal(result.collected, 0)
    assert.equal(client.getWithdraws(), 0)
    assert.deepEqual(readdirSync(out), [])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('target selector chooses earliest finalized timestamp crossing', async () => {
  const found = await selectTarget({
    targetTime: target,
    finalized: blocks.get(B + 2),
    getBlock: async (n) => blocks.get(n),
  })
  assert.equal(found.selected.number, B + 2)
  assert.equal(found.previous.timestamp, target - 10)
  await assert.rejects(
    selectTarget({
      targetTime: target,
      finalized: blocks.get(B + 1),
      getBlock: async (n) => blocks.get(n),
    }),
    /not due/,
  )
})

test('same-holder same-q pinned withdrawal seals once and refuses changed outcome', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-outcome-'))
  try {
    const client = mockClient()
    const args = {
      client,
      frozen,
      out,
      stat: () => ({ bavail: 2, bsize: 1e9 }),
      now: () => '2026-09-28T15:00:00.000Z',
    }
    const first = await collect(args)
    assert.equal(first.collected, 1)
    assert.equal(first.results[0].status, 'success')
    assert.equal(client.getWithdraws(), 1)
    const again = await collect(args)
    assert.equal(again.collected, 0)
    assert.equal(client.getWithdraws(), 1)
    assert.equal(verify({ frozen, out }).results[0].physicalSha256, first.results[0].physicalSha256)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('reorged target fails before appending', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-outcome-'))
  try {
    await assert.rejects(
      collect({
        client: mockClient({ reorg: true }),
        frozen,
        out,
        stat: () => ({ bavail: 2, bsize: 1e9 }),
      }),
      /Canonical/,
    )
    assert.deepEqual(readdirSync(out), [])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('adapter drift and low claim censor without attempting withdrawal', async () => {
  const client = mockClient()
  const result = await probe({
    frozen: {
      ...frozen,
      source: { ...source, result: { ...source.result, liquidityAdapter: TREATED } },
    },
    targetBlock: blocks.get(B + 2),
    request: (method, params) => client.request({ method, params }),
  })
  assert.equal(result.status, 'adapter-identity-drift')
  assert.equal(client.getWithdraws(), 0)
})

test('malformed code responses are provider ambiguity, not missing vault or changed holder', async () => {
  const targetBlock = blocks.get(B + 2)
  const vaultResult = await probe({ frozen, targetBlock, request: async () => null })
  assert.equal(vaultResult.status, 'historical-state-rpc-ambiguous')
  const missing = await probe({ frozen, targetBlock, request: async () => '0x' })
  assert.equal(missing.status, 'vault-code-missing')
  const client = mockClient()
  const holderResult = await probe({
    frozen,
    targetBlock,
    request: (method, params) =>
      method === 'eth_getCode' && params[0] === HOLDER ? null : client.request({ method, params }),
  })
  assert.equal(holderResult.status, 'historical-state-rpc-ambiguous')
  assert.equal(client.getWithdraws(), 0)
})

test('re-sealed revert, low-claim, and bad timestamp artifacts fail offline verification', async () => {
  const out = mkdtempSync(join(tmpdir(), 'morpho-outcome-'))
  const path = join(out, '6h-outcome.json')
  const reseal = (artifact) => {
    const { payloadSha256, ...unsigned } = artifact
    const next = {
      ...unsigned,
      payloadSha256: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
    }
    writeFileSync(path, JSON.stringify(next))
  }
  try {
    await collect({ client: mockClient(), frozen, out, stat: () => ({ bavail: 2, bsize: 1e9 }) })
    const original = JSON.parse(readFileSync(path))
    reseal({
      ...original,
      result: {
        ...original.result,
        status: 'withdraw-revert',
        asset: undefined,
        withdrawShares: undefined,
      },
    })
    assert.throws(() => verify({ frozen, out }), /status evidence/)
    reseal({
      ...original,
      result: { ...original.result, status: 'holder-claim-below-q', withdrawShares: undefined },
    })
    assert.throws(() => verify({ frozen, out }), /status evidence/)
    reseal({ ...original, targetBlock: { ...original.targetBlock, timestamp: 'bad' } })
    assert.throws(() => verify({ frozen, out }), /block selection/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
