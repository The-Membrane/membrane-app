import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChakraProvider } from '@chakra-ui/react'
import themeModule from '../../theme/index.ts'
import cardModule from '../../components/Carry/ExitPressureCard.tsx'
import workbenchModule from '../../components/Carry/ForecastWorkbench.tsx'
import bindingModule from '../../lib/carry/susdeHolderForecastBinding.ts'
import modelModule from '../../lib/carry/susdeHolderTimeProcess.ts'
import pinModule from '../../lib/carry/susdeJointHistoryPins.ts'
import evidenceSetModule from '../../lib/carry/susdeJointHistoryEvidenceSet.ts'

const { ExitPressureCard, formatExitPressureSignedRaw } = cardModule
const { holderTimeProcessIssueFromResponse, isMatchingHolderExitAssessment } = workbenchModule
const {
  fetchSusdeHolderForecastResponse,
  holderExitRequestCanPublish,
  selectedSusdeHolderForecast,
  susdeHolderForecastIssueFromResponse,
} = bindingModule
const { buildSusdeHolderTimeProcess, buildSusdeHolderTimeProcessV2 } = modelModule
const { susdePinnedJointHistory } = pinModule
const { susdePinnedJointHistoryEvidenceSet } = evidenceSetModule
const theme = themeModule.default ?? themeModule
const UNIT = 10n ** 18n
const issueAtUtc = '2026-10-08T00:11:00.000Z'
const owner = `0x${'a'.repeat(40)}`
const marker = 'Selected-horizon conditional sUSDe active funding headroom'

function fixture({
  duration = '86400',
  pending = 50n,
  initiation = false,
  vaultCash,
  holder = owner,
  v2 = false,
} = {}) {
  const owner = holder
  const history = v2 ? susdePinnedJointHistoryEvidenceSet() : susdePinnedJointHistory()
  const fixtureIssueAtUtc = v2 ? '2026-10-08T04:16:00.000Z' : issueAtUtc
  const sourceAtUtc = v2 ? '2026-10-08T04:15:00.000Z' : '2026-10-08T00:10:00.000Z'
  const source = {
    chainId: 1,
    blockNumber: '26144000',
    blockHash: `0x${'b'.repeat(64)}`,
    blockTime: sourceAtUtc,
    finalized: true,
  }
  const inputCommon = {
    history,
    requestedRaw: String(10n * UNIT),
    issueAtUtc: fixtureIssueAtUtc,
    analysisMode: 'issue_time_conditional',
    current: {
      owner,
      source,
      readAtUtc: v2 ? '2026-10-08T04:15:45.000Z' : '2026-10-08T00:10:45.000Z',
      captureReceiptSha256: 'c'.repeat(64),
      addresses: history.addresses,
      runtimeIdentities: history.runtimeIdentities,
      assetDecimals: 18,
      activeSharesRaw: String(100n * UNIT),
      activeEntitlementRaw: String(100n * UNIT),
      activeEntitlementMethod: 'preview_redeem_full_active_position',
      maxWithdrawRaw: String(100n * UNIT),
      pendingAssetsRaw: String(pending * UNIT),
      storedCooldownEndUnix: String(Date.parse('2026-10-10T00:00:00.000Z') / 1000),
      cooldownDurationSeconds: duration,
      vaultCashRaw: vaultCash ?? history.rows[3].vaultUsdeRaw,
      siloCashRaw: String(40n * UNIT),
      evidence: { offlineExactFixture: true },
    },
  }
  if (initiation)
    inputCommon.current.successfulExactQInitiation = {
      requestedRaw: inputCommon.requestedRaw,
      owner,
      source,
      receiptSha256: 'd'.repeat(64),
    }
  const currentBytes = JSON.stringify(inputCommon.current)
  const modelsByHorizonHours = Object.fromEntries(
    [1, 24, 48, 168].map((horizonHours) => {
      const built = (v2 ? buildSusdeHolderTimeProcessV2 : buildSusdeHolderTimeProcess)(
        { ...inputCommon, horizonHours },
        (c) => JSON.stringify(c) === currentBytes,
      )
      assert.ok(built)
      const { input: _input, ...output } = built
      return [horizonHours, output]
    }),
  )
  const envelope = {
    schema: v2 ? 'susde_holder_forecast_envelope_v2' : 'susde_holder_forecast_envelope_v1',
    owner,
    originalRequestedRaw: inputCommon.requestedRaw,
    source,
    issueAtUtc: fixtureIssueAtUtc,
    sourceProofValidUntil: modelsByHorizonHours[1].sourceProofValidUntil,
    currentReceiptSha256: inputCommon.current.captureReceiptSha256,
    ...(v2
      ? { evidenceSetSha256: history.evidenceSetSha256 }
      : { historyCaptureSha256: history.captureFileSha256 }),
    supportedHorizonHours: [1, 24, 48, 168],
    inputCommon,
    modelsByHorizonHours,
    executable: false,
    fullHolderAbility: false,
    forecastValidated: false,
    prospectiveValidated: false,
    calibratedProbability: false,
  }
  const question = {
    routeKey: 'USDe → Staked USDe [USDe]',
    destination: history.addresses.vault,
    requestedHolderAddress: owner,
    requestedRaw: inputCommon.requestedRaw,
    requestedAssetAddress: history.addresses.asset,
    requestedAssetDecimals: 18,
    horizonHours: 24,
    asOfMs: Date.parse(fixtureIssueAtUtc),
    source,
  }
  const body = {
    routeKey: question.routeKey,
    destinationAddress: question.destination,
    owner,
    assetsRaw: question.requestedRaw,
    horizonHours: 24,
    chainId: 1,
  }
  const core = {
    status: 'partial',
    routeKey: question.routeKey,
    destinationAddress: question.destination,
    owner,
    request: {
      assetsRaw: question.requestedRaw,
      assetAddress: question.requestedAssetAddress,
      horizonHours: 24,
    },
    source: {
      chainId: 1,
      blockNumber: Number(source.blockNumber),
      blockHash: source.blockHash,
      blockTime: source.blockTime,
      originValidation: 'two_provider',
    },
    finalPayout: {
      assetAddress: question.requestedAssetAddress,
      status: 'unassessed',
      amountRaw: null,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    stages: [
      {
        name: duration === '0' ? 'withdrawal' : 'cooldown_initiation',
        status: duration === '0' || initiation ? 'simulated' : 'reverted',
        assetAddress: question.requestedAssetAddress,
        amountRaw: question.requestedRaw,
        relatedToRequest: true,
      },
      {
        name: 'pending_claim',
        status: 'unassessed',
        assetAddress: question.requestedAssetAddress,
        amountRaw: String(pending * UNIT),
        relatedToRequest: false,
      },
    ],
    cooldownCondition: {
      exitMode: duration === '0' ? 'direct_withdrawal' : 'cooldown',
      durationSeconds: Number(duration),
      initiationStatus: duration === '0' ? 'not_applicable' : initiation ? 'success' : 'evm_revert',
      directWithdrawalStatus: duration === '0' ? 'success' : null,
      pendingClaimStatus: pending > 0n ? 'not_yet_eligible' : 'no_pending_claim',
      pendingAssetsRaw: String(pending * UNIT),
      aggregateSiloUsdeRaw: String(40n * UNIT),
      newRequestWouldResetPending: pending > 0n,
      pendingClaimEarliestAt: null,
      ifInitiatedAtCheckedBlockEarliestAt: null,
    },
  }
  return { envelope, question, body, core }
}

async function admit(
  f,
  responseBody = { ...f.core, susdeHolderForecastEnvelope: f.envelope },
  status = 200,
) {
  const oldFetch = globalThis.fetch,
    oldNow = Date.now
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/carry/holder-exit-assessment')
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.deepEqual(JSON.parse(options.body), f.body)
    return { status, ok: status === 200, json: async () => structuredClone(responseBody) }
  }
  Date.now = () => f.question.asOfMs + 5000
  try {
    return await fetchSusdeHolderForecastResponse(f.body)
  } finally {
    globalThis.fetch = oldFetch
    Date.now = oldNow
  }
}

function props(f, issue) {
  return {
    ...f.question,
    requestedAmount: '10',
    requestedAssetSymbol: 'USDe',
    currentCash: null,
    prospectiveCashModel: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    morphoPayout: null,
    holderTimeProcessIssue: issue,
    holderAssessment: null,
    expectedEventEnrollment: null,
    eventContext: null,
    historicalOutlook: null,
  }
}
function render(p) {
  return renderToStaticMarkup(
    React.createElement(ChakraProvider, { theme }, React.createElement(ExitPressureCard, p)),
  )
}

test('arbitrary JSON, self-sealed envelopes, direct props and copied admitted receipts fail closed', async () => {
  const f = fixture()
  assert.equal(selectedSusdeHolderForecast(f.envelope, f.question), null)
  assert.equal(
    susdeHolderForecastIssueFromResponse(
      { susdeHolderForecastEnvelope: f.envelope },
      200,
      f.question,
    ),
    null,
  )
  assert.ok(
    !render(
      props(f, {
        issuedAtMs: f.question.asOfMs,
        horizonHours: 24,
        owner,
        requestedRaw: f.question.requestedRaw,
        block: f.question.source.blockNumber,
        blockHash: f.question.source.blockHash,
        susdeForecast: f.envelope,
      }),
    ).includes(marker),
  )
  const { result } = await admit(f)
  assert.equal(
    selectedSusdeHolderForecast(structuredClone(result.susdeHolderForecastEnvelope), f.question),
    null,
  )
})

test('owned API receipt binds owner, original Q, USDe18 and every source field without moving issuance', async () => {
  const f = fixture(),
    { result } = await admit(f)
  const e = result.susdeHolderForecastEnvelope
  const selected = selectedSusdeHolderForecast(e, f.question)
  assert.ok(selected)
  assert.ok(Object.isFrozen(selected.input.current))
  assert.equal(selected.input.current, e.inputCommon.current)
  const issue = susdeHolderForecastIssueFromResponse(result, 200, {
    ...f.question,
    asOfMs: f.question.asOfMs + 5000,
  })
  assert.equal(issue.issuedAtMs, Date.parse(issueAtUtc))
  for (const changed of [
    { requestedHolderAddress: `0x${'f'.repeat(40)}` },
    { requestedRaw: String(11n * UNIT) },
    { routeKey: 'other' },
    { destination: `0x${'f'.repeat(40)}` },
    { requestedAssetAddress: `0x${'f'.repeat(40)}` },
    { requestedAssetDecimals: 6 },
    { horizonHours: 2 },
    { asOfMs: Date.parse(e.sourceProofValidUntil) + 1 },
    { asOfMs: f.question.asOfMs - 1 },
  ])
    assert.equal(selectedSusdeHolderForecast(e, { ...f.question, ...changed }), null)
  for (const [key, value] of Object.entries({
    chainId: 2,
    blockNumber: '26144001',
    blockHash: `0x${'f'.repeat(64)}`,
    blockTime: '2026-10-08T00:10:01.000Z',
    finalized: false,
  })) {
    assert.equal(
      selectedSusdeHolderForecast(e, {
        ...f.question,
        source: { ...f.question.source, [key]: value },
      }),
      null,
    )
  }
  const later = selectedSusdeHolderForecast(e, { ...f.question, asOfMs: f.question.asOfMs + 1000 })
  assert.equal(later, selected)
  assert.equal(later.targetAtUtc, selected.targetAtUtc)
})

test('actual card switches every issued H without generic capacity, preserves target, and expires', async () => {
  const f = fixture(),
    { result } = await admit(f)
  const issue = susdeHolderForecastIssueFromResponse(result, 200, f.question)
  for (const horizonHours of [1, 24, 48, 168]) {
    const model = selectedSusdeHolderForecast(issue.susdeForecast, { ...f.question, horizonHours })
    const p = { ...props(f, issue), horizonHours }
    const html = render(p)
    assert.ok(html.includes(marker))
    assert.ok(
      html.includes(
        `${formatExitPressureSignedRaw(model.active.funding.targetSummary.empiricalP10HeadroomRaw, 18)}–${formatExitPressureSignedRaw(model.active.funding.targetSummary.empiricalP90HeadroomRaw, 18)} USDe`,
      ),
    )
    assert.ok(html.includes(model.targetAtUtc.slice(5, 16).replace('T', ' ')))
    assert.ok(
      render({ ...p, asOfMs: p.asOfMs + 1000 }).includes(
        model.targetAtUtc.slice(5, 16).replace('T', ' '),
      ),
    )
    assert.ok(
      !render({ ...p, asOfMs: Date.parse(model.sourceProofValidUntil) + 1 }).includes(marker),
    )
  }
  assert.ok(!render({ ...props(f, issue), requestedRaw: '1' }).includes(marker))
  assert.ok(
    !render({ ...props(f, issue), requestedHolderAddress: `0x${'f'.repeat(40)}` }).includes(marker),
  )
  assert.ok(
    !render({
      ...props(f, issue),
      holderTimeProcessIssue: { ...issue, issuedAtMs: issue.issuedAtMs + 1 },
    }).includes(marker),
  )
  assert.ok(
    !render({
      ...props(f, issue),
      currentCash: {
        routeKey: f.question.routeKey,
        destination: f.question.destination,
        block: '26144001',
        blockHash: f.question.source.blockHash,
        observedAt: f.question.source.blockTime,
      },
    }).includes(marker),
  )
})

test('actual card renders admitted v2 at all four horizons with 22 paired donors', async () => {
  const f = fixture({ v2: true }),
    { result } = await admit(f)
  const issue = susdeHolderForecastIssueFromResponse(result, 200, f.question)
  assert.ok(issue)
  for (const horizonHours of [1, 24, 48, 168]) {
    const model = selectedSusdeHolderForecast(issue.susdeForecast, { ...f.question, horizonHours })
    assert.equal(model.metadata.donorCount, 22)
    assert.equal(model.active.funding.scenarios.length, 22)
    assert.equal(model.input.history.rows.length, 24)
    const html = render({ ...props(f, issue), horizonHours })
    assert.ok(html.includes(marker))
    assert.ok(
      html.includes(
        `${formatExitPressureSignedRaw(model.active.funding.targetSummary.empiricalP10HeadroomRaw, 18)}–${formatExitPressureSignedRaw(model.active.funding.targetSummary.empiricalP90HeadroomRaw, 18)} USDe`,
      ),
    )
    assert.ok(html.includes(model.targetAtUtc.slice(5, 16).replace('T', ' ')))
    assert.ok(
      !render({
        ...props(f, issue),
        horizonHours,
        asOfMs: Date.parse(model.sourceProofValidUntil) + 1,
      }).includes(marker),
    )
  }
})

test('M != Q, pending zero, duration zero and checked new Q retain distinct queue semantics in the card', async () => {
  for (const options of [{}, { pending: 0n }, { duration: '0' }, { initiation: true }]) {
    const f = fixture(options),
      { result } = await admit(f)
    const issue = susdeHolderForecastIssueFromResponse(result, 200, f.question)
    const model = selectedSusdeHolderForecast(issue.susdeForecast, f.question)
    const html = render(props(f, issue))
    assert.equal(model.active.fullActiveEntitlementRaw, String(100n * UNIT))
    assert.equal(model.originalRequestedRaw, String(10n * UNIT))
    assert.equal(model.pending.effectiveWholePayoutRaw, String((options.pending ?? 50n) * UNIT))
    assert.equal(html.includes('Existing queue · whole claim'), options.pending !== 0n)
    if (options.duration === '0') {
      assert.ok(html.includes('ELIGIBLE BY TARGET'))
      assert.equal(model.newCooldown, null)
    } else if (options.pending !== 0n) assert.ok(html.includes('COOLDOWN BEYOND TARGET'))
    assert.equal(html.includes('New cooldown · whole claim'), !!options.initiation)
    if (options.initiation) {
      assert.equal(model.newCooldown.effectiveWholePayoutRaw, String(60n * UNIT))
      assert.equal(model.newCooldown.postInitiation.activeEntitlementRaw, null)
      assert.equal(
        model.newCooldown.postInitiation.activeEntitlementUpperBoundRaw,
        String(90n * UNIT),
      )
      assert.ok(html.includes('IF STARTED 2026-10-08 00:10 UTC → END 2026-10-09 00:10 UTC'))
    }
    assert.equal(model.executable, false)
    assert.equal(model.fullHolderAbility, false)
  }
})

test('shrinking active funding renders the native band and sampled shortfall status', async () => {
  const f = fixture({ vaultCash: String(12n * UNIT) })
  const { result } = await admit(f)
  const issue = susdeHolderForecastIssueFromResponse(result, 200, f.question)
  const model = selectedSusdeHolderForecast(issue.susdeForecast, f.question)
  const html = render(props(f, issue))
  assert.equal(model.active.funding.targetSummary.minimumHeadroomRaw, String(-10n * UNIT))
  assert.ok(html.includes('FUNDING THINS'))
  assert.ok(html.includes('SHORTFALL'))
  assert.equal(model.active.instantaneousFinalAssetExitAssessed, false)
})

test('optional native failure leaves the core response usable and no conditional forecast admitted', async () => {
  const f = fixture()
  const core = { assessment: { status: 'unchanged_core' } }
  const { response, result } = await admit(f, core)
  assert.equal(response.ok, true)
  assert.deepEqual(result, core)
  assert.equal(susdeHolderForecastIssueFromResponse(result, 200, f.question), null)
  const malformed = structuredClone(f.envelope)
  malformed.modelsByHorizonHours[24].issueAtUtc = '2026-10-08T00:12:00.000Z'
  const bad = await admit(f, { ...core, susdeHolderForecastEnvelope: malformed })
  assert.equal(bad.response.ok, true)
  assert.equal(susdeHolderForecastIssueFromResponse(bad.result, 200, f.question), null)
})

test('actual fetch and Workbench issue reject malformed core and different core source without current cash', async () => {
  const f = fixture()
  const request = { ...f.body, payoutAsset: f.question.requestedAssetAddress, kind: 'susde' }
  const issue = (result, independent = null) =>
    holderTimeProcessIssueFromResponse(result, 200, f.question, null, null, independent)
  const admitted = await admit(f)
  assert.ok(isMatchingHolderExitAssessment(admitted.result, request))
  assert.ok(issue(admitted.result))
  assert.equal(
    issue(admitted.result, {
      blockNumber: 26144001,
      blockHash: f.question.source.blockHash,
      blockTime: f.question.source.blockTime,
    }),
    null,
  )
  for (const alter of [
    (core) => {
      delete core.forecast
    },
    (core) => {
      core.cooldownCondition.initiationStatus = 'malformed'
    },
    (core) => {
      core.request.assetsRaw = '1'
    },
    (core) => {
      core.source.blockNumber += 1
    },
    (core) => {
      core.source.blockHash = `0x${'f'.repeat(64)}`
    },
    (core) => {
      core.source.blockTime = '2026-10-08T00:10:01.000Z'
    },
    (core) => {
      core.source.chainId = 2
    },
    (core) => {
      core.source.finalized = false
    },
  ]) {
    const response = { ...structuredClone(f.core), susdeHolderForecastEnvelope: f.envelope }
    alter(response)
    const { result } = await admit(f, response)
    assert.equal(issue(result), null)
    assert.ok(!render(props(f, issue(result))).includes(marker))
  }
})

test('failed refresh clears current issuance; stale or aborted request cannot erase a newer question', async () => {
  const f = fixture(),
    valid = await admit(f)
  const oldIssue = holderTimeProcessIssueFromResponse(valid.result, 200, f.question, null, null)
  let displayed = oldIssue
  const refresh = new AbortController()
  let activeRequest = refresh
  const malformed = await admit(f, {
    ...f.core,
    stages: [],
    susdeHolderForecastEnvelope: f.envelope,
  })
  assert.equal(
    holderTimeProcessIssueFromResponse(malformed.result, 200, f.question, null, null),
    null,
  )
  if (holderExitRequestCanPublish(refresh, activeRequest)) displayed = null
  assert.equal(displayed, null)
  assert.ok(!render(props(f, displayed)).includes(marker))

  const newer = fixture({ holder: `0x${'d'.repeat(40)}` }),
    fetched = await admit(newer)
  const freshRequest = new AbortController()
  activeRequest = freshRequest
  displayed = holderTimeProcessIssueFromResponse(fetched.result, 200, newer.question, null, null)
  assert.ok(displayed)
  const newIssue = displayed
  if (holderExitRequestCanPublish(refresh, activeRequest)) displayed = null
  assert.equal(displayed, newIssue)
  assert.ok(render(props(newer, displayed)).includes(marker))
  refresh.abort()
  assert.equal(holderExitRequestCanPublish(refresh, refresh), false)
  assert.equal(holderExitRequestCanPublish(refresh, activeRequest), false)
})
