import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'

import cardModule from '../../components/Carry/ExitPressureCard.tsx'
import workbenchModule from '../../components/Carry/ForecastWorkbench.tsx'

const { ExitPressureCard, selectedProspectiveCashModel } = cardModule
const {
  loadRouteForecastWithLiveCurrent,
  matchingRouteForecastResponse,
  sanitizeProspectiveCashModel,
  sanitizeLocalCarryExitV2Evidence,
} = workbenchModule

const routeKey = 'USDC → supply on Aave V3'
const destination = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c'
const asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const question = {
  routeKey,
  destination,
  amountUnits: '100000',
  horizonHours: 24,
  payoutAsset: asset,
}

function activeIssue() {
  return {
    issuedAtUtc: '2026-10-05T12:05:00.000Z',
    sourceAtUtc: '2026-10-05T12:00:00.000Z',
    targetAtUtc: '2026-10-06T12:00:00.000Z',
    targetLowUtc: '2026-10-06T11:00:00.000Z',
    targetHighUtc: '2026-10-06T13:00:00.000Z',
    outcomeDueByUtc: '2026-10-06T14:00:00.000Z',
    projection: {
      sourceCashRaw: '1234567',
      pointRaw: '1234567',
      lowRaw: '1000001',
      highRaw: '1500009',
      persistenceRaw: '1234567',
    },
  }
}

function prospectiveModel(status = 'collecting') {
  const validated = status === 'validated'
  return {
    status,
    routeKey,
    destination,
    asset,
    horizonHours: 24,
    claim: 'aggregate_cash_proxy_only',
    holderExecutableExit: false,
    prospectiveValidated: validated,
    schedule: { scheduled: 4, onTime: 4, missed: 0, coveragePercent: 100, current: true },
    outcome: { issued: 3, observed: 2, censored: 0, pending: 1, availabilityPercent: 67 },
    interval: { observed: 2, covered: 1, missed: 1, coveragePercent: 50 },
    source: {
      opportunities: 4,
      available: 3,
      unavailable: 1,
      ineligible: 0,
      unassessed: 0,
      availabilityPercent: 75,
    },
    latestActiveIssue: activeIssue(),
  }
}

function routeResponse(model) {
  return {
    routeKey,
    destination,
    source: 'prospective_finalized_observations',
    forecast: {
      claim: 'aggregate_cash_proxy_only',
      amountUnits: 100000,
      horizonHours: 24,
    },
    prospectiveCashModel: model,
  }
}

function unavailableModel() {
  return {
    status: 'unavailable',
    routeKey,
    destination,
    asset,
    horizonHours: 24,
    claim: 'aggregate_cash_proxy_only',
    holderExecutableExit: false,
    prospectiveValidated: false,
    schedule: null,
    outcome: null,
    interval: null,
    source: null,
    latestActiveIssue: null,
    reason: 'prospective_ledger_unavailable',
  }
}

function render(model, overrides = {}) {
  const props = {
    routeKey,
    destination,
    requestedAmount: '100000',
    requestedRaw: '100000000000',
    requestedAssetSymbol: 'USDC',
    requestedAssetAddress: asset,
    requestedAssetDecimals: 6,
    horizonHours: 24,
    asOfMs: Date.parse('2026-10-05T13:00:00.000Z'),
    currentCash: null,
    prospectiveCashModel: model,
    historicalBacktest: null,
    historicalScenario: null,
    grossWithdrawals: null,
    grossInflows: null,
    historicalGrossFlow: null,
    historicalMarketGrossFlow: null,
    morphoPayout: null,
    holderAssessment: null,
    expectedEventEnrollment: null,
    eventContext: null,
    historicalOutlook: null,
    ...overrides,
  }
  return renderToStaticMarkup(
    React.createElement(ChakraProvider, null, React.createElement(ExitPressureCard, props)),
  ).replaceAll(/<style[\s\S]*?<\/style>/g, '')
}

test('sanitizes an exact prospective model without changing its typed state', () => {
  const model = prospectiveModel()
  assert.equal(sanitizeProspectiveCashModel(model, question), model)
  assert.equal(sanitizeProspectiveCashModel(unavailableModel(), question).status, 'unavailable')
})

test('keeps the route response while cross-identity prospective evidence becomes unavailable', () => {
  const crossIdentity = prospectiveModel()
  crossIdentity.destination = `0x${'f'.repeat(40)}`

  const matched = matchingRouteForecastResponse(routeResponse(crossIdentity), question)
  assert.ok(matched)
  assert.equal(matched.forecast.amountUnits, 100000)
  assert.deepEqual(matched.prospectiveCashModel, {
    ...unavailableModel(),
    reason: 'invalid_response',
  })
})

test('downgrades malformed counts, percentages, raw values, clocks, bounds, and state pairs', () => {
  const cases = [
    [
      'count arithmetic',
      (model) => {
        model.schedule.missed = 1
      },
    ],
    [
      'percentage',
      (model) => {
        model.interval.coveragePercent = 101
      },
    ],
    [
      'raw value',
      (model) => {
        model.latestActiveIssue.projection.pointRaw = '01'
      },
    ],
    [
      'UTC',
      (model) => {
        model.latestActiveIssue.targetAtUtc = '2026-10-06T12:00:00Z'
      },
    ],
    [
      'issue bounds',
      (model) => {
        model.latestActiveIssue.targetLowUtc = '2026-10-06T12:30:00.000Z'
      },
    ],
    [
      'state pair',
      (model) => {
        model.status = 'validated'
      },
    ],
    [
      'validated stale schedule',
      (model) => {
        model.status = 'validated'
        model.prospectiveValidated = true
        model.schedule.current = false
      },
    ],
  ]

  for (const [label, mutate] of cases) {
    const model = prospectiveModel()
    mutate(model)
    const sanitized = sanitizeProspectiveCashModel(model, question)
    assert.equal(sanitized.status, 'unavailable', label)
    assert.equal(sanitized.reason, 'invalid_response', label)
  }
})

test('preserves exact model evidence when the ordinary forecast is unavailable', async () => {
  const model = prospectiveModel()
  const delivered = []
  const live = await loadRouteForecastWithLiveCurrent(
    question,
    new AbortController().signal,
    (archive) => delivered.push(archive),
    async () => ({
      ok: true,
      json: async () => ({
        status: 'unavailable',
        reason: 'no_prospective_samples',
        prospectiveCashModel: model,
      }),
    }),
  )

  assert.equal(live, null)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].status, 'unavailable')
  assert.equal(delivered[0].reason, 'no_prospective_samples')
  assert.equal(delivered[0].prospectiveCashModel, model)
})

test('rechecks route, destination, requested asset, and horizon at the card boundary', () => {
  const model = prospectiveModel()
  assert.equal(selectedProspectiveCashModel(model, routeKey, destination, asset, 24), model)
  assert.equal(selectedProspectiveCashModel(model, 'another route', destination, asset, 24), null)
  assert.equal(
    selectedProspectiveCashModel(model, routeKey, `0x${'d'.repeat(40)}`, asset, 24),
    null,
  )
  assert.equal(
    selectedProspectiveCashModel(model, routeKey, destination, `0x${'e'.repeat(40)}`, 24),
    null,
  )
  assert.equal(selectedProspectiveCashModel(model, routeKey, destination, asset, 1), null)
})

test('renders collecting evidence and its active band at the requested asset decimals', () => {
  const html = render(prospectiveModel())

  assert.match(html, /data-testid="exit-pressure-prospective-cash"/)
  assert.match(html, /data-state="collecting"/)
  assert.match(html, /PROSPECTIVE CASH MODEL · COLLECTING/)
  assert.match(html, /SCHEDULE 4\/4 · OUTCOMES 2\/3 · INTERVAL 1\/2 · SOURCE 3\/4/)
  assert.match(html, /TARGET 2026-10-06 12:00 UTC/)
  assert.match(html, /1\.234567 USDC/)
  assert.match(html, /1\.000001–1\.500009 USDC/)
  assert.equal((html.match(/AGGREGATE CASH · NOT HOLDER EXECUTION/g) ?? []).length, 1)
  assert.doesNotMatch(html, /Current holder check/)
})

test('hides unavailable evidence and values after the target window closes', () => {
  const unavailableHtml = render(unavailableModel())
  assert.doesNotMatch(unavailableHtml, /exit-pressure-prospective-cash/)
  assert.doesNotMatch(unavailableHtml, /AGGREGATE CASH · NOT HOLDER EXECUTION/)

  const expiredHtml = render(prospectiveModel(), {
    asOfMs: Date.parse('2026-10-06T13:00:00.001Z'),
  })
  assert.match(expiredHtml, /PROSPECTIVE CASH MODEL · COLLECTING/)
  assert.doesNotMatch(expiredHtml, /Active cash point/)
  assert.doesNotMatch(expiredHtml, /TARGET 2026-10-06/)
})

test('renders validated evidence as a distinct success state', () => {
  const html = render(prospectiveModel('validated'))
  assert.match(html, /data-state="validated"/)
  assert.match(html, /PROSPECTIVE CASH MODEL · VALIDATED/)
})

function localExactQ(status = 'collecting') {
  return {
    status,
    routeKey,
    destination,
    asset,
    decimals: 6,
    assetsRaw: '100000000000',
    horizonH: 24,
    claim: 'local_exact_q_observation_only',
    provenance: 'local_operator_clock',
    independentTimestamp: false,
    independentWitness: false,
    externalMonotonicCheckpoint: false,
    rollbackProof: false,
    minedPayoutProven: false,
    prospectiveValidated: false,
    forecastValidated: false,
    holderExecutableExit: false,
    calibratedForecast: false,
    measurementValidatorId:
      status === 'collecting' ? 'carry-exit-v2-trusted-source-registry-v1' : null,
    evidence:
      status === 'collecting'
        ? {
            issued: 3,
            pending: 1,
            recordedUnverified: 1,
            measured: 0,
            missing: 0,
            censored: 0,
            unavailable: 1,
            due: 1,
            localReadbacks: 2,
            latest: {
              targetAtUtc: '2026-10-06T12:00:00.000Z',
              deadlineAtUtc: '2026-10-06T14:00:00.000Z',
              status: 'pending',
              due: false,
              localReadback: true,
            },
          }
        : null,
    reason: 'no_exact_subject',
  }
}

test('local exact Q sanitizer strips unknown fields and private evidence recursively', () => {
  const input = localExactQ()
  input.holder = 'private holder'
  input.issueId = 'private issue'
  input.evidence.proofs = ['private proof']
  input.evidence.latest.witnessId = 'private witness'
  const output = sanitizeLocalCarryExitV2Evidence(input, { ...question, payoutAssetDecimals: 6 })
  assert.equal(output.status, 'collecting')
  assert.equal(output.evidence.pending, 1)
  assert.equal(output.forecastValidated, false)
  assert.equal(output.holderExecutableExit, false)
  assert.doesNotMatch(JSON.stringify(output), /private|holder"|issueId|proofs|witnessId|reason/)
})

test('local exact Q sanitizer rejects mismatched amount, subject, counts, dates, and claims', () => {
  const mutations = [
    (v) => {
      v.assetsRaw = '1'
    },
    (v) => {
      v.routeKey = 'another route'
    },
    (v) => {
      v.destination = asset
    },
    (v) => {
      v.asset = destination
    },
    (v) => {
      v.decimals = 18
    },
    (v) => {
      v.horizonH = 1
    },
    (v) => {
      v.forecastValidated = true
    },
    (v) => {
      v.independentWitness = true
    },
    (v) => {
      v.measurementValidatorId = 'user-chosen-validator'
    },
    (v) => {
      v.evidence.issued = 4
    },
    (v) => {
      v.evidence.measured = -1
    },
    (v) => {
      v.evidence.pending = 0.5
    },
    (v) => {
      v.evidence.due = 4
    },
    (v) => {
      v.evidence.latest.status = 'validated'
    },
    (v) => {
      v.evidence.latest.targetAtUtc = 'bad date'
    },
    (v) => {
      v.evidence.latest.deadlineAtUtc = '2020-01-01T00:00:00.000Z'
    },
  ]
  for (const mutate of mutations) {
    const v = localExactQ()
    mutate(v)
    assert.equal(sanitizeLocalCarryExitV2Evidence(v, { ...question, payoutAssetDecimals: 6 }), null)
  }
})

test('local exact Q evidence survives a top-level forecast abstention', async () => {
  const delivered = []
  const controller = new AbortController()
  await loadRouteForecastWithLiveCurrent(
    question,
    controller.signal,
    (v) => delivered.push(v),
    async () => ({
      ok: true,
      json: async () => ({
        status: 'unavailable',
        reason: 'no_current_issue',
        prospectiveCashModel: unavailableModel(),
        localCarryExitV2Evidence: localExactQ(),
      }),
    }),
  )
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].status, 'unavailable')
  assert.equal(delivered[0].localCarryExitV2Evidence.status, 'collecting')
})

test('local Q observations render compact collecting and unavailable states without validation claims', () => {
  const collecting = render(null, {
    localCarryExitV2Evidence: sanitizeLocalCarryExitV2Evidence(localExactQ(), question),
  })
  assert.match(collecting, /data-testid="exit-pressure-local-exact-q"/)
  assert.match(collecting, /LOCAL Q OBSERVATIONS · COLLECTING/)
  assert.match(collecting, /ISSUED 3 · PENDING 1 · MEASURED 0 · UNVERIFIED 1 · UNAVAILABLE 1/)
  assert.doesNotMatch(collecting, /VALIDATED|private/)
  const unavailable = render(null, {
    localCarryExitV2Evidence: sanitizeLocalCarryExitV2Evidence(
      localExactQ('unavailable'),
      question,
    ),
  })
  assert.match(unavailable, /LOCAL Q OBSERVATIONS · UNAVAILABLE/)
  assert.doesNotMatch(unavailable, /ISSUED|VALIDATED|no_exact_subject/)
  const changedAmount = render(null, {
    requestedRaw: '1',
    localCarryExitV2Evidence: sanitizeLocalCarryExitV2Evidence(localExactQ(), question),
  })
  assert.doesNotMatch(changedAmount, /exit-pressure-local-exact-q/)
  const changedUnavailableAmount = render(null, {
    requestedRaw: '1',
    localCarryExitV2Evidence: sanitizeLocalCarryExitV2Evidence(
      localExactQ('unavailable'),
      question,
    ),
  })
  assert.doesNotMatch(changedUnavailableAmount, /exit-pressure-local-exact-q/)
})

test('route response strips local Q private fields while preserving other models', () => {
  const input = routeResponse(prospectiveModel())
  input.localCarryExitV2Evidence = localExactQ()
  input.localCarryExitV2Evidence.evidence.latest.proof = 'secret'
  const output = matchingRouteForecastResponse(input, question)
  assert.equal(output.prospectiveCashModel, input.prospectiveCashModel)
  assert.equal(output.localCarryExitV2Evidence.evidence.latest.proof, undefined)
  assert.equal(matchingRouteForecastResponse(output, question), output)
})

test('unavailable local Q remains scoped to the requested amount and strips the reason', () => {
  const value = localExactQ('unavailable')
  value.reason = 'private internal failure'
  const clean = sanitizeLocalCarryExitV2Evidence(value, { ...question, payoutAssetDecimals: 6 })
  assert.equal(clean.status, 'unavailable')
  assert.equal(clean.reason, undefined)
  assert.equal(
    matchingRouteForecastResponse(
      { ...routeResponse(prospectiveModel()), localCarryExitV2Evidence: clean },
      question,
    ).localCarryExitV2Evidence.status,
    'unavailable',
  )
  value.assetsRaw = '1'
  assert.equal(sanitizeLocalCarryExitV2Evidence(value, question), null)
})

test('local Q observations request refresh after the deadline without claiming a missing outcome', () => {
  const evidence = sanitizeLocalCarryExitV2Evidence(localExactQ(), question)
  const before = render(null, {
    localCarryExitV2Evidence: evidence,
    asOfMs: Date.parse('2026-10-06T13:59:59.000Z'),
  })
  assert.match(before, /PENDING 1/)
  const after = render(null, {
    localCarryExitV2Evidence: evidence,
    asOfMs: Date.parse('2026-10-06T14:00:01.000Z'),
  })
  assert.match(after, /data-state="refresh_due"/)
  assert.match(after, /LOCAL Q OBSERVATIONS · REFRESH DUE/)
  assert.doesNotMatch(after, /PENDING|COLLECTING/)
  assert.match(after, /MISSING 0/)
})

test('local Q sanitizer rejects contradictory latest due and readback counts', () => {
  const due = localExactQ()
  due.evidence.latest.due = true
  due.evidence.due = 0
  assert.equal(sanitizeLocalCarryExitV2Evidence(due, question), null)
  const readback = localExactQ()
  readback.evidence.localReadbacks = 0
  assert.equal(sanitizeLocalCarryExitV2Evidence(readback, question), null)
  for (const status of ['measured', 'recorded_unverified']) {
    const value = localExactQ()
    value.evidence.latest.status = status
    value.evidence.latest.localReadback = false
    if (status === 'measured') {
      value.evidence.measured = 1
      value.evidence.recordedUnverified = 0
    }
    assert.equal(sanitizeLocalCarryExitV2Evidence(value, question), null)
  }
})
