import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeFunctionResult, parseAbi } from 'viem'
import { FACTORY_SHA, SUBMIT_SHA } from './morpho-v2-cap-lifecycle-census.mjs'
import {
  LIFECYCLE_SHA,
  STAGE1_SHA,
  collect,
  readInputs,
  seal,
  selectChecks,
  verify,
} from './morpho-v2-lifecycle-getter-check.mjs'

const root = 'data/research/venue-signals'
const paths = {
  factoryPath: `${root}/${FACTORY_SHA}.json`,
  submitPath: `${root}/${SUBMIT_SHA}.json`,
  stage1Path: `${root}/${STAGE1_SHA}.json`,
  lifecyclePath: `${root}/morpho-v2-cap-lifecycle-census.json`,
}
const ABI = parseAbi(['function executableAt(bytes data) view returns (uint256)'])
const spaciousDisk = () => ({ bavail: 10_000_000, bsize: 1024 })
const makeTemp = () => mkdtempSync(join(tmpdir(), 'morpho-getter-check-'))

test('frozen inputs and sample cover pending, settled, both closures, and a reused key', () => {
  const inputs = readInputs(paths)
  const rows = selectChecks(inputs)
  assert.equal(rows.length, 13)
  assert.deepEqual(
    rows.slice(0, 3).map((x) => x.label),
    ['before-submit', 'after-submit', 'after-revoke'],
  )
  assert.equal(rows.filter((x) => x.label === 'before-submit').length, 4)
  assert.equal(rows.filter((x) => x.label === 'after-submit').length, 4)
  assert.ok(rows.some((x) => x.label === 'after-accept'))
  assert.ok(rows.some((x) => x.label === 'after-revoke'))
  assert.ok(rows.some((x) => x.label === 'after-submit' && x.replayCycles > 1))
  assert.equal(rows.at(-1).label, 'pending-at-head')
  assert.equal(rows.at(-1).expectedPending, true)
  assert.ok(rows.every((x) => x.selector === x.data.slice(0, 10)))
})

test('historical reads use block-hash EIP-1898; verified artifact contains no calldata', async () => {
  const dir = makeTemp(),
    out = join(dir, 'check.json')
  try {
    const inputs = readInputs(paths),
      expected = selectChecks(inputs)
    const headerHashes = new Map(
      expected.map((x) => [
        x.asOfBlock,
        x.expectedHash || `0x${x.asOfBlock.toString(16).padStart(64, '0')}`,
      ]),
    )
    let callIndex = 0
    const client = {
      getChainId: async () => 1,
      getBlock: async ({ blockNumber }) => ({ hash: headerHashes.get(Number(blockNumber)) }),
    }
    const saved = await collect({
      client,
      inputs,
      out,
      stat: spaciousDisk,
      rpcRead: async (method, params) => {
        assert.equal(method, 'eth_call')
        const row = expected[callIndex++]
        assert.equal(params[0].to, row.vault)
        assert.equal(params[1].blockHash, headerHashes.get(row.asOfBlock))
        assert.equal(params[1].requireCanonical, true)
        return encodeFunctionResult({
          abi: ABI,
          functionName: 'executableAt',
          result: row.expectedPending ? 123n : 0n,
        })
      },
    })
    assert.equal(callIndex, 13)
    assert.equal(saved.checks.length, 13)
    assert.ok(saved.checks.every((x) => !('data' in x)))
    assert.equal(saved.lifecycleSha256, LIFECYCLE_SHA)
    assert.deepEqual(verify(JSON.parse(readFileSync(out, 'utf8')), inputs), saved)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a replay/getter mismatch fails closed without an artifact', async () => {
  const dir = makeTemp(),
    out = join(dir, 'check.json')
  try {
    const inputs = readInputs(paths),
      expected = selectChecks(inputs)
    const client = {
      getChainId: async () => 1,
      getBlock: async ({ blockNumber }) => ({
        hash:
          expected.find((x) => x.asOfBlock === Number(blockNumber))?.expectedHash ||
          `0x${Number(blockNumber).toString(16).padStart(64, '0')}`,
      }),
    }
    await assert.rejects(
      collect({
        client,
        inputs,
        out,
        stat: spaciousDisk,
        rpcRead: async () =>
          encodeFunctionResult({ abi: ABI, functionName: 'executableAt', result: 1n }),
      }),
      /does not reconcile/,
    )
    assert.throws(() => readFileSync(out), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tampered proof, unsupported getter, and low disk cannot be accepted', async () => {
  const inputs = readInputs(paths),
    expected = selectChecks(inputs)
  const fake = seal({
    study: 'morpho-v2-lifecycle-getter-check-v1',
    status: 'complete',
    chainId: 1,
    factorySha256: FACTORY_SHA,
    submitSha256: SUBMIT_SHA,
    stage1Sha256: STAGE1_SHA,
    lifecycleSha256: LIFECYCLE_SHA,
    pinnedHeadHash: expected.at(-1).expectedHash,
    checks: expected.map(({ data: _data, ...row }) => ({
      ...row,
      blockHash: row.expectedHash || `0x${row.asOfBlock.toString(16).padStart(64, '0')}`,
      executableAt: row.expectedPending ? '1' : '0',
      actualPending: row.expectedPending,
    })),
  })
  assert.equal(verify(fake, inputs).checks.length, 13)
  const withRawData = seal({
    ...fake,
    checks: fake.checks.map((row, index) =>
      index === 0 ? { ...row, data: expected[0].data } : row,
    ),
  })
  assert.throws(() => verify(withRawData, inputs), /does not reconcile/)
  fake.checks[0].actualPending = true
  assert.throws(() => verify(fake, inputs), /integrity mismatch/)

  const dir = makeTemp(),
    out = join(dir, 'check.json')
  try {
    const client = {
      getChainId: async () => 1,
      getBlock: async () => ({ hash: expected[0].expectedHash }),
    }
    await assert.rejects(
      collect({ client, inputs, out, stat: () => ({ bavail: 1, bsize: 1 }) }),
      /disk reserve/,
    )
    await assert.rejects(
      collect({
        client: {
          ...client,
          getBlock: async ({ blockNumber }) => ({
            hash:
              expected.find((x) => x.asOfBlock === Number(blockNumber))?.expectedHash ||
              `0x${Number(blockNumber).toString(16).padStart(64, '0')}`,
          }),
        },
        inputs,
        out,
        stat: spaciousDisk,
        rpcRead: async () => '0x',
      }),
      /unsupported/,
    )
    assert.throws(() => readFileSync(out), /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
