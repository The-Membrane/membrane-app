import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { encodeFunctionResult } from 'viem'
import { ABI } from './aave-core-forward-panel.mjs'
import {
  SHOCK_RAW,
  collect,
  frozenSources,
  outputPath,
  plan,
  verifySnapshot,
} from './aave-core-holder-shock-followup.mjs'

const destination = 'data/research/venue-signals/aave-core-shock-followup-test.json'
const hash = (n) => `0x${n.toString(16).padStart(64, '0')}`
const anchorTimestamp = 1790399447
const anchorBlock = 26059451
const balanceResult = (value) =>
  encodeFunctionResult({ abi: ABI.token, functionName: 'balanceOf', result: value })

function fixture({
  finalized = true,
  returnRaw = SHOCK_RAW,
  changedHeader = false,
  claimRaw = 75_000_000n * 10n ** 6n,
  revert = false,
  gasUnavailable = false,
} = {}) {
  const target = anchorTimestamp + 6 * 3600
  const source = frozenSources()
  const requestCalls = []
  let headerReads = 0
  const client = {
    getChainId: async () => 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      headerReads++
      if (blockTag === 'finalized')
        return {
          number: BigInt(anchorBlock + 1),
          hash: hash(2),
          timestamp: BigInt(finalized ? target : target - 1),
          gasLimit: 30_000_000n,
        }
      const number = Number(blockNumber)
      if (number === anchorBlock)
        return {
          number: BigInt(number),
          hash: source.blockHash,
          timestamp: BigInt(anchorTimestamp),
        }
      if (number === anchorBlock + 1)
        return {
          number: BigInt(number),
          hash: changedHeader && headerReads > 3 ? hash(3) : hash(2),
          timestamp: BigInt(finalized ? target : target - 1),
          gasLimit: 30_000_000n,
        }
      throw new Error('unexpected block')
    },
    request: async ({ method, params }) => {
      requestCalls.push({ method, params })
      assert.equal(params.at(-1)?.blockHash, hash(2))
      if (method === 'eth_getCode') return '0x6000'
      if (method === 'eth_getStorageAt') return `0x${'0'.repeat(24)}${'1'.padStart(40, '0')}`
      if (method === 'eth_estimateGas') {
        if (gasUnavailable) throw new Error('estimate unavailable')
        return '0x186a0'
      }
      if (method === 'eth_call') {
        const data = params[0].data
        if (data.startsWith('0x69328dec')) {
          if (revert)
            throw Object.assign(new Error('private provider text'), { code: 3, data: '0x08c379a0' })
          return hash(returnRaw)
        }
        if (data.startsWith('0x70a08231')) return balanceResult(claimRaw)
        throw Object.assign(new Error('unavailable reserve'), { code: -32000 })
      }
      throw new Error('unexpected method')
    },
  }
  return { client, requestCalls, source }
}

test('frozen sources physically link ten original independent success holders', () => {
  const saved = frozenSources()
  assert.equal(saved.markets.map((market) => market.holders.length).join(','), '4,6')
  assert.equal(saved.markets[0].holders[0].baselineClaimRaw, '193612913108929')
  assert.match(saved.shockPhysicalSha256, /^[a-f0-9]{64}$/)
  assert.throws(
    () =>
      frozenSources({ exposure: saved, shockSaved: { payload: { study: 'other' }, sha256: 'x' } }),
    /linkage/,
  )
})

test('dry plan does not need a provider, and output stays in research directory', () => {
  assert.equal(plan().status, 'dry-only')
  assert.equal(plan().diskFloorBytes, 1024 ** 3)
  assert.throws(() => outputPath('/tmp/out.json'), /Unique JSON/)
  assert.throws(() => plan({ horizon: '1h' }), /Unknown horizon/)
})

test('first finalized block replays every frozen holder with same $50m and hash pin', async () => {
  const { client, requestCalls } = fixture()
  const result = await collect({
    client,
    horizon: '6h',
    out: destination,
    checkDisk: () => {},
    now: () => (anchorTimestamp + 6 * 3600 + 100) * 1000,
  })
  assert.equal(
    result.payload.markets.reduce((sum, market) => sum + market.holders.length, 0),
    10,
  )
  assert.equal(result.payload.markets[0].holders[0].call, 'success')
  assert.equal(result.payload.markets[0].holders[0].gasEstimate, '100000')
  assert.equal(result.payload.markets[0].holders[0].deterioration, 'censored') // simulated code/identity differ
  assert.equal(result.payload.blockHash, hash(2))
  assert.equal(result.payload.localFirstKnownAtMs, 1790401669721)
  assert.doesNotThrow(() => verifySnapshot(result))
  assert.equal(
    requestCalls.filter(
      ({ method, params }) => method === 'eth_call' && params[0].data.startsWith('0x69328dec'),
    ).length,
    10,
  )
})

test('offline verifier rejects re-sealed holder and target-time substitution', async () => {
  const { client } = fixture()
  const saved = await collect({
    client,
    horizon: '6h',
    out: destination,
    checkDisk: () => {},
    now: () => (anchorTimestamp + 6 * 3600 + 100) * 1000,
  })
  const reseal = (payload) => ({
    payload,
    sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  })
  const changedHolder = structuredClone(saved.payload)
  changedHolder.markets[0].holders[0].address = `0x${'9'.repeat(40)}`
  assert.throws(() => verifySnapshot(reseal(changedHolder)), /holder frontier/)
  const changedTarget = structuredClone(saved.payload)
  changedTarget.targetTimestamp++
  assert.throws(() => verifySnapshot(reseal(changedTarget)), /identity mismatch/)
  const censoredAsSuccess = structuredClone(saved.payload)
  const row = censoredAsSuccess.markets[0].holders[0]
  row.censoring = []
  row.deterioration = 'no-observed-revert'
  assert.throws(() => verifySnapshot(reseal(censoredAsSuccess)), /holder frontier/)
  const changedReserve = structuredClone(saved.payload)
  changedReserve.markets[0].reserve.decimals = 18
  assert.throws(() => verifySnapshot(reseal(changedReserve)), /holder frontier/)
})

test('does not read follow-up state before first target block is finalized', async () => {
  const { client, requestCalls } = fixture({ finalized: false })
  await assert.rejects(
    collect({ client, horizon: '6h', out: destination, checkDisk: () => {} }),
    /not finalized/,
  )
  assert.equal(requestCalls.length, 0)
})

test('revert with depleted claim remains explicitly censored, not a clean venue failure', async () => {
  const { client } = fixture({ claimRaw: 49_000_000n * 10n ** 6n, revert: true })
  const result = await collect({
    client,
    horizon: '6h',
    out: destination,
    checkDisk: () => {},
    now: () => (anchorTimestamp + 6 * 3600 + 100) * 1000,
  })
  const holder = result.payload.markets[0].holders[0]
  assert.equal(holder.call, 'revert')
  assert.equal(holder.claimBelowShock, true)
  assert.ok(holder.censoring.includes('holder-claim-attrition'))
  assert.equal(holder.deterioration, 'censored')
  assert.equal(holder.revertSelector, '0x08c379a0')
})

test('gas estimate unavailable cannot support transaction-executable classification', async () => {
  const { client } = fixture({ gasUnavailable: true })
  const result = await collect({
    client,
    horizon: '6h',
    out: destination,
    checkDisk: () => {},
    now: () => (anchorTimestamp + 6 * 3600 + 100) * 1000,
  })
  const holder = result.payload.markets[0].holders[0]
  assert.equal(holder.call, 'success')
  assert.equal(holder.gasStatus, 'unavailable')
  assert.ok(holder.censoring.includes('gas-estimate-unavailable'))
  assert.equal(holder.deterioration, 'censored')
})

test('failed gas estimate does not itself censor an observed revert', async () => {
  const { client } = fixture({ revert: true, gasUnavailable: true })
  const result = await collect({
    client,
    horizon: '6h',
    out: destination,
    checkDisk: () => {},
    now: () => (anchorTimestamp + 6 * 3600 + 100) * 1000,
  })
  const holder = result.payload.markets[0].holders[0]
  assert.equal(holder.call, 'revert')
  assert.equal(holder.gasStatus, 'unavailable')
  assert.ok(!holder.censoring.includes('gas-estimate-unavailable'))
  assert.doesNotThrow(() => verifySnapshot(result))
})

test('source/header errors and disk guard are fatal, not censored', async () => {
  const { client, source } = fixture()
  await assert.rejects(
    collect({
      client,
      horizon: '6h',
      out: destination,
      checkDisk: () => {
        throw new Error('disk floor')
      },
    }),
    /Disk reserve reached/,
  )
  await assert.rejects(
    collect({
      client,
      horizon: '6h',
      out: destination,
      checkDisk: () => {},
      sources: () => ({ ...source, firstKnownAtMs: (anchorTimestamp + 6 * 3600) * 1000 }),
    }),
    /not prospective/,
  )
  const bad = {
    ...client,
    getBlock: async () => ({
      number: BigInt(anchorBlock),
      hash: hash(9),
      timestamp: BigInt(anchorTimestamp),
    }),
  }
  await assert.rejects(
    collect({ client: bad, horizon: '6h', out: destination, checkDisk: () => {} }),
    /header mismatch/,
  )
  let diskChecks = 0
  await assert.rejects(
    collect({
      client,
      horizon: '6h',
      out: destination,
      checkDisk: () => {
        if (++diskChecks === 9) throw new Error('transient disk floor')
      },
    }),
    /Disk reserve reached/,
  )
})
