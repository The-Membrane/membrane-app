import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { keccak256 } from 'viem'
import { MARKETS, POOL } from './aave-core-forward-panel.mjs'
import { readCheckpoint as readBaseline } from './aave-core-holder-witness.mjs'
import {
  HORIZONS,
  collectOutcome,
  firstFinalizedBlock,
  plan,
  readCheckpoint,
  run,
} from './aave-core-holder-outcomes.mjs'

const H = (n) => `0x${n.toString(16).padStart(64, '0')}`
const A = (n) => `0x${n.toString(16).padStart(40, '0')}`
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const BASE_BLOCK = 1000
const BASE_TIME = 1_700_000_000
const QUOTE = 1_000_000n * 10n ** 6n

function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aave-holder-outcomes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { baselinePath: join(dir, 'baseline.json'), out: join(dir, 'outcome.json') }
}

function baselineFixture(path, holders = [[A(1)], [A(2)]], poolImplementation = undefined) {
  const payload = readBaseline(path)
  const row = {
    block: BASE_BLOCK,
    blockHash: H(BASE_BLOCK),
    blockTimestamp: BASE_TIME,
    observedAtMs: (BASE_TIME + 100) * 1000,
    poolCodeHash: keccak256('0x6000'),
    ...(poolImplementation ? { poolImplementation } : {}),
    markets: MARKETS.map((market, index) => ({
      name: market.name,
      underlying: market.base.toLowerCase(),
      underlyingCodeHash: keccak256('0x6000'),
      aToken: market.aToken.toLowerCase(),
      aTokenCodeHash: keccak256('0x6000'),
      decimals: 6,
      quoteRaw: QUOTE.toString(),
      candidates: holders[index].map((address) => ({
        address,
        aTokenBalanceRaw: QUOTE.toString(),
        codeStatus: 'eoa',
        withdraw: 'success',
      })),
      qualifyingHolders: holders[index],
    })),
    previousSha256: null,
  }
  payload.baselines.push({ ...row, rowSha256: sha(row) })
  writeFileSync(path, JSON.stringify({ payload, sha256: sha(payload) }))
  return payload.baselines[0]
}

function fixture({
  head = 2800,
  revert = false,
  attrition = false,
  paused = false,
  codeChanged = false,
  reserveATokenChanged = false,
  decimalsChanged = false,
  reserveRpcError = false,
  cashRpcError = false,
  codeRpcError = false,
  noFinalized = false,
  reorg = false,
  rpcError = false,
  implementationChanged = false,
  implementationUnavailable = false,
  aTokenImplementationChanged = false,
  aTokenBaselineUnavailable = false,
  healthRpcError = false,
  nestedRevertData = false,
} = {}) {
  const calls = []
  let outcomeHeaderReads = 0
  const target = BASE_TIME + HORIZONS['6h']
  const timestamp = (block) => BASE_TIME + (block - BASE_BLOCK) * 12
  const client = {
    async getChainId() {
      calls.push('chain')
      return 1
    },
    async getBlockNumber() {
      calls.push('head')
      return BigInt(head + 64)
    },
    async getBlock({ blockNumber, blockTag }) {
      if (blockTag === 'finalized' && noFinalized) throw new Error('unsupported block tag')
      const block = blockTag === 'finalized' ? head : Number(blockNumber)
      calls.push(`block:${block}`)
      if (block === 2800) outcomeHeaderReads++
      return {
        number: BigInt(block),
        hash: H(reorg && block === 2800 && outcomeHeaderReads > 2 ? 999 : block),
        timestamp: BigInt(timestamp(block)),
      }
    },
    async getCode({ address, blockNumber }) {
      calls.push(`code:${blockNumber}`)
      assert.equal(blockNumber, 2800n)
      if (codeRpcError && address.toLowerCase() === POOL.toLowerCase())
        throw new Error('code RPC down')
      if (
        ![POOL, ...MARKETS.flatMap((m) => [m.base, m.aToken])].some(
          (x) => x.toLowerCase() === address.toLowerCase(),
        )
      )
        return undefined
      return codeChanged ? '0x6001' : '0x6000'
    },
    async request({ method, params }) {
      calls.push(`request:${method}`)
      const pinnedHash = params.at(-1).blockHash
      assert.deepEqual(params.at(-1), { blockHash: pinnedHash, requireCanonical: true })
      assert.ok([H(BASE_BLOCK), H(2800)].includes(pinnedHash))
      const isAToken = MARKETS.some(
        (market) => market.aToken.toLowerCase() === params[0].toLowerCase(),
      )
      if (
        implementationUnavailable ||
        (aTokenBaselineUnavailable && isAToken && pinnedHash === H(BASE_BLOCK))
      )
        throw new Error('https://private-rpc.example/?key=secret')
      const changed =
        pinnedHash === H(2800) &&
        (implementationChanged || (isAToken && aTokenImplementationChanged))
      if (method === 'eth_getStorageAt')
        return `0x${'0'.repeat(24)}${A(changed ? 77 : 76).slice(2)}`
      if (method === 'eth_getCode') return changed ? '0x6001' : '0x6000'
      throw new Error('Unexpected request')
    },
    async readContract({ address, functionName, args, blockNumber }) {
      calls.push(`${functionName}:${blockNumber}`)
      assert.equal(blockNumber, 2800n)
      if (functionName === 'getReserveData') {
        if (reserveRpcError) throw new Error('reserve RPC down')
        const market = MARKETS.find((m) => m.base.toLowerCase() === args[0].toLowerCase())
        return {
          aTokenAddress: reserveATokenChanged ? A(99) : market.aToken,
          id: MARKETS.findIndex((m) => m.base.toLowerCase() === args[0].toLowerCase()),
          configuration: {
            data:
              (BigInt(decimalsChanged ? 18 : 6) << 48n) | (1n << 56n) | (paused ? 1n << 60n : 0n),
          },
        }
      }
      if (functionName === 'balanceOf') {
        if (MARKETS.some((m) => m.base.toLowerCase() === address.toLowerCase())) {
          if (cashRpcError) throw new Error('cash RPC down')
          return QUOTE * 5n
        }
        if (rpcError) throw new Error('network down')
        return attrition ? QUOTE - 1n : QUOTE * 2n
      }
      if (functionName === 'getUserConfiguration') {
        if (healthRpcError) throw new Error('https://private-rpc.example/?key=secret')
        return { data: 2n }
      }
      if (functionName === 'getUserAccountData') {
        if (healthRpcError) throw new Error('https://private-rpc.example/?key=secret')
        return [QUOTE * 3n, 0n, QUOTE, 8000n, 7500n, 2n * 10n ** 18n]
      }
      throw new Error('Unexpected read')
    },
    async call({ account, to, data, blockNumber }) {
      calls.push(`call:${blockNumber}`)
      assert.equal(blockNumber, 2800n)
      assert.equal(to, POOL)
      assert.ok([A(1), A(2)].includes(account))
      assert.ok(data.startsWith('0x69328dec'))
      if (revert) {
        const error = new Error('execution reverted')
        error.name = 'ExecutionRevertedError'
        if (nestedRevertData) error.cause = { data: '0x08c379a0deadbeef' }
        throw error
      }
      return { data: H(QUOTE) }
    },
  }
  assert.equal(timestamp(head) >= target, head >= 2800)
  return { client, calls }
}

test('dry plan reads only sealed local baseline and performs no RPC or write', (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const summary = plan(paths)
  assert.equal(summary.status, 'dry-only')
  assert.equal(summary.baselines[0].horizonTargets['6h'], BASE_TIME + 21600)
  assert.equal(existsSync(paths.out), false)
})

test('earliest finalized block is pinned at first timestamp at or above horizon', async () => {
  const { client, calls } = fixture()
  const rpc = (method, args = {}) => client[method](args)
  const result = await firstFinalizedBlock({
    client,
    targetTimestamp: BASE_TIME + HORIZONS['6h'],
    anchorBlock: BASE_BLOCK,
    rpc,
  })
  assert.equal(result.block, 2800)
  assert.equal(result.timestamp, BASE_TIME + HORIZONS['6h'])
  assert.ok(calls.includes('block:2799'))
})

test('not-yet-finalized horizon makes no outcome RPC or checkpoint write', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client, calls } = fixture({ head: 2799 })
  await assert.rejects(
    run({ ...paths, client, baselineBlock: BASE_BLOCK, horizon: '6h', checkDisk: () => {} }),
    /Horizon not finalized/,
  )
  assert.equal(
    calls.some((x) => x.startsWith('code:') || x.startsWith('call:')),
    false,
  )
  assert.equal(existsSync(paths.out), false)
})

test('provider without consensus-finalized header fails closed', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client, calls } = fixture({ noFinalized: true })
  await assert.rejects(
    run({ ...paths, client, baselineBlock: BASE_BLOCK, horizon: '6h', checkDisk: () => {} }),
    /unsupported block tag/,
  )
  assert.equal(
    calls.some((x) => x.startsWith('code:') || x.startsWith('call:')),
    false,
  )
  assert.equal(existsSync(paths.out), false)
})

test('same frozen holders and q produce one sealed outcome with raw reserve and call evidence', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client, calls } = fixture()
  let diskChecks = 0
  const result = await run({
    ...paths,
    client,
    baselineBlock: BASE_BLOCK,
    horizon: '6h',
    checkDisk: () => diskChecks++,
    now: () => (BASE_TIME + 30000) * 1000,
  })
  assert.equal(result.block, 2800)
  assert.deepEqual(
    result.witnesses.map((w) => w.count),
    [1, 1],
  )
  assert.ok(diskChecks >= calls.length + 2)
  const outcome = readCheckpoint(paths.out, paths.baselinePath).outcomes[0]
  assert.equal(outcome.baselineSha256, readBaseline(paths.baselinePath).baselines[0].rowSha256)
  assert.equal(outcome.blockHash, H(2800))
  assert.equal(outcome.markets[0].cashRaw, (QUOTE * 5n).toString())
  assert.equal(outcome.markets[0].witnesses[0].call, 'success')
  assert.equal(outcome.markets[0].witnesses[0].deterioration, 'censored')
  assert.deepEqual(outcome.markets[0].witnesses[0].censoring, ['pool-implementation-unresolved'])
  await assert.rejects(
    run({ ...paths, client, baselineBlock: BASE_BLOCK, horizon: '6h', checkDisk: () => {} }),
    /already recorded/,
  )
})

test('a saved daily baseline identity automatically uncensors the matched outcome', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath, [[A(1)], [A(2)]], {
    status: 'observed',
    address: A(76),
    codeHash: keccak256('0x6000'),
  })
  await run({
    ...paths,
    client: fixture().client,
    baselineBlock: BASE_BLOCK,
    horizon: '6h',
    checkDisk: () => {},
    now: () => (BASE_TIME + 30000) * 1000,
  })
  const outcome = readCheckpoint(paths.out, paths.baselinePath).outcomes[0]
  assert.equal(outcome.poolImplementationChanged, false)
  assert.ok(
    outcome.markets.every((market) =>
      market.witnesses.every(
        (witness) => !witness.censoring.includes('pool-implementation-unresolved'),
      ),
    ),
  )
})

test('revert without B implementation identity is censored, not inferred as cash or health cause', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  const { client } = fixture({ revert: true })
  const outcome = await collectOutcome({
    client,
    baseline,
    horizon: '6h',
    checkDisk: () => {},
    now: () => (BASE_TIME + 30000) * 1000,
  })
  assert.equal(outcome.markets[0].witnesses[0].call, 'revert')
  assert.equal(outcome.markets[0].witnesses[0].deterioration, 'censored')
  assert.equal(outcome.markets[0].witnesses[0].cause, 'unknown-post-withdraw-health-unattested')
  assert.equal(outcome.markets[0].cashBelowQuote, false)
})

test('a prospectively captured daily B Pool identity resolves only the implementation censor', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  baseline.poolImplementation = {
    status: 'observed',
    address: A(76),
    codeHash: keccak256('0x6000'),
  }
  const same = await collectOutcome({
    client: fixture().client,
    baseline,
    horizon: '6h',
    checkDisk: () => {},
    now: () => (BASE_TIME + 30000) * 1000,
  })
  assert.equal(same.poolImplementationChanged, false)
  assert.ok(
    same.markets.every((market) =>
      market.witnesses.every(
        (witness) => !witness.censoring.includes('pool-implementation-unresolved'),
      ),
    ),
  )
  const changed = await collectOutcome({
    client: fixture({ implementationChanged: true }).client,
    baseline,
    horizon: '6h',
    checkDisk: () => {},
    now: () => (BASE_TIME + 30000) * 1000,
  })
  assert.equal(changed.poolImplementationChanged, true)
  assert.ok(
    changed.markets.every((market) =>
      market.witnesses.every((witness) =>
        witness.censoring.includes('pool-implementation-changed'),
      ),
    ),
  )
})

test('holder attrition, pause and code change censor a revert independently', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  const { client } = fixture({ revert: true, attrition: true, paused: true, codeChanged: true })
  const outcome = await collectOutcome({
    client,
    baseline,
    horizon: '6h',
    checkDisk: () => {},
    now: () => (BASE_TIME + 30000) * 1000,
  })
  const witness = outcome.markets[0].witnesses[0]
  assert.equal(witness.call, 'revert')
  assert.equal(witness.deterioration, 'censored')
  assert.deepEqual(witness.censoring, [
    'holder-attrition',
    'pool-implementation-unresolved',
    'reserve-inactive-or-paused',
    'runtime-code-changed',
  ])
})

test('missing balance stays unresolved instead of becoming a clean deterioration', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  const { client } = fixture({ revert: true, rpcError: true })
  const outcome = await collectOutcome({
    client,
    baseline,
    horizon: '6h',
    checkDisk: () => {},
    now: () => (BASE_TIME + 30000) * 1000,
  })
  const witness = outcome.markets[0].witnesses[0]
  assert.equal(witness.call, 'revert')
  assert.equal(witness.deterioration, 'censored')
  assert.deepEqual(witness.censoring, [
    'holder-balance-unavailable',
    'pool-implementation-unresolved',
  ])
})

test('reserve identity and decimal changes censor the fixed-quote comparison', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  const { client } = fixture({ revert: true, reserveATokenChanged: true, decimalsChanged: true })
  const outcome = await collectOutcome({
    client,
    baseline,
    horizon: '6h',
    checkDisk: () => {},
    now: () => (BASE_TIME + 30000) * 1000,
  })
  const row = outcome.markets[0]
  assert.equal(row.cashAt, A(99))
  assert.equal(row.reserveIdentityChanged, true)
  assert.equal(row.decimalsChanged, true)
  assert.deepEqual(row.witnesses[0].censoring, [
    'pool-implementation-unresolved',
    'reserve-aToken-changed',
    'reserve-decimals-changed',
  ])
})

test('reserve, cash, or Pool code RPC errors are retained as censored missingness', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  for (const options of [
    { reserveRpcError: true },
    { cashRpcError: true },
    { codeRpcError: true },
  ]) {
    const { client } = fixture({ ...options, revert: true })
    const outcome = await collectOutcome({
      client,
      baseline,
      horizon: '6h',
      checkDisk: () => {},
      now: () => (BASE_TIME + 30000) * 1000,
    })
    const witness = outcome.markets[0].witnesses[0]
    assert.equal(witness.call, 'revert')
    assert.equal(witness.deterioration, 'censored')
    assert.notEqual(witness.censoring.length, 0)
    if (options.reserveRpcError) {
      assert.equal(outcome.markets[0].reserveIdentityChanged, null)
      assert.equal(outcome.markets[0].decimalsChanged, null)
    }
  }
})

test('disk guard error in witness phase is fatal and never saved as missingness', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client, calls } = fixture()
  const checkDisk = () => {
    if (calls.some((call) => call.startsWith('getReserveData:'))) throw new Error('disk floor')
  }
  await assert.rejects(
    run({ ...paths, client, baselineBlock: BASE_BLOCK, horizon: '6h', checkDisk }),
    /disk floor/,
  )
  assert.equal(existsSync(paths.out), false)
})

test('a baseline observed after its horizon is retrospective and makes no RPC', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  baseline.observedAtMs = (BASE_TIME + HORIZONS['6h']) * 1000
  const { client, calls } = fixture()
  await assert.rejects(
    collectOutcome({ client, baseline, horizon: '6h', checkDisk: () => {} }),
    /not prospective/,
  )
  assert.deepEqual(calls, [])
})

test('tampered baseline or outcome seal is rejected before trusting rows', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const saved = JSON.parse(readFileSync(paths.baselinePath, 'utf8'))
  saved.payload.baselines[0].markets[0].qualifyingHolders = [A(9)]
  writeFileSync(paths.baselinePath, JSON.stringify(saved))
  assert.throws(() => plan(paths), /SHA mismatch/)
})

test('reorganization at final pinned block prevents write', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const { client } = fixture({ reorg: true })
  await assert.rejects(
    run({
      ...paths,
      client,
      baselineBlock: BASE_BLOCK,
      horizon: '6h',
      checkDisk: () => {},
      now: () => (BASE_TIME + 30000) * 1000,
    }),
    /reorganized/,
  )
  assert.equal(existsSync(paths.out), false)
})

const B_CONFIG = {
  poolImplementation: { status: 'observed', address: A(76), codeHash: keccak256('0x6000') },
}

test('same-anchor health bits and raw account data are retained without claiming post-withdraw health', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  const { client } = fixture({ revert: true, nestedRevertData: true })
  const outcome = await collectOutcome({
    client,
    baseline,
    baselineConfig: B_CONFIG,
    horizon: '6h',
    checkDisk: () => {},
    now: () => (BASE_TIME + 30000) * 1000,
  })
  const usdc = outcome.markets[0].witnesses[0]
  const usdt = outcome.markets[1].witnesses[0]
  assert.equal(outcome.markets[0].reserveId, 0)
  assert.equal(outcome.markets[1].reserveId, 1)
  assert.equal(usdc.selectedReserveCollateral, true)
  assert.equal(usdc.selectedReserveBorrowing, false)
  assert.equal(usdc.anyBorrow, false)
  assert.equal(usdt.selectedReserveCollateral, false)
  assert.equal(usdt.anyBorrow, false)
  assert.equal(usdc.accountData.totalDebtBase, '0')
  assert.equal(usdc.call, 'revert')
  assert.equal(usdc.revertData, '0x08c379a0deadbeef')
  assert.equal(usdc.revertSelector, '0x08c379a0')
  assert.equal(usdc.deterioration, 'baseline-success-to-unattributed-revert')
  assert.equal(usdc.cause, 'unknown-post-withdraw-health-unattested')
  assert.equal(outcome.poolImplementationChanged, false)
  assert.equal(outcome.baselineObservationLeadSeconds, 21_500)
})

test('health missingness, implementation drift, and unknown storage stay explicit and secret-free', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  for (const [options, expected] of [
    [{ revert: true, healthRpcError: true }, 'wallet-health-unavailable'],
    [{ revert: true, implementationChanged: true }, 'pool-implementation-changed'],
    [{ revert: true, implementationUnavailable: true }, 'pool-implementation-unresolved'],
  ]) {
    const { client } = fixture(options)
    const outcome = await collectOutcome({
      client,
      baseline,
      baselineConfig: B_CONFIG,
      horizon: '6h',
      checkDisk: () => {},
      now: () => (BASE_TIME + 30000) * 1000,
    })
    const witness = outcome.markets[0].witnesses[0]
    assert.ok(witness.censoring.includes(expected))
    assert.equal(witness.deterioration, 'censored')
    assert.equal(JSON.stringify(outcome).includes('private-rpc.example'), false)
    assert.equal(JSON.stringify(outcome).includes('secret'), false)
    if (options.healthRpcError) {
      assert.deepEqual(witness.healthReadErrors, ['getUserConfiguration', 'getUserAccountData'])
      assert.equal(witness.accountData, null)
      assert.equal(witness.bitmapRaw, null)
    }
    if (options.implementationChanged) assert.equal(outcome.poolImplementationChanged, true)
    if (options.implementationUnavailable) assert.equal(outcome.poolImplementationChanged, null)
  }
})

test('saved outcome re-joins sealed baseline and frozen holder ledger before another horizon', async (t) => {
  const paths = temp(t)
  baselineFixture(paths.baselinePath)
  const originalBaseline = readFileSync(paths.baselinePath, 'utf8')
  const { client } = fixture()
  await run({
    ...paths,
    client,
    baselineBlock: BASE_BLOCK,
    horizon: '6h',
    checkDisk: () => {},
    now: () => (BASE_TIME + 30000) * 1000,
  })
  const changed = JSON.parse(readFileSync(paths.baselinePath, 'utf8'))
  changed.payload.baselines[0].observedAtMs += 1
  changed.payload.baselines[0].rowSha256 = sha({
    ...changed.payload.baselines[0],
    rowSha256: undefined,
  })
  changed.sha256 = sha(changed.payload)
  writeFileSync(paths.baselinePath, JSON.stringify(changed))
  assert.throws(() => readCheckpoint(paths.out, paths.baselinePath), /row chain mismatch/)
  await assert.rejects(
    run({ ...paths, client, baselineBlock: BASE_BLOCK, horizon: '24h', checkDisk: () => {} }),
    /row chain mismatch/,
  )
  writeFileSync(paths.baselinePath, originalBaseline)
  const saved = JSON.parse(readFileSync(paths.out, 'utf8'))
  saved.payload.outcomes[0].markets[0].witnesses[0].holder = A(999)
  saved.payload.outcomes[0].rowSha256 = sha({ ...saved.payload.outcomes[0], rowSha256: undefined })
  saved.sha256 = sha(saved.payload)
  writeFileSync(paths.out, JSON.stringify(saved))
  assert.throws(() => readCheckpoint(paths.out, paths.baselinePath), /row chain mismatch/)
})

test('aToken implementation drift or missing B slot censors attribution independently of Pool', async (t) => {
  const paths = temp(t)
  const baseline = baselineFixture(paths.baselinePath)
  for (const [options, expected] of [
    [{ aTokenImplementationChanged: true }, 'aToken-implementation-changed'],
    [{ aTokenBaselineUnavailable: true }, 'aToken-implementation-unresolved'],
  ]) {
    const { client } = fixture({ ...options, revert: true })
    const outcome = await collectOutcome({
      client,
      baseline,
      baselineConfig: B_CONFIG,
      horizon: '6h',
      checkDisk: () => {},
      now: () => (BASE_TIME + 30000) * 1000,
    })
    const market = outcome.markets[0]
    assert.equal(outcome.poolImplementationChanged, false)
    assert.equal(
      market.aTokenImplementationChanged,
      options.aTokenImplementationChanged ? true : null,
    )
    assert.ok(market.witnesses[0].censoring.includes(expected))
    assert.equal(market.witnesses[0].deterioration, 'censored')
    assert.equal(JSON.stringify(outcome).includes('private-rpc.example'), false)
  }
})
