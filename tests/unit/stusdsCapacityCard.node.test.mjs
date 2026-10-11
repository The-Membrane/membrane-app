import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import card from '../../components/Carry/ExitPressureCard.tsx'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'
import capacity from '../../lib/carry/holderExitCapacity.ts'
import sampled from '../../lib/carry/conditionalSampledCashPathProjection.ts'
import timeline from '../../lib/carry/localHistoricalSampledCashTimeline.ts'
import model from '../../lib/carry/stusdsHistoricalHolderCapacityProjection.ts'
import evidence from '../../lib/carry/stusdsCurrentProtocolCapacityEvidence.ts'
import codec from '../../lib/carry/stusdsProtocolEvidenceCodec.ts'
import pins from '../../lib/carry/stusdsProtocolCapacityHistoryPins.ts'
import { buildSubjectManifest } from '../../scripts/record-carry-cash-issues.mjs'
import {
  verifyLocalCarryCash,
  localCarryCashObservationsFromVerified,
} from '../../scripts/lib/localCarryCashStore.mjs'
const raw = JSON.parse(
  readFileSync(
    'data/research/venue-signals/stusds-historical-capacity-2026-10-07T14-29.json',
    'utf8',
  ),
)
const hash = (s) => createHash('sha256').update(s).digest('hex'),
  now = Date.parse(raw.capturedAt)
const routeKey = 'USDS → StUsds [USDS]',
  destination = '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
  asset = '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  owner = '0x' + 'b'.repeat(40),
  Q = '1000000000000000000'
const source = {
  ...raw.sources[2],
  blockNumber: Number(raw.sources[2].blockNumber),
  finalized: true,
}
const origins = raw.origins.map((host) => {
  const rows = raw.traces.filter((t) => t.anchor === 2 && t.origin === host),
    find = (key) => rows.find((t) => t.key === key)
  return {
    host,
    observation: {
      source: structuredClone(source),
      readAtUtc: raw.capturedAt,
      nativeIdentity: { assetAddress: asset, assetDecimals: 18, shareDecimals: 18 },
      coreRuntimeCodes: {
        proxy: find('code_proxy').response.result,
        asset: find('code_asset').response.result,
      },
      traces: evidence.stusdsProtocolReadPlan(source).map((p) => {
        const t = find(p.key)
        return {
          key: p.key,
          method: t.request.method,
          params: structuredClone(t.request.params),
          result: t.response.result,
        }
      }),
    },
  }
})
const rawProtocol = { origins },
  expected = { source, asOfMs: now, originHosts: raw.origins }
const protocol = codec.encodeStusdsProtocolEvidence(rawProtocol, expected, hash)
assert.ok(protocol)
const current = evidence.replayStusdsCurrentProtocolCapacityEvidence(
  codec.decodeStusdsProtocolEvidence(protocol),
  expected,
  hash,
)
assert.ok(current)
const checked = verifyLocalCarryCash(await buildSubjectManifest()),
  obs = localCarryCashObservationsFromVerified(checked)
const t = timeline.localHistoricalSampledCashTimeline(obs, {
  route_key: routeKey,
  destination,
  asset,
})
assert.equal(t.status, 'sampled_timeline')
const history = sampled.conditionalSampledCashHistoryFromVerifiedTimeline(obs, t)
assert.ok(history)
// Unit-only native bank fixture; protocol capacity uses raw observed global prongs, never this zero bank value.
const cashSource = {
  chainId: 1,
  routeKey,
  destination,
  asset,
  assetDecimals: 18,
  cashRaw: '0',
  block: String(source.blockNumber),
  blockHash: source.blockHash,
  blockTime: source.blockTime,
  readAt: raw.capturedAt,
  sourceKind: 'live_read_only_two_origin_finalized',
}
const cash = sampled.buildConditionalSampledCashPathProjection(
  { history, currentSource: cashSource, request: { requestedRaw: Q, asOf: raw.capturedAt } },
  hash,
)
assert.equal(cash.status, 'estimated')
function props(H = 48) {
  const assessment = {
    status: 'assessed',
    routeKey,
    destinationAddress: destination,
    owner,
    request: { assetsRaw: Q, assetAddress: asset, horizonHours: H },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        assetAddress: asset,
        status: 'reverted',
        relatedToRequest: true,
        amountRaw: Q,
      },
    ],
    finalPayout: { status: 'unassessed', assetAddress: asset, amountRaw: null },
  }
  const quote = capacity.buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: '1000000000000000000000',
      quotedMaxWithdrawRaw: '0',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    now,
  )
  assert.ok(quote)
  const agreement = capacity.agreeHolderExitCapacityQuotes(
    { host: raw.origins[0], quote },
    { host: raw.origins[1], quote },
    now,
  )
  assert.ok(agreement)
  return {
    routeKey,
    destination,
    requestedAmount: '1',
    requestedRaw: Q,
    requestedAssetAddress: asset,
    requestedAssetDecimals: 18,
    requestedAssetSymbol: 'USDS',
    requestedHolderAddress: owner,
    horizonHours: H,
    asOfMs: now,
    currentCash: {
      routeKey,
      destination,
      cashRaw: '0',
      assetAddress: asset,
      assetDecimals: 18,
      assetSymbol: 'USDS',
      observedAt: source.blockTime,
      block: String(source.blockNumber),
      blockHash: source.blockHash,
      freshness: 'fresh',
      label: 'Vault bank',
      sourceKind: cashSource.sourceKind,
      readAtUtc: raw.capturedAt,
    },
    conditionalSampledCashPathProjection: cash,
    holderCapacityAgreement: agreement,
    holderStusdsProtocolCapacityEvidence: protocol,
    holderAssessment: null,
  }
}
const render = (p) =>
  renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(card.ExitPressureCard, p)),
  )
function independentlySelected(p) {
  const accepted = card.selectedStusdsCashForCard(
    p.conditionalSampledCashPathProjection,
    p,
    p.currentCash,
  )
  assert.ok(accepted)
  const input = {
    history: pins.stusdsPinnedProtocolHistory(),
    current,
    capacityAgreement: p.holderCapacityAgreement,
    binding: {
      routeKey,
      destination,
      owner: p.requestedHolderAddress,
      requestedRaw: p.requestedRaw,
      asset,
      assetDecimals: 18,
      currentSource: source,
      asOfMs: p.asOfMs,
    },
    horizonHours: p.horizonHours,
    asOfMs: p.asOfMs,
  }
  const qualify = (c) =>
    evidence.acceptStusdsCurrentProtocolCapacityEvidence(
      c,
      codec.decodeStusdsProtocolEvidence(p.holderStusdsProtocolCapacityEvidence),
      { ...expected, asOfMs: p.asOfMs },
      hash,
    )
  const built = model.buildStusdsHistoricalHolderCapacityProjection(input, qualify)
  assert.ok(built)
  return model.selectedStusdsHistoricalHolderCapacityProjection(built, input, qualify)
}
test('StUSDS source-pin request and native USDS holder row preserve actual target at any H', () => {
  for (const H of [1, 24, 48]) {
    const p = props(H),
      selected = independentlySelected(p),
      future = selected.view.futureScenario
    assert.equal(future.elapsedSeconds, 1152)
    assert.deepEqual(
      workbench.matchingHolderForecastSourceReference(null, p, p.currentCash, cash),
      { blockNumber: source.blockNumber, blockHash: source.blockHash, blockTime: source.blockTime },
    )
    const html = render(p),
      amount =
        card.formatExitPressureSignedRaw(future.headroomLowerRaw[1], 18) +
        '–' +
        card.formatExitPressureSignedRaw(future.headroomUpperRaw[1], 18) +
        ' USDS'
    assert.ok(html.includes('aria-label="Projected exit headroom"'))
    assert.ok(html.includes(amount))
    assert.ok(html.includes(future.targetAt.slice(5, 19).replace('T', ' ') + ' UTC'))
    assert.ok(BigInt(future.capacityLowerRaw[1]) > 0n) // Zero idle bank and zero current M do not become native-capacity ceilings.
  }
})
test('wrong entered owner/Q/source, missing/altered optional evidence and expired clock hide holder row', () => {
  for (const mutate of [
    (p) => {
      p.requestedHolderAddress = '0x' + 'a'.repeat(40)
    },
    (p) => {
      p.requestedRaw = '2'
    },
    (p) => {
      p.currentCash.blockHash = '0x' + 'a'.repeat(64)
    },
    (p) => {
      p.holderStusdsProtocolCapacityEvidence = null
    },
    (p) => {
      p.holderStusdsProtocolCapacityEvidence.origins[1].host =
        p.holderStusdsProtocolCapacityEvidence.origins[0].host
    },
    (p) => {
      p.asOfMs = Date.parse(source.blockTime) + 1800001
    },
  ]) {
    const p = structuredClone(props())
    mutate(p)
    assert.ok(!render(p).includes('aria-label="Projected exit headroom"'))
  }
  assert.equal(
    workbench.holderStusdsProtocolEvidenceFromResponse(
      { stusdsCurrentProtocolCapacityEvidence: protocol },
      200,
    ),
    protocol,
  )
  assert.equal(
    workbench.holderStusdsProtocolEvidenceFromResponse(
      { stusdsCurrentProtocolCapacityEvidence: protocol },
      503,
    ),
    null,
  )
})
test('elapsed analog target is filtered even before current source expires', () => {
  const p = props()
  p.asOfMs = Date.parse(source.blockTime) + 1152001
  const selected = independentlySelected(p)
  assert.equal(selected.view.futureScenario, null)
  assert.ok(!render(p).includes('aria-label="Projected exit headroom"'))
})

test('actual saved-current forecast H1/H24/H48 binds workbench native request to accepted C2', async () => {
  const api = await import('../../pages/api/carry/forecast.ts')
  const { readdirSync } = await import('node:fs')
  const dir = 'data/research/venue-signals/local-carry-cash-v1'
  const receipt = readdirSync(dir)
    .filter((n) => /^\d{12}\.json$/.test(n))
    .map((n) => JSON.parse(readFileSync(dir + '/' + n, 'utf8')))
    .filter((r) => r.collectionMode === 'current')
    .sort((a, b) => b.blockAt.localeCompare(a.blockAt))[0]
  const row = receipt.rows.find((r) => r.routeKey === routeKey)
  const oldNow = Date.now,
    oldFetch = globalThis.fetch,
    oldEnv = process.env.NODE_ENV
  Date.now = () => Date.parse(receipt.firstLocalReceiptAt)
  globalThis.fetch = async () => {
    throw new Error('offline_test_network_forbidden')
  }
  process.env.NODE_ENV = 'development'
  try {
    for (const h of [1, 24, 48]) {
      let body, status
      await (api.carryForecastRequest ?? api.default.carryForecastRequest)(
        {
          method: 'GET',
          query: {
            routeKey,
            destination,
            amountUnits: '1',
            horizonHours: String(h),
            includeLiveCurrent: '0',
          },
          socket: { remoteAddress: '127.0.0.1' },
        },
        {
          setHeader() {},
          status(n) {
            status = n
            return this
          },
          json(v) {
            body = v
            return this
          },
        },
      )
      assert.equal(status, 200)
      const c = body.sampledCashPaths.current
      const current = workbench.withBoundSampledCashCurrentMetadata(
        {
          routeKey,
          destination,
          assetAddress: asset,
          assetDecimals: 18,
          assetSymbol: 'USDS',
          cashRaw: c.cashRaw,
          block: c.block,
          blockHash: c.blockHash,
          observedAt: c.blockAt,
          freshness: 'fresh',
          label: 'Vault cash',
        },
        c,
      )
      const question = {
        routeKey,
        destination,
        requestedRaw: Q,
        requestedAssetAddress: asset,
        requestedAssetDecimals: 18,
        horizonHours: h,
        asOfMs: Date.now(),
      }
      assert.equal(c.cashRaw, row.cashRaw)
      assert.deepEqual(
        workbench.matchingHolderForecastSourceReference(
          null,
          question,
          current,
          body.conditionalSampledCashPathProjection,
        ),
        { blockNumber: Number(c.block), blockHash: c.blockHash, blockTime: c.blockAt },
      )
      assert.equal(
        workbench.matchingHolderForecastSourceReference(
          null,
          { ...question, requestedRaw: '2' },
          current,
          body.conditionalSampledCashPathProjection,
        ),
        null,
      )
    }
  } finally {
    Date.now = oldNow
    globalThis.fetch = oldFetch
    if (oldEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = oldEnv
  }
})

test('capacity-only exact503 permits independently approved StUSDS evidence and native holder rendering', () => {
  const p = props(),
    response = {
      error: 'holder_exit_assessment_unavailable',
      capacityAgreement: p.holderCapacityAgreement,
      stusdsCurrentProtocolCapacityEvidence: p.holderStusdsProtocolCapacityEvidence,
    }
  const selected = workbench.holderStusdsProtocolEvidenceFromResponse(response, 503)
  assert.equal(selected, p.holderStusdsProtocolCapacityEvidence)
  assert.ok(
    render({
      ...p,
      holderAssessment: null,
      holderStusdsProtocolCapacityEvidence: selected,
    }).includes('aria-label="Projected exit headroom"'),
  )
  for (const error of ['rpc_unavailable', 'invalid_request', undefined])
    assert.equal(
      workbench.holderStusdsProtocolEvidenceFromResponse({ ...response, error }, 503),
      null,
    )
  assert.equal(workbench.holderStusdsProtocolEvidenceFromResponse(response, 500), null)
})

test('StUSDS selected-H native issuance keeps original approved evidence clock and genuine issue+H targets', () => {
  for (const H of [1, 24, 48]) {
    const p = props(H),
      body = {
        error: 'holder_exit_assessment_unavailable',
        capacityAgreement: p.holderCapacityAgreement,
        stusdsCurrentProtocolCapacityEvidence: p.holderStusdsProtocolCapacityEvidence,
      }
    p.holderTimeProcessIssue = workbench.holderTimeProcessIssueFromResponse(
      body,
      503,
      p,
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    )
    assert.ok(p.holderTimeProcessIssue)
    const target = new Date(now + H * 3600000).toISOString().slice(5, 19).replace('T', ' ')
    const html = render(p)
    assert.ok(html.includes('aria-label="Selected-horizon conditional StUSDS holder headroom"'))
    assert.ok(html.includes(target + ' UTC'))
    assert.ok(render({ ...p, asOfMs: now + 1000 }).includes(target + ' UTC'))
    assert.equal(p.holderTimeProcessIssue.issuedAtMs, now)
    assert.ok(
      !render({ ...p, asOfMs: Date.parse(source.blockTime) + 1800001 }).includes(
        'Selected-horizon conditional StUSDS holder headroom',
      ),
    )
    assert.ok(
      !render({ ...p, horizonHours: H + 1 }).includes(
        'Selected-horizon conditional StUSDS holder headroom',
      ),
    )
    assert.ok(
      !render({ ...p, requestedHolderAddress: '0x' + 'c'.repeat(40) }).includes(
        'Selected-horizon conditional StUSDS holder headroom',
      ),
    )
  }
})
test('StUSDS timed model expires at selected target and cannot approve later global read under earlier issue', () => {
  const p = props(0.01),
    body = {
      capacityAgreement: p.holderCapacityAgreement,
      stusdsCurrentProtocolCapacityEvidence: p.holderStusdsProtocolCapacityEvidence,
    }
  p.holderTimeProcessIssue = workbench.holderTimeProcessIssueFromResponse(
    body,
    200,
    p,
    p.currentCash,
    p.conditionalSampledCashPathProjection,
  )
  assert.ok(p.holderTimeProcessIssue)
  assert.ok(render(p).includes('Selected-horizon conditional StUSDS holder headroom'))
  assert.ok(
    !render({ ...p, asOfMs: now + 36000 }).includes(
      'Selected-horizon conditional StUSDS holder headroom',
    ),
  )
  const earlier = { ...p, asOfMs: now - 1 }
  assert.equal(
    workbench.holderTimeProcessIssueFromResponse(
      body,
      200,
      earlier,
      p.currentCash,
      p.conditionalSampledCashPathProjection,
    ),
    null,
  )
})
