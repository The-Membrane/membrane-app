import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import {
  artifactPath,
  importArtifact,
  inspectArtifact,
  listArtifacts,
  verifyArtifacts,
} from './local-artifacts.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'venue-artifacts-'))
  const root = join(dir, 'catalog')
  const source = join(dir, 'quotes.json')
  const sample = {
    study: 'scrvUSD historical direct quotes',
    days: 2,
    stepBlocks: 900,
    rows: [
      {
        block: 100,
        at: 1000,
        pools: [{}, {}],
        quotes: { 10000: 1, 1000000: 0.99, 20000000: 0.98 },
      },
      {
        block: 101,
        at: 2000,
        pools: [{}, {}],
        quotes: { 10000: 1, 1000000: 0.98, 20000000: 0.97 },
      },
    ],
  }
  writeFileSync(source, JSON.stringify(sample))
  return { dir, root, source, sample }
}

test('imports once, verifies content, and resolves stable local path', () => {
  const { root, source } = fixture()
  const first = importArtifact({ name: 'scrvusd-2d', source, root })
  assert.equal(first.status, 'imported')
  assert.equal(first.count, 2)
  assert.equal(first.firstBlock, 100)
  assert.equal(importArtifact({ name: 'scrvusd-2d', source, root }).status, 'already-present')
  assert.deepEqual(verifyArtifacts({ root }), { verified: 1, names: ['scrvusd-2d'] })
  assert.equal(listArtifacts({ root }).length, 1)
  assert.deepEqual(
    JSON.parse(readFileSync(artifactPath({ name: 'scrvusd-2d', root }))),
    JSON.parse(readFileSync(source)),
  )
})

test('imports only a complete, unique, gap-free Morpho V2 factory census', () => {
  const { dir, root } = fixture()
  const source = join(dir, 'morpho-factory.json')
  const vault = '0x23f5E9c35820f4baB695Ac1F19c203cC3f8e1e11'
  const event = {
    block: 24_568_955,
    blockHash: `0x${'a'.repeat(64)}`,
    transactionIndex: 1,
    txHash: `0x${'b'.repeat(64)}`,
    logIndex: 2,
    timestamp: 1_772_416_000,
    owner: `0x${'1'.repeat(40)}`,
    asset: `0x${'2'.repeat(40)}`,
    vault,
    salt: `0x${'3'.repeat(64)}`,
  }
  const data = {
    study: 'morpho-v2-factory-create-v1',
    source: 'eth_getLogs',
    factory: '0xA1D94F746dEfa1928926b84fB2596c06926C0405',
    topic0: '0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e',
    from: 23_375_073,
    to: 26_052_740,
    chunkBlocks: 10_000,
    status: 'complete',
    nextChunk: 268,
    events: [event],
    coverage: {
      fromBlock: 23_375_073,
      throughBlock: 26_052_740,
      chunksComplete: 268,
      chunksExpected: 268,
    },
    summary: {
      eventCount: 1,
      uniqueVaultCount: 1,
      duplicateVaultCount: 0,
      containsSkyVault: true,
    },
  }
  writeFileSync(source, JSON.stringify(data))
  assert.equal(importArtifact({ name: 'morpho-v2-factory-test', source, root }).count, 1)
  assert.equal(verifyArtifacts({ root }).verified, 1)
  data.events.push({ ...event, txHash: `0x${'c'.repeat(64)}`, logIndex: 3 })
  data.summary.eventCount = 2
  data.summary.uniqueVaultCount = 2
  writeFileSync(source, JSON.stringify(data))
  assert.throws(
    () => importArtifact({ name: 'morpho-duplicate', source, root }),
    /duplicate Morpho/,
  )
  data.events.pop()
  data.summary.eventCount = 1
  data.summary.uniqueVaultCount = 1
  data.coverage.throughBlock--
  writeFileSync(source, JSON.stringify(data))
  assert.throws(() => importArtifact({ name: 'morpho-gap', source, root }), /Malformed Morpho/)
})

test('imports complete Morpho V2 raw cap submissions but rejects a forged summary', () => {
  const { dir, root } = fixture()
  const source = join(dir, 'morpho-cap-raw.json')
  const event = {
    vault: '0x23f5E9c35820f4baB695Ac1F19c203cC3f8e1e11',
    block: 24_568_955,
    blockHash: `0x${'a'.repeat(64)}`,
    transactionIndex: 1,
    txHash: `0x${'b'.repeat(64)}`,
    logIndex: 2,
    timestamp: 1_772_416_000,
    selector: '0xf6f98fd5',
    data: '0x',
    executableAt: '1772500000',
  }
  const data = {
    study: 'morpho-v2-cap-submit-raw-v1',
    chainId: 1,
    factoryArtifactSha256: '745062b27def710352f1b6c5ca220ebc3a953513a384077e190f7eef92ea6aaa',
    pinnedHeadHash: `0x${'c'.repeat(64)}`,
    from: 23_375_073,
    to: 26_052_740,
    chunkBlocks: 8_000,
    topic0: '0x8b18afeb361b83b025999ed5b42f1d90c68aaa5a0fd49c015f04c3b8b81e80eb',
    selectorTopics: ['0xf6f98fd5', '0x2438525b'].map(
      (selector) => `0x${selector.slice(2).padEnd(64, '0')}`,
    ),
    coverage: {
      fromBlock: 23_375_073,
      throughBlock: 26_052_740,
      chunksComplete: 335,
      chunksExpected: 335,
      complete: true,
    },
    rawEvents: [event],
    summary: {
      rawSubmitCount: 1,
      selectorCounts: { absolute: 1, relative: 0 },
      uniqueVaultCount: 1,
    },
  }
  writeFileSync(source, JSON.stringify(data))
  assert.equal(importArtifact({ name: 'morpho-cap-raw-test', source, root }).count, 1)
  assert.equal(verifyArtifacts({ root }).verified, 1)
  data.summary.selectorCounts.absolute = 2
  writeFileSync(source, JSON.stringify(data))
  assert.throws(
    () => importArtifact({ name: 'morpho-cap-forged', source, root }),
    /summary mismatch/,
  )
})

const localMorphoStage1 = join(
  process.cwd(),
  'data/research/venue-signals/morpho-v2-cap-submit-stage1.json',
)
test(
  'local Morpho Stage 1 classification is source-linked and rejects forged eligibility',
  {
    skip: !existsSync(localMorphoStage1),
  },
  () => {
    const data = JSON.parse(readFileSync(localMorphoStage1, 'utf8'))
    assert.equal(
      inspectArtifact(Buffer.from(JSON.stringify(data))).kind,
      'morpho-v2-cap-submit-stage1',
    )
    data.summary.independentEligibleCount++
    assert.throws(
      () => inspectArtifact(Buffer.from(JSON.stringify(data))),
      /Stage 1 summary mismatch/,
    )
    data.summary.independentEligibleCount--
    data.rawEvents[0].block++
    assert.throws(
      () => inspectArtifact(Buffer.from(JSON.stringify(data))),
      /raw source hash mismatch/,
    )
  },
)

test('refuses conflicting name, invalid name, and malformed input', () => {
  const { root, source, sample } = fixture()
  importArtifact({ name: 'study', source, root })
  sample.rows[1].at = 999
  writeFileSync(source, JSON.stringify(sample))
  assert.throws(() => importArtifact({ name: 'bad', source, root }), /nonmonotonic/)
  sample.rows[1].at = 2001
  writeFileSync(source, JSON.stringify(sample))
  assert.throws(() => importArtifact({ name: 'study', source, root }), /different content/)
  assert.throws(() => artifactPath({ name: '../study', root }), /Name must/)
})

test('detects changed blob and refuses symlink sources', () => {
  const { dir, root, source } = fixture()
  importArtifact({ name: 'study', source, root })
  const path = artifactPath({ name: 'study', root })
  writeFileSync(path, '{}')
  assert.throws(() => verifyArtifacts({ root }), /mismatch/)
  const linked = join(dir, 'linked.json')
  symlinkSync(source, linked)
  assert.throws(
    () => importArtifact({ name: 'linked', source: linked, root }),
    /Symlink path refused/,
  )
})

test('Compound weekly screen requires complete pinned identity, cash, and coverage', () => {
  const { root, source } = fixture()
  const first = 23_229_806
  const last = 26_052_206
  const step = 50_400
  const markets = [
    {
      name: 'cUSDCv3',
      comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
      base: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      decimals: 6,
    },
    {
      name: 'cUSDTv3',
      comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
      base: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      decimals: 6,
    },
  ]
  const perMarket = 57
  const rows = markets.flatMap((market) =>
    Array.from({ length: perMarket }, (_, i) => {
      const block = first + i * step
      const at = 1_750_000_000 + i * 604_800
      return {
        market: market.name,
        comet: market.comet,
        base: market.base,
        decimals: market.decimals,
        block,
        at,
        cashRaw: '50000000000000',
        cashUsdAssumingPeg: 50_000_000,
        withdrawPaused: false,
        totalSupplyRaw: '100000000000000',
        totalBorrowRaw: '80000000000000',
        totalSupplyBaseRaw: '90000000000000',
        totalBorrowBaseRaw: '70000000000000',
        baseSupplyIndexRaw: '1100000000000000',
        baseBorrowIndexRaw: '1100000000000000',
        lastAccrualTime: at - 100,
      }
    }),
  )
  const state = {
    expected: 2 * perMarket,
    present: 2 * perMarket,
    missing: 0,
    complete: true,
    markets: Object.fromEntries(
      markets.map((market) => [
        market.name,
        {
          expected: perMarket,
          present: perMarket,
          missing: 0,
          maxGapSeconds: 604_800,
          maxGapBlocks: [first, first + step],
          firstBlock: first,
          lastBlock: last,
        },
      ]),
    ),
  }
  const value = {
    study: 'Compound III Ethereum USDC-USDT weekly cash prevalence screen',
    version: 1,
    chainId: 1,
    grid: { first, last, step },
    markets,
    scenariosUsdAssumingPeg: [1_000_000, 10_000_000, 100_000_000],
    semantics:
      'Pinned baseToken.balanceOf(Comet); Comet totalSupply/totalBorrow accrued present values plus totalsBasic principal/index; isWithdrawPaused. Cash assumes $1 peg.',
    status: 'complete',
    coverage: state,
    failedReadCount: 0,
    failures: [],
    rows,
  }
  const inspect = (data) => inspectArtifact(Buffer.from(JSON.stringify(data)))
  assert.equal(inspect(value).kind, 'compound-comet-weekly-cash-screen')
  writeFileSync(source, JSON.stringify(value))
  assert.equal(
    importArtifact({ name: 'compound-fixture', source, root }).kind,
    'compound-comet-weekly-cash-screen',
  )
  assert.equal(verifyArtifacts({ root }).verified, 1)
  for (const mutate of [
    (v) => (v.grid.step = 900),
    (v) => (v.scenariosUsdAssumingPeg[1] = 5_000_000),
    (v) => (v.rows[0].base = markets[1].base),
    (v) => (v.rows[0].cashUsdAssumingPeg += 1),
    (v) => (v.rows[0].totalSupplyRaw = null),
    (v) => (v.rows[0].lastAccrualTime = v.rows[0].at + 1),
    (v) => v.rows.splice(1, 1),
    (v) => (v.coverage.markets.cUSDCv3.maxGapSeconds += 1),
    (v) => (v.failedReadCount = 1),
    (v) => v.failures.push({ block: first }),
  ]) {
    const bad = JSON.parse(JSON.stringify(value))
    mutate(bad)
    assert.throws(() => inspect(bad), /Compound weekly/)
  }

  const usdsMarket = {
    name: 'cUSDSv3',
    comet: '0x5D409e56D886231aDAf00c8775665AD0f9897b56',
    base: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
    decimals: 18,
  }
  const usds = JSON.parse(JSON.stringify(value))
  usds.study = 'Compound III Ethereum USDS weekly cash prevalence expansion'
  usds.markets = [usdsMarket]
  usds.rows = usds.rows.slice(0, perMarket).map((row) => ({
    ...row,
    market: usdsMarket.name,
    comet: usdsMarket.comet,
    base: usdsMarket.base,
    decimals: usdsMarket.decimals,
    cashRaw: '50000000000000000000000000',
  }))
  usds.coverage.expected = perMarket
  usds.coverage.present = perMarket
  usds.coverage.markets = { [usdsMarket.name]: state.markets.cUSDCv3 }
  assert.equal(inspect(usds).kind, 'compound-comet-usds-weekly-cash-screen')
  writeFileSync(source, JSON.stringify(usds))
  assert.equal(
    importArtifact({ name: 'compound-usds-fixture', source, root }).kind,
    'compound-comet-usds-weekly-cash-screen',
  )
  assert.equal(verifyArtifacts({ root }).verified, 2)
  for (const mutate of [
    (v) => (v.markets[0].decimals = 6),
    (v) => (v.rows[0].base = markets[0].base),
    (v) => (v.rows[0].cashUsdAssumingPeg += 1),
    (v) => (v.rows[0].totalBorrowRaw = null),
    (v) => v.rows.splice(1, 1),
    (v) => (v.coverage.markets.cUSDSv3.maxGapSeconds += 1),
    (v) => (v.failedReadCount = 1),
  ]) {
    const bad = JSON.parse(JSON.stringify(usds))
    mutate(bad)
    assert.throws(() => inspect(bad), /Compound weekly/)
  }
})

test('recognizes split, Chainlink, and upstream feature collections', () => {
  const { root, source } = fixture()
  const timeline = [
    { block: 100, at: 1000 },
    { block: 101, at: 2000 },
  ]
  const cases = [
    {
      name: 'split',
      kind: 'curve-split-route-samples',
      data: {
        study: 'exploratory fixed-grid split route; post-outcome redesign, no promotion',
        rows: timeline.map((row) => ({ ...row, singleQuote: 0.9, splitQuote: 0.98, grid: [{}] })),
      },
    },
    {
      name: 'eth',
      kind: 'chainlink-eth-prices',
      data: {
        study: 'ETH/USD Chainlink as-of pinned Curve quote blocks',
        prices: timeline.map((row) => ({ ...row, price: 3000, oracleUpdatedAt: row.at - 10 })),
      },
    },
    {
      name: 'upstream',
      kind: 'curve-upstream-features',
      data: {
        summary: { study: 'scrvUSD upstream flow, peg, and registered PegKeeper exploratory test' },
        features: timeline.map((row) => ({ ...row, quote20m: 0.99, pools: [], keepers: [] })),
      },
    },
  ]
  for (const entry of cases) {
    writeFileSync(source, JSON.stringify(entry.data))
    assert.equal(importArtifact({ name: entry.name, source, root }).kind, entry.kind)
  }
  assert.deepEqual(verifyArtifacts({ root }).names, ['eth', 'split', 'upstream'])
})

test('stores compressed raw swaps by the compressed-byte hash', () => {
  const { dir, root } = fixture()
  const source = join(dir, 'swaps.json.gz')
  const pool = '0x1111111111111111111111111111111111111111'
  const raw = {
    study: 'scrvUSD raw Curve TokenExchange logs',
    chainId: 1,
    fromBlock: 99,
    toBlock: 101,
    poolAddresses: [pool, '0x2222222222222222222222222222222222222222'],
    decodedSwaps: 2,
    swaps: [
      {
        block: 100,
        logIndex: 1,
        pool,
        soldId: 0,
        boughtId: 1,
        tokensSold: '100',
        tokensBought: '99',
        netCrvUsd: -0.000000000000000099,
      },
      {
        block: 101,
        logIndex: 0,
        pool,
        soldId: 1,
        boughtId: 0,
        tokensSold: '100',
        tokensBought: '99',
        netCrvUsd: 0.0000000000000001,
      },
    ],
  }
  writeFileSync(source, gzipSync(JSON.stringify(raw)))
  const entry = importArtifact({ name: 'swaps', source, root })
  assert.equal(entry.kind, 'curve-token-exchange-swaps')
  assert.match(entry.file, /\.json\.gz$/)
  assert.equal(entry.count, 2)
  assert.deepEqual(verifyArtifacts({ root }), { verified: 1, names: ['swaps'] })
})

test('Curve A-ramp census accepts complete empty study and exact nonempty positive control', () => {
  const { root, source } = fixture()
  const addresses = [
    '0x390f3595bCa2Df7d23783dFd126427CCeb997BF4',
    '0x4DEcE678ceceb27446b35C672dC7d61F30bAD69E',
  ]
  const pools = addresses.map((address, i) => ({ address, name: `pool-${i}` }))
  const urls = addresses.map((address) => `https://etherscan.io/address/${address}#code`)
  const byPool = (rampA) =>
    Object.fromEntries(addresses.map((address) => [address, { RampA: rampA, StopRampA: 0 }]))
  const full = {
    study: 'Curve crvUSD exit-pool RampA/StopRampA census',
    source: urls,
    from: 23_178_731,
    to: 26_051_931,
    chunkBlocks: 8_000,
    pools,
    status: 'complete',
    nextChunk: 360,
    events: [],
    summary: { total: 0, byPool: byPool(0) },
  }
  const at = 1_746_151_007
  const transaction = `0x45c7034b910949a868db843f7257bfb6bef20487fd07ec7c3f1de840f33d6639`
  const control = {
    ...full,
    from: 22_200_000,
    to: 22_600_000,
    nextChunk: 51,
    events: addresses.map((pool, i) => ({
      pool,
      type: 'RampA',
      block: 22_393_005,
      logIndex: 212 + i * 3,
      txHash: transaction,
      timestamp: at,
      args: {
        old_A: '50000',
        new_A: '200000',
        initial_time: String(at),
        future_time: '1746728812',
      },
    })),
    summary: { total: 2, byPool: byPool(1) },
  }
  const inspect = (value) => inspectArtifact(Buffer.from(JSON.stringify(value)))
  assert.deepEqual(inspect(full), {
    kind: 'curve-ramp-events-400d',
    study: full.study,
    count: 0,
    firstBlock: full.from,
    lastBlock: full.to,
  })
  assert.equal(inspect(control).kind, 'curve-ramp-positive-control')
  writeFileSync(source, JSON.stringify(full))
  assert.equal(importArtifact({ name: 'curve-ramp-empty', source, root }).count, 0)
  writeFileSync(source, JSON.stringify(control))
  assert.equal(importArtifact({ name: 'curve-ramp-control', source, root }).count, 2)
  assert.equal(verifyArtifacts({ root }).verified, 2)
  assert.throws(() => inspect({ ...full, status: 'partial' }), /Malformed/)
  assert.throws(() => inspect({ ...full, nextChunk: 359 }), /Malformed/)
  assert.throws(() => inspect({ ...full, pools: pools.slice(1) }), /Malformed/)
  assert.throws(() => inspect({ ...full, events: control.events }), /Malformed/)
  assert.throws(() => inspect({ ...control, events: [] }), /Malformed/)
  assert.throws(
    () => inspect({ ...control, summary: { total: 1, byPool: byPool(1) } }),
    /Malformed/,
  )
  assert.throws(
    () => inspect({ ...control, events: [...control.events].reverse() }),
    /nonmonotonic|positive control/,
  )
  assert.throws(
    () =>
      inspect({
        ...control,
        events: control.events.map((event, i) =>
          i ? event : { ...event, args: { ...event.args, initial_time: '1' } },
        ),
      }),
    /Malformed/,
  )
  assert.throws(() => inspect({ ...control, source: [] }), /Malformed/)
})

test('recognizes fixed-size secondary routes and rejects a forged best grid quote', () => {
  const { root, source } = fixture()
  const grid = [0, 0.25, 0.5, 0.75, 1].map((usdtShare, i) => ({ usdtShare, output: 90_000 + i }))
  const route = { grid, bestQuote: 90_004 / 100_000 }
  const largeGrid = grid.map((point) => ({ ...point, output: point.output * 10 }))
  const largeRoute = { grid: largeGrid, bestQuote: 900_040 / 1_000_000 }
  const sample = {
    study: 'fixed-size two-pool scrvUSD secondary exits',
    sampleCount: 2,
    firstBlock: 100,
    lastBlock: 101,
    sizes: { 100000: {}, 1000000: {} },
    caveats: [],
    rows: [
      {
        block: 100,
        at: 1000,
        vaultAssetsCrvUsd: 2_000_000,
        routes: { 100000: route, 1000000: largeRoute },
      },
      {
        block: 101,
        at: 2000,
        vaultAssetsCrvUsd: 2_000_000,
        routes: { 100000: route, 1000000: largeRoute },
      },
    ],
  }
  writeFileSync(source, JSON.stringify(sample))
  assert.equal(
    importArtifact({ name: 'size-aware', source, root }).kind,
    'curve-size-aware-secondary-exits',
  )
  sample.rows[1].routes[100000] = { ...route, bestQuote: 1 }
  writeFileSync(source, JSON.stringify(sample))
  assert.throws(() => importArtifact({ name: 'forged', source, root }), /Malformed or nonmonotonic/)
})

test('recognizes complete Aave USDe cash-runway samples but not partial samples', () => {
  const { root, source } = fixture()
  const address = '0x1111111111111111111111111111111111111111'
  const sample = {
    study: 'Aave V3 USDe unencumbered supplier cash-exit runway',
    version: 1,
    status: 'complete',
    chainId: 1,
    pool: address,
    underlying: address,
    aToken: address,
    variableDebtToken: address,
    stepBlocks: 900,
    rows: [100, 101].map((block, i) => ({
      block,
      at: 1000 + 1000 * i,
      cash: 200_000_000,
      debt: 100_000_000,
      liquidityRatePct: 2,
      borrowRatePct: 4,
      active: true,
      frozen: false,
      paused: false,
    })),
  }
  writeFileSync(source, JSON.stringify(sample))
  assert.equal(importArtifact({ name: 'aave', source, root }).kind, 'aave-usde-cash-runway')
  sample.status = 'partial'
  writeFileSync(source, JSON.stringify(sample))
  assert.throws(() => importArtifact({ name: 'aave-partial', source, root }), /Malformed Aave/)
})

test('Aave freeze research schemas reject partial and malformed records', () => {
  const event = {
    type: 'ReserveFrozen',
    enabled: true,
    asset: '0x1111111111111111111111111111111111111111',
    txHash: `0x${'a'.repeat(64)}`,
    block: 100,
    at: 1000,
    logIndex: 1,
  }
  const census = {
    study: 'Aave V3 Ethereum cross-reserve configuration event census',
    status: 'complete',
    configurator: event.asset,
    from: 99,
    to: 101,
    events: [event],
  }
  const inspect = (value) => inspectArtifact(Buffer.from(JSON.stringify(value)))
  assert.equal(inspect(census).kind, 'aave-config-events')
  assert.throws(() => inspect({ ...census, status: 'partial' }), /Malformed/)
  assert.throws(() => inspect({ ...census, events: [event, event] }), /nonmonotonic/)
  const response = Object.fromEntries(
    [10000000, 50000000, 100000000].map((q) => [q, { eligible: true, crossed: false }]),
  )
  const summary = Object.fromEntries(
    [10000000, 50000000, 100000000].map((q) => [q, { eligibleEvents: 1, eventCrossings: 0 }]),
  )
  const incident = {
    block: 100,
    at: 1000,
    preCash: 200_000_000,
    events: [event],
    path: [6, 9, 12, 15, 18, 21, 24].map((hour) => ({ hour, cash: 200_000_000 })),
    response,
  }
  const study = {
    status: 'complete',
    census: { from: 99, to: 101, events: 1 },
    prereg: { version: 1 },
    incidents: [incident],
    summary,
  }
  assert.equal(inspect(study).kind, 'aave-freeze-incidents')
  assert.throws(() => inspect({ ...study, incidents: [{ ...incident, path: [] }] }), /Malformed/)
  const twoStage = {
    status: 'complete',
    exploratory: true,
    rule: 'positive cross-reserve configuration incident then trailing 6h USDe cash drop > 14d pre-anchor p95 at +3h or +6h',
    results: [{ label: 'event', anchorAt: 1000, baseline: 'unavailable', coverage: { rows: 2 } }],
  }
  assert.equal(inspect(twoStage).kind, 'aave-freeze-cash-two-stage')
  assert.throws(
    () => inspect({ ...twoStage, results: [{ ...twoStage.results[0], coverage: {} }] }),
    /Malformed/,
  )
})

test('complete Aave dense windows require six fully populated pinned windows', () => {
  const address = '0x1111111111111111111111111111111111111111'
  const windows = Array.from({ length: 6 }, (_, n) => {
    const rows = Array.from({ length: 115 }, (_, i) => ({
      block: 100_000 + n * 115 * 900 + i * 900,
      at: 1_000_000 + n * 115 * 10_800 + i * 10_800,
      cash: 200_000_000,
      cashRaw: '200000000000000000000000000',
      status: 'ok',
    }))
    return {
      kind: n % 2 ? 'control' : 'incident',
      anchorAt: rows[112].at,
      anchorBlock: rows[112].block,
      coverage: { complete: true, failed: 0, successful: 115 },
      rows,
    }
  })
  const uniqueRows = windows.flatMap((window) => window.rows)
  const raw = {
    study: 'Aave USDe dense pre-incident cash windows and matched controls',
    status: 'complete',
    collection: { version: 1, targetCashUsd: 100_000_000, expectedRowsPerWindow: 115 },
    provenance: { aToken: address, underlying: address },
    signature: 'a'.repeat(64),
    windows,
    uniqueRows,
    uniqueScheduledBlocks: 690,
    rpcRange: { firstBlock: uniqueRows[0].block, lastBlock: uniqueRows.at(-1).block },
  }
  const inspect = (value) => inspectArtifact(Buffer.from(JSON.stringify(value)))
  assert.equal(inspect(raw).kind, 'aave-freeze-dense-cash-windows')
  assert.throws(() => inspect({ ...raw, status: 'partial' }), /Malformed/)
  assert.throws(
    () =>
      inspect({
        ...raw,
        windows: windows.map((window, i) =>
          i ? window : { ...window, coverage: { ...window.coverage, complete: false } },
        ),
      }),
    /Malformed/,
  )
})

test('expanded Aave score requires all eight windows to be scored', () => {
  const point = (hour) => ({ hour, sixHourDropUsd: 0, flagged: false })
  const results = Array.from({ length: 8 }, (_, i) => ({
    kind: i % 2 ? 'control' : 'incident',
    status: 'scored',
    anchorAt: 1000 + i,
    baseline: { p95Usd: 1 },
    checkpoints: [point(3), point(6)],
    flagged: false,
    crossedQ100m: false,
  }))
  const raw = {
    status: 'complete',
    exploratory: true,
    ruleFrozenBeforeMissingWindowCollection: true,
    target: 'q=$100m USDe cash crossing at 6–24h sampled outcome points',
    signal: 'fixed exploratory two-stage rule',
    results,
    summary: {
      eligibleIncidents: 4,
      eligibleControls: 4,
      scoredIncidents: 4,
      scoredControls: 4,
      minimumSampleGatePassed: false,
    },
  }
  const inspect = (value) => inspectArtifact(Buffer.from(JSON.stringify(value)))
  assert.equal(inspect(raw).kind, 'aave-freeze-cash-expanded-score')
  assert.throws(() => inspect({ ...raw, results: results.slice(1) }), /Malformed/)
  assert.throws(
    () =>
      inspect({
        ...raw,
        results: results.map((row, i) => (i ? row : { ...row, status: 'unscorable' })),
      }),
    /Malformed/,
  )
})

test('cash/event ablation stores independently suppressed alert arms', () => {
  const event = { enabled: true }
  const alert = {
    at: 1000,
    cash: 200_000_000,
    sixHourDrop: 20,
    past14dP95: 10,
    targetAt: null,
    precedingEvent: event,
  }
  const arm = { alerts: 1, hits: 0, falseAlerts: 1, alertsDetail: [alert] }
  const raw = {
    status: 'complete',
    exploratory: true,
    rule: {
      qUsd: 100_000_000,
      suppressionHours: 24,
      eventGate: 'same candidates with independent 24h suppression',
    },
    samples: 559,
    independentEpisodes: [],
    span: { first: '2026-01-01T00:00:00.000Z', last: '2026-02-01T00:00:00.000Z' },
    cashOnly: arm,
    eventGated: arm,
  }
  const inspect = (value) => inspectArtifact(Buffer.from(JSON.stringify(value)))
  assert.equal(inspect(raw).kind, 'aave-cash-event-ablation')
  assert.throws(
    () =>
      inspect({
        ...raw,
        eventGated: { ...arm, alertsDetail: [{ ...alert, precedingEvent: null }] },
      }),
    /Malformed/,
  )
})

test('Aave full grid rejects missing or gapped pinned rows', () => {
  const address = '0x1111111111111111111111111111111111111111'
  const rows = Array.from({ length: 3137 }, (_, i) => ({
    block: 23_229_806 + 900 * i,
    at: 100_000 + 10_800 * i,
    cash: 200_000_000,
    debt: 100_000_000,
    liquidityRatePct: 2,
    borrowRatePct: 4,
    active: true,
    frozen: false,
    paused: false,
    source: 'archive-read',
  }))
  const raw = {
    study: 'Aave V3 USDe full 400d pinned cash grid',
    status: 'complete',
    version: 1,
    chainId: 1,
    pool: address,
    underlying: address,
    aToken: address,
    variableDebtToken: address,
    grid: { first: 23_229_806, last: 26_052_206, step: 900 },
    coverage: {
      expected: 3137,
      present: 3137,
      missing: 0,
      complete: true,
      maxGapSeconds: 10_800,
      firstBlock: 23_229_806,
      lastBlock: 26_052_206,
    },
    failedReadCount: 0,
    failures: [],
    rows,
  }
  const inspect = (value) => inspectArtifact(Buffer.from(JSON.stringify(value)))
  assert.equal(inspect(raw).kind, 'aave-usde-full-cash-grid')
  assert.throws(() => inspect({ ...raw, rows: rows.slice(1) }), /Malformed/)
  const bad = rows.map((row, i) => (i === 100 ? { ...row, at: row.at + 20_000 } : row))
  assert.throws(() => inspect({ ...raw, rows: bad }), /Malformed/)
})

test('full-grid Aave evaluation requires pinned sources and independent arm totals', () => {
  const arm = { alerts: 1, hits: 0, falseAlerts: 1, alertsDetail: [{}], independentEpisodes: 0 }
  const period = { episodes: [], independentControls: 20, cashOnly: arm, eventGated: arm }
  const raw = {
    study: 'Fixed full-400d walk-forward Aave USDe cash and cross-asset-event ablation',
    status: 'complete',
    exploratory: true,
    sources: {
      cashSha256: '8489c2135c2d0a981d948876b16fd40e409e710e9f1d169ef3c23aa99c7b9681',
      eventCensusSha256: 'b9492de70a178957531a810917232e7e50a3c4fbe85fe3cf464c88d772df120f',
    },
    rule: { qUsd: 100_000_000, promotionGate: { minIndependentEpisodes: 20 } },
    samples: 3137,
    grid: { first: 23_229_806, last: 26_052_206, complete: true },
    split: { boundaryIndex: Math.floor(3137 * 0.7), purgeSeconds: 86400 },
    train: period,
    holdout: period,
    promotion: { status: 'unassessable' },
    span: { first: '2025-08-27T00:00:00.000Z', last: '2026-09-25T00:00:00.000Z' },
  }
  const inspect = (value) => inspectArtifact(Buffer.from(JSON.stringify(value)))
  assert.equal(inspect(raw).kind, 'aave-usde-full-grid-evaluation')
  assert.throws(
    () => inspect({ ...raw, train: { ...period, cashOnly: { ...arm, falseAlerts: 0 } } }),
    /Malformed/,
  )
})

test('stores verified Sky Pocket pilot and weekly state artifacts', () => {
  const { dir, root } = fixture()
  const pilotSource = join(dir, 'sky-pilot.json')
  const weeklySource = join(dir, 'sky-weekly.json')
  const addresses = {
    wrapper: '0xA188EEC8F81263234dA3622A406892F3D630f98c',
    psm: '0xf6e72Db5454dd049d0788e411b06CfAF16853042',
    pocket: '0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    usds: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
  }
  const samples = [
    { block: 100, at: 1000, pocketUsdcRaw: '2000000000000', toutRaw: '0' },
    { block: 101, at: 2000, pocketUsdcRaw: '1900000000000', toutRaw: '0' },
  ]
  const event = { block: 100, at: 1000, tx: `0x${'a'.repeat(64)}`, logIndex: 1 }
  const pilot = {
    study: 'sky-litepsm-usdc-runway-v1',
    protocol: { study: 'sky-litepsm-usdc-runway-v1', positionUsdc: 20_000_000 },
    days: 7,
    addresses,
    source: { headBlock: 101, startBlock: 100, stepBlocks: 900 },
    samples,
    transfers: [{ ...event, direction: 'out', usdcRaw: '1' }],
    psmEvents: [{ ...event, type: 'BuyGem', valueRaw: '1', feeRaw: '0' }],
  }
  writeFileSync(pilotSource, JSON.stringify(pilot))
  assert.equal(
    importArtifact({ name: 'sky-pilot', source: pilotSource, root }).kind,
    'sky-litepsm-pocket-pilot',
  )
  const weekly = {
    study: 'sky-litepsm-pocket-weekly-screen-v1',
    horizonDays: 400,
    positionUsdc: 20_000_000,
    addresses,
    source: { headBlock: 101, stepBlocks: 50_400 },
    samples,
  }
  writeFileSync(weeklySource, JSON.stringify(weekly))
  assert.equal(
    importArtifact({ name: 'sky-weekly', source: weeklySource, root }).kind,
    'sky-litepsm-pocket-weekly-screen',
  )
  assert.deepEqual(verifyArtifacts({ root }), {
    verified: 2,
    names: ['sky-pilot', 'sky-weekly'],
  })
  pilot.transfers[0].usdcRaw = '-1'
  writeFileSync(pilotSource, JSON.stringify(pilot))
  assert.throws(
    () => importArtifact({ name: 'sky-bad', source: pilotSource, root }),
    /Malformed Sky LitePSM pilot/,
  )
})
