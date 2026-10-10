import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import card from '../../components/Carry/ExitPressureCard.tsx'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import sampledModule from '../../lib/carry/conditionalSampledCashPathProjection.ts'
import timelineModule from '../../lib/carry/localHistoricalSampledCashTimeline.ts'
import grossModule from '../../lib/carry/conditionalGrossFlowHeadroom.ts'
import historicalFlowModule from '../../lib/carry/historicalCompetingFlowEstimate.ts'
const { ExitPressureCard, formatExitPressureSignedRaw } = card
const hash = (s) => createHash('sha256').update(s).digest('hex')
const now = Date.parse('2026-10-08T12:00:00.000Z')
const root = 'data/research/venue-signals/local-carry-cash-v1'
const observations = readdirSync(root)
  .filter((n) => /^\d{12}\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(`${root}/${n}`, 'utf8')))
  .map((r) => ({
    collectionMode: r.collectionMode,
    anchorAt: r.anchorAt,
    firstLocalReceiptAt: r.firstLocalReceiptAt,
    receiptSha256: r.sha256,
    manifestSha256: r.manifestSha256,
    source: { block: r.block, blockHash: r.blockHash, blockAt: r.blockAt },
    subjects: r.rows,
  }))
const aave = historicalFlowModule.AAVE_COMPETING_FLOW_IDENTITY
const vault = {
  routeKey: 'USDC → VaultV2 [USDC]',
  destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
  asset: aave.asset,
  assetDecimals: 6,
}
const summary = JSON.parse(
  readFileSync(
    new URL(
      '../../data/research/venue-signals/aave-usdc-flow-stress-duration-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
)
function fixture(id = vault, q = '1000000', local = false) {
  const h = timelineModule.localHistoricalSampledCashTimeline(observations, {
    route_key: id.routeKey,
    destination: id.destination,
    asset: id.asset,
  })
  assert.equal(h.status, 'sampled_timeline')
  const history = sampledModule.conditionalSampledCashHistoryFromVerifiedTimeline(observations, h)
  const source = {
    ...id,
    chainId: 1,
    cashRaw: '100000000',
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(now - 1000).toISOString(),
    readAt: new Date(now).toISOString(),
    sourceKind: local ? 'manifest_bound_ledger' : 'live_read_only_two_origin_finalized',
    ...(local
      ? { manifestSha256: history.witness.manifestSha256, receiptSha256: 'b'.repeat(64) }
      : {}),
  }
  const projection = sampledModule.buildConditionalSampledCashPathProjection(
    {
      history,
      currentSource: source,
      request: { requestedRaw: q, asOf: new Date(now).toISOString() },
    },
    hash,
  )
  assert.equal(projection.status, 'estimated')
  return {
    routeKey: id.routeKey,
    destination: id.destination,
    requestedAmount: '1',
    requestedRaw: q,
    requestedAssetSymbol: 'USDC',
    requestedAssetAddress: id.asset,
    requestedAssetDecimals: 6,
    horizonHours: 24,
    asOfMs: now,
    currentCash: {
      routeKey: id.routeKey,
      destination: id.destination,
      cashRaw: source.cashRaw,
      assetAddress: id.asset,
      assetDecimals: 6,
      assetSymbol: 'USDC',
      observedAt: source.blockTime,
      block: source.block,
      blockHash: source.blockHash,
      freshness: 'fresh',
      label: 'Vault cash',
      sourceKind: source.sourceKind,
      ...(local
        ? {
            firstLocalReceiptAt: source.readAt,
            manifestSha256: source.manifestSha256,
            receiptSha256: source.receiptSha256,
          }
        : { readAtUtc: source.readAt }),
    },
    conditionalSampledCashPathProjection: projection,
    prospectiveCashModel: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    holderAssessment: null,
    expectedEventEnrollment: null,
    eventContext: null,
    historicalOutlook: null,
  }
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(ExitPressureCard, p)),
  )
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
function withGross(p) {
  const current = p.currentCash
  const source = {
    chainId: 1,
    routeKey: p.routeKey,
    destination: p.destination,
    asset: p.requestedAssetAddress,
    assetDecimals: 6,
    cashRaw: current.cashRaw,
    blockNumber: Number(current.block),
    blockHash: current.blockHash,
    blockTime: current.observedAt,
    readAt: current.readAtUtc,
    finalized: true,
  }
  p.conditionalGrossFlowHeadroom = grossModule.buildConditionalGrossFlowHeadroom(
    {
      currentSource: source,
      request: { requestedRaw: p.requestedRaw, asOf: new Date(now).toISOString() },
      historicalFlow: historicalFlowModule.buildHistoricalCompetingFlowEstimate(summary, hash),
    },
    hash,
  )
  assert.equal(p.conditionalGrossFlowHeadroom.status, 'estimated')
  return p
}
const owner = `0x${'b'.repeat(40)}`
function withHolder(p) {
  const c = p.currentCash,
    source = {
      chainId: 1,
      blockNumber: Number(c.block),
      blockHash: c.blockHash,
      blockTime: c.observedAt,
      originValidation: 'two_provider',
    }
  const question = {
    routeKey: p.routeKey,
    destinationAddress: p.destination,
    owner,
    finalAssetAddress: p.requestedAssetAddress,
    finalAssetDecimals: 6,
    assetsRaw: p.requestedRaw,
  }
  p.requestedHolderAddress = owner
  p.holderAssessment = {
    status: 'assessed',
    routeKey: p.routeKey,
    destinationAddress: p.destination,
    owner,
    request: { assetsRaw: p.requestedRaw, assetAddress: p.requestedAssetAddress, horizonHours: 24 },
    source,
    stages: [
      {
        name: 'withdrawal',
        status: 'simulated',
        relatedToRequest: true,
        assetAddress: p.requestedAssetAddress,
        amountRaw: p.requestedRaw,
      },
    ],
    finalPayout: {
      status: 'simulated',
      assetAddress: p.requestedAssetAddress,
      amountRaw: p.requestedRaw,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    executionAgreement: {
      question,
      routeAndContractIdentityVerified: true,
      inputAndFinalAssetAddressesVerified: true,
      simulations: ['one.example', 'two.example'].map((originHost) => ({
        question: { ...question },
        originHost,
        source: { ...source, finalized: true },
        kind: 'full_route_execution',
        execution: 'single_call',
        fullRouteExecutionVerified: true,
        requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
        finalAssetAmountRaw: p.requestedRaw,
        status: 'simulated',
      })),
    },
  }
  return p
}
const question = (p) => ({
  routeKey: p.routeKey,
  destination: p.destination,
  requestedRaw: p.requestedRaw,
  requestedAssetAddress: p.requestedAssetAddress,
  requestedAssetDecimals: p.requestedAssetDecimals,
  horizonHours: p.horizonHours,
  asOfMs: p.asOfMs,
})
test('first actual future observed horizon renders without unrelated gross evidence', () => {
  const p = fixture(),
    h = p.conditionalSampledCashPathProjection.horizons[0],
    text = render(p)
  assert.match(text, /Projected cash headroom/)
  assert.ok(
    text.includes(
      `${formatExitPressureSignedRaw(h.userHeadroom.p10Raw, 6)}–${formatExitPressureSignedRaw(h.userHeadroom.p90Raw, 6)} USDC`,
    ),
  )
  assert.ok(text.includes(h.target.earliestAt.slice(5, 19).replace('T', ' ')))
  assert.ok(text.includes(h.target.latestAt.slice(5, 19).replace('T', ' ')))
  assert.doesNotMatch(text, /H24|MAE|TRAIN/)
  assert.equal(p.conditionalSampledCashPathProjection.horizons.length, 7)
})
test('negative range keeps signs and is never a future-holder-failure claim', () => {
  const p = fixture(vault, '900000000000000000000000000'),
    h = p.conditionalSampledCashPathProjection.horizons[0],
    text = render(p)
  assert.ok(h.userHeadroom.p90Raw.startsWith('-'))
  assert.ok(
    text.includes(
      `${formatExitPressureSignedRaw(h.userHeadroom.p10Raw, 6)}–${formatExitPressureSignedRaw(h.userHeadroom.p90Raw, 6)}`,
    ),
  )
  assert.doesNotMatch(text, /cannot withdraw|will fail|you can withdraw|Projected exit headroom/i)
})
test('genuine distinct local receipt metadata binds a fresh projection', () =>
  assert.match(render(fixture(vault, '1000000', true)), /Projected cash headroom/))
for (const name of [
  'Q',
  'hash',
  'block',
  'cash',
  'units',
  'asset',
  'read',
  'clock',
  'kind',
  'localWitness',
  'forgedMean',
  'forgedPath',
  'objectArray',
])
  test(`drops only optional generic row for ${name}`, () => {
    const p = fixture(vault, '1000000', name === 'localWitness')
    if (name === 'Q') p.requestedRaw = '2000000'
    if (name === 'hash') p.currentCash.blockHash = `0x${'c'.repeat(64)}`
    if (name === 'block') p.currentCash.block = []
    if (name === 'cash') p.currentCash.cashRaw = '1'
    if (name === 'units') p.currentCash.assetDecimals = 18
    if (name === 'asset') p.currentCash.assetAddress = `0x${'c'.repeat(40)}`
    if (name === 'read') delete p.currentCash.readAtUtc
    if (name === 'clock') p.asOfMs += 1800000
    if (name === 'kind') p.currentCash.sourceKind = 'unverified'
    if (name === 'localWitness') p.currentCash.receiptSha256 = 'c'.repeat(64)
    if (name === 'forgedMean')
      p.conditionalSampledCashPathProjection.horizons[0].userHeadroom.mean.floorRaw = '1'
    if (name === 'forgedPath')
      p.conditionalSampledCashPathProjection.scenarios[0].capacityRaw[0] = '1'
    if (name === 'objectArray')
      p.conditionalSampledCashPathProjection.horizons = Object.assign(
        {},
        p.conditionalSampledCashPathProjection.horizons,
      )
    const text = render(p)
    assert.doesNotMatch(text, /Projected cash headroom/)
    assert.match(text, /Vault cash/)
  })
test('valid Aave joint reserve flow takes preference over daily cash without duplicate row', () => {
  const p = withGross(fixture(aave))
  const text = render(p)
  assert.match(text, /Projected headroom/)
  assert.doesNotMatch(text, /Projected cash headroom|Projected exit headroom/)
  assert.equal((text.match(/Projected headroom/g) || []).length, 1)
})
test('exact owner Q C2 execution proof upgrades the same conditional row', () => {
  const p = withHolder(withGross(fixture(aave)))
  const text = render(p)
  assert.match(text, /Projected exit headroom/)
  assert.doesNotMatch(text, /Projected cash headroom/)
  assert.equal((text.match(/Projected exit headroom/g) || []).length, 1)
})
for (const name of ['owner', 'Q', 'C2', 'missing', 'withdrawal', 'expiry'])
  test(`holder ${name} disagreement retains cash conditional row`, () => {
    const p = withHolder(withGross(fixture(aave)))
    if (name === 'owner') p.requestedHolderAddress = `0x${'c'.repeat(40)}`
    if (name === 'Q') p.holderAssessment.executionAgreement.simulations[0].finalAssetAmountRaw = '1'
    if (name === 'C2')
      p.holderAssessment.executionAgreement.simulations[0].source.blockHash = `0x${'c'.repeat(64)}`
    if (name === 'missing') delete p.holderAssessment.executionAgreement
    if (name === 'withdrawal') p.holderAssessment.stages[0].name = 'deposit'
    if (name === 'expiry')
      p.holderAssessment.source.blockTime = new Date(now - 1800001).toISOString()
    const text = render(p)
    assert.doesNotMatch(text, /Projected exit headroom/)
    assert.match(text, /Projected headroom/)
  })
test('holder POST source reference comes exclusively from independently bound current header', () => {
  const p = withGross(fixture(aave))
  assert.deepEqual(
    workbench.matchingHolderForecastSourceReference(
      p.conditionalGrossFlowHeadroom,
      question(p),
      p.currentCash,
    ),
    {
      blockNumber: Number(p.currentCash.block),
      blockHash: p.currentCash.blockHash,
      blockTime: p.currentCash.observedAt,
    },
  )
})
for (const name of ['Q', 'hash', 'cash', 'array', 'overflow', 'stale', 'unverified'])
  test(`holder request never defaults to projection source for ${name}`, () => {
    const p = withGross(fixture(aave))
    if (name === 'Q') p.requestedRaw = '2000000'
    if (name === 'hash') p.currentCash.blockHash = `0x${'c'.repeat(64)}`
    if (name === 'cash') p.currentCash.cashRaw = '1'
    if (name === 'array') p.currentCash.block = []
    if (name === 'overflow') p.currentCash.block = '9007199254740992'
    if (name === 'stale') p.asOfMs += 1800000
    if (name === 'unverified') delete p.currentCash.sourceKind
    assert.equal(
      workbench.matchingHolderForecastSourceReference(
        p.conditionalGrossFlowHeadroom,
        question(p),
        p.currentCash,
      ),
      null,
    )
  })

test('Workbench copies genuine local receipt metadata independently of projection source', () => {
  const p = fixture(vault, '1000000', true),
    c = p.currentCash
  const base = { ...c }
  delete base.sourceKind
  delete base.firstLocalReceiptAt
  delete base.manifestSha256
  delete base.receiptSha256
  const metadata = {
    cashRaw: c.cashRaw,
    block: c.block,
    blockHash: c.blockHash,
    blockAt: c.observedAt,
    asset: c.assetAddress,
    assetDecimals: c.assetDecimals,
    firstLocalReceiptAt: c.firstLocalReceiptAt,
    manifestSha256: c.manifestSha256,
    receiptSha256: c.receiptSha256,
  }
  const bound = workbench.withBoundSampledCashCurrentMetadata(base, metadata)
  assert.equal(bound.sourceKind, 'manifest_bound_ledger')
  assert.equal(bound.firstLocalReceiptAt, c.firstLocalReceiptAt)
  assert.equal(bound.readAtUtc, undefined)
  assert.equal(bound.receiptSha256, c.receiptSha256)
  assert.match(render({ ...p, currentCash: bound }), /Projected cash headroom/)
})
for (const name of [
  'cash',
  'hash',
  'time',
  'block',
  'unverifiedAlias',
  'missingWitness',
  'nativeAsset',
  'nativeUnits',
])
  test(`Workbench never promotes unmatched current metadata for ${name}`, () => {
    const p = fixture(vault, '1000000', true),
      c = p.currentCash,
      base = { ...c }
    delete base.sourceKind
    delete base.firstLocalReceiptAt
    delete base.manifestSha256
    delete base.receiptSha256
    const metadata = {
      cashRaw: c.cashRaw,
      block: c.block,
      blockHash: c.blockHash,
      blockAt: c.observedAt,
      asset: c.assetAddress,
      assetDecimals: c.assetDecimals,
      firstLocalReceiptAt: c.firstLocalReceiptAt,
      manifestSha256: c.manifestSha256,
      receiptSha256: c.receiptSha256,
    }
    if (name === 'cash') metadata.cashRaw = '1'
    if (name === 'hash') metadata.blockHash = `0x${'c'.repeat(64)}`
    if (name === 'time') metadata.blockAt = new Date(now).toISOString()
    if (name === 'block') metadata.block = '1'
    if (name === 'unverifiedAlias') metadata.sourceKind = 'unverified'
    if (name === 'missingWitness') delete metadata.receiptSha256
    if (name === 'nativeAsset') metadata.asset = `0x${'c'.repeat(40)}`
    if (name === 'nativeUnits') metadata.assetDecimals = 18
    assert.equal(workbench.withBoundSampledCashCurrentMetadata(base, metadata), base)
  })

test('Aave sealed-local C2 can pin holder request before live enrichment without projection selfdefaults', () => {
  const p = fixture(aave, '1000000', true)
  assert.deepEqual(
    workbench.matchingHolderForecastSourceReference(
      undefined,
      question(p),
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    ),
    {
      blockNumber: Number(p.currentCash.block),
      blockHash: p.currentCash.blockHash,
      blockTime: p.currentCash.observedAt,
    },
  )
  p.requestedRaw = '2000000'
  assert.equal(
    workbench.matchingHolderForecastSourceReference(
      undefined,
      question(p),
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    ),
    null,
  )
})
test('a supported native atomic cash route pins its own holder execution header', () => {
  const p = fixture()
  assert.deepEqual(
    workbench.matchingHolderForecastSourceReference(
      undefined,
      question(p),
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    ),
    {
      blockNumber: Number(p.currentCash.block),
      blockHash: p.currentCash.blockHash,
      blockTime: p.currentCash.observedAt,
    },
  )
})

test('Workbench binds genuine live native metadata without fabricating a receipt clock', () => {
  const p = withGross(fixture(aave)),
    c = p.currentCash,
    base = { ...c }
  delete base.sourceKind
  delete base.readAtUtc
  const metadata = {
    cashRaw: c.cashRaw,
    block: c.block,
    blockHash: c.blockHash,
    blockAt: c.observedAt,
    asset: c.assetAddress,
    assetDecimals: c.assetDecimals,
    sourceKind: c.sourceKind,
    readAtUtc: c.readAtUtc,
  }
  const bound = workbench.withBoundSampledCashCurrentMetadata(base, metadata)
  assert.equal(bound.sourceKind, 'live_read_only_two_origin_finalized')
  assert.equal(bound.readAtUtc, c.readAtUtc)
  assert.equal(bound.firstLocalReceiptAt, undefined)
  assert.match(render({ ...p, currentCash: bound }), /Projected headroom/)
})
