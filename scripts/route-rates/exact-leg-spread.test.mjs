import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GHO_SGHO,
  LOOKBACK_SECONDS,
  aaveNominalAprToEffectiveApy,
  annualizeShareGrowth,
  collectExactLegSpread,
  exactLegKey,
  findArchiveBlockAtOrBefore,
} from './exact-leg-spread.mjs'
import { runSnapshot } from './run-hourly.mjs'

const block = 26_100_000n
const prior = 26_050_000n
const archivePrior = block - 50_400n
const at = 1_800_000_000
const blockHash = `0x${'a'.repeat(64)}`
const word = (value) => BigInt(value).toString(16).padStart(64, '0')
const ghoAssetWord = `0x${GHO_SGHO.borrowAsset.slice(2).padStart(64, '0')}`

function mockRpc(options = {}) {
  const calls = []
  const client = {
    async request({ method, params }) {
      calls.push({ method, params })
      if (options.throwRpc) throw new Error('RPC failed at https://private.example/token=secret')
      if (method === 'eth_chainId') return options.chainId || '0x1'
      if (method === 'eth_getBlockByNumber') {
        if (params[0] === 'finalized') {
          if (options.unsupportedFinalized) throw new Error('unsupported finalized tag')
          return {
            number: `0x${block.toString(16)}`,
            timestamp: `0x${at.toString(16)}`,
            hash: blockHash,
          }
        }
        const number = BigInt(params[0])
        if (options.syntheticArchive && !options.missingPrior && number <= block)
          return {
            number: params[0],
            timestamp: `0x${(at - Number(block - number) * 12).toString(16)}`,
          }
        if (number === block) return { number: params[0], timestamp: `0x${at.toString(16)}` }
        if (number === prior && !options.missingPrior)
          return { number: params[0], timestamp: `0x${(at - LOOKBACK_SECONDS).toString(16)}` }
        return null
      }
      if (method === 'eth_call') {
        const [{ to, data }, tag] = params
        if (data === '0x38d52e0f') return options.vaultAsset || ghoAssetWord
        if (data.startsWith('0x35ea6a75'))
          return `0x${[0n, 0n, 0n, 0n, 4n * 10n ** 25n].map(word).join('')}`
        if (data.startsWith('0x07a2d13a') && to.toLowerCase() === GHO_SGHO.destination) {
          const priorTag = options.syntheticArchive ? archivePrior : prior
          if (options.missingShare && tag === `0x${priorTag.toString(16)}`) return '0x'
          return tag === `0x${priorTag.toString(16)}`
            ? `0x${word(10n ** 18n)}`
            : `0x${word(options.extremeShare ? 10n ** 40n : 1001n * 10n ** 15n)}`
        }
      }
      throw new Error(`Unexpected ${method}`)
    },
  }
  return { client, calls }
}

test('key is contract-level and rejects a different destination or protocol', () => {
  assert.match(exactLegKey(GHO_SGHO), /0xe1753f2e00940cc31213dd92013cf019dfe4ca1d$/)
  assert.throws(
    () => exactLegKey({ ...GHO_SGHO, destination: '0x0000000000000000000000000000000000000001' }),
    /Unsupported exact leg/,
  )
  assert.throws(
    () => exactLegKey({ ...GHO_SGHO, borrowProtocol: 'Spark' }),
    /Unsupported exact leg/,
  )
})

test('normalizes Aave nominal APR to effective APY and 7-day share growth', () => {
  assert.ok(Math.abs(aaveNominalAprToEffectiveApy(4n * 10n ** 25n) - Math.expm1(0.04)) < 1e-7)
  assert.ok(
    Math.abs(
      annualizeShareGrowth(1001n * 10n ** 15n, 10n ** 18n, LOOKBACK_SECONDS) -
        (1.001 ** (365 / 7) - 1),
    ) < 1e-8,
  )
})

test('reads both legs at the same finalized block and the vault lookback at exact archive block', async () => {
  const { client, calls } = mockRpc()
  const out = await collectExactLegSpread({ rpc: client, priorBlockNumber: prior })
  assert.equal(out.status, 'priced')
  assert.equal(out.asOf, at)
  assert.equal(out.blockNumber, block.toString())
  assert.equal(out.blockHash, blockHash)
  assert.equal(out.lookback.seconds, LOOKBACK_SECONDS)
  assert.equal(out.lookback.priorBlockNumber, prior.toString())
  assert.ok(out.borrowApy > 0.04)
  assert.ok(out.yieldApy > 0)
  assert.equal(out.spread, out.yieldApy - out.borrowApy)
  const callsOnCurrent = calls.filter(({ method }) => method === 'eth_call').slice(0, 3)
  assert.ok(callsOnCurrent.every(({ params }) => params[1] === `0x${block.toString(16)}`))
  assert.ok(
    calls.some(
      ({ method, params }) => method === 'eth_call' && params[1] === `0x${prior.toString(16)}`,
    ),
  )
  assert.ok(
    calls.some(
      ({ method, params }) => method === 'eth_getBlockByNumber' && params[0] === 'finalized',
    ),
  )
})

test('missing archive history, missing price, wrong asset and wrong chain all fail closed', async () => {
  for (const options of [
    { missingPrior: true },
    { missingShare: true },
    { vaultAsset: `0x${word(1n)}` },
    { chainId: '0xa' },
  ]) {
    const { client } = mockRpc(options)
    const out = await collectExactLegSpread({ rpc: client, priorBlockNumber: prior })
    assert.equal(out.status, 'unavailable')
    assert.equal(out.borrowApy, null)
    assert.equal(out.yieldApy, null)
    assert.equal(out.spread, null)
    assert.ok(out.error)
  }
})

test('RPCs without finalized-tag support fail closed before rate calls', async () => {
  const { client, calls } = mockRpc({ unsupportedFinalized: true })
  const out = await collectExactLegSpread({ rpc: client, priorBlockNumber: prior })
  assert.equal(out.status, 'unavailable')
  assert.equal(out.blockHash, null)
  assert.equal(out.spread, null)
  assert.equal(calls.filter(({ method }) => method === 'eth_call').length, 0)
})

test('extreme but parseable share jump cannot serialize Infinity as a priced null', async () => {
  const { client } = mockRpc({ extremeShare: true })
  const out = await collectExactLegSpread({ rpc: client, priorBlockNumber: prior })
  assert.equal(out.status, 'unavailable')
  assert.equal(out.spread, null)
  assert.equal(out.yieldApy, null)
  assert.match(out.error, /Invalid annualized share growth/)
})

test('archive resolver finds closest block at or before seven-day target', async () => {
  const { client, calls } = mockRpc({ syntheticArchive: true })
  const resolved = await findArchiveBlockAtOrBefore({
    rpc: client,
    finalizedBlockNumber: block,
    targetTimestamp: at - LOOKBACK_SECONDS,
  })
  assert.equal(resolved.number, archivePrior)
  assert.equal(resolved.timestamp, at - LOOKBACK_SECONDS)
  assert.ok(calls.filter(({ method }) => method === 'eth_getBlockByNumber').length < 30)

  const out = await collectExactLegSpread({ rpc: client })
  assert.equal(out.status, 'priced')
  assert.equal(out.lookback.priorBlockNumber, archivePrior.toString())
})

test('archive gaps never fall back to first destination or arbitrary block offsets', async () => {
  const { client, calls } = mockRpc()
  const out = await collectExactLegSpread({ rpc: client })
  assert.equal(out.status, 'unavailable')
  assert.match(out.error, /Archive block unavailable/)
  assert.equal(calls.filter(({ method }) => method === 'eth_call').length, 0)
})

test('runner atomically replaces an old snapshot with a new finalized read and explicit freshness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exact-route-rates-'))
  const outputPath = join(dir, 'nested', 'latest.json')
  try {
    const { client } = mockRpc({ syntheticArchive: true })
    const first = await runSnapshot({ client, outputPath, now: () => 1_800_000_100_000 })
    assert.equal(first.freshness.state, 'fresh')
    assert.equal(first.freshness.asOf, at)
    assert.equal(first.cadenceSeconds, 86_400)
    assert.equal(first.freshness.expiresAt, 1_800_086_500)
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), first)

    const broken = mockRpc({ missingPrior: true })
    const second = await runSnapshot({
      client: broken.client,
      outputPath,
      now: () => 1_800_003_700_000,
    })
    assert.equal(second.freshness.state, 'unavailable')
    assert.equal(second.measurement.spread, null)
    assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).measurement.status, 'unavailable')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stale finalized heads and credential-bearing RPC errors are unavailable without leaking secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exact-route-rates-'))
  const outputPath = join(dir, 'latest.json')
  try {
    const stale = await runSnapshot({
      client: mockRpc({ syntheticArchive: true }).client,
      outputPath,
      now: () => (at + 7201) * 1000,
    })
    assert.equal(stale.freshness.state, 'unavailable')
    assert.equal(stale.measurement.spread, null)

    const failed = await runSnapshot({
      client: mockRpc({ throwRpc: true }).client,
      outputPath,
      now: () => (at + 100) * 1000,
    })
    assert.equal(failed.measurement.status, 'unavailable')
    assert.doesNotMatch(await readFile(outputPath, 'utf8'), /private\.example|secret/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
