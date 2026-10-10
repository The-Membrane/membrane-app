import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import priorModule from '../../lib/carry/venueForecastAnalogPrior.ts'
import presentation from '../../lib/carry/analogCashScenarioPresentation.ts'
import card from '../../components/Carry/ExitPressureCard.tsx'
import workbench from '../../components/Carry/ForecastWorkbench.tsx'

const hash = (s) => createHash('sha256').update(s).digest('hex')
const now = Date.parse('2026-10-08T12:00:00.000Z')
const histories = Object.values(JSON.parse(readFileSync(
  'data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json', 'utf8',
)).histories)
const history = histories.find((h) => h.identity.routeKey === 'AUSD → VaultV2 [AUSD]')
const identity = {
  routeKey: 'USDC → VaultV2 [USDC]', destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', assetDecimals: 6,
}
const profile = (id) => ({ identity: id, mechanismFamily: 'allocated_vault', cashMeaning: 'unallocated_vault_cash',
  assetRiskClass: 'stable', mechanismVersion: 'morpho_v2_idle_underlying_balance_v1', reviewedProfileRef: 'independent-server-issue-fixture' })
const source = (id) => ({ ...id, chainId: 1, cashRaw: '1000000', block: '26190000', blockHash: `0x${'a'.repeat(64)}`,
  blockTime: new Date(now - 1000).toISOString(), readAt: new Date(now).toISOString(), sourceKind: 'live_read_only_two_origin_finalized' })
function fixture() {
  const input = {
    currentProfile: profile(identity), currentSource: source(identity), requestedRaw: '900000',
    issueAtUtc: new Date(now).toISOString(), horizonHours: 1, maxHistoricalGapSeconds: 91800,
    donors: [{ profile: profile(history.identity), history: structuredClone(history), verificationSource: source(history.identity),
      verificationAtUtc: new Date(now).toISOString(), nativeUnitMap: {
        donorAsset: history.identity.asset, donorDecimals: 6, currentAsset: identity.asset, currentDecimals: 6,
        normalization: 'dimensionless_net_delta_over_donor_cash_before',
      } }],
  }
  // Presentation fixture models an externally issued plan. These comparisons
  // grant no production provenance; the server boundary has separate API tests.
  const approved = structuredClone(input)
  const prior = priorModule.buildVenueForecastAnalogPrior(input, hash, {
    current: (candidate) => JSON.stringify(candidate) === JSON.stringify(approved),
    donor: (candidate) => JSON.stringify(candidate) === JSON.stringify(approved.donors[0]),
  })
  assert.ok(prior)
  const value = { status: 'analog_cash_scenario', claim: 'conditional_analog_native_cash_only', Ea: null,
    prior, issuedInput: structuredClone(input), currentSource: structuredClone(input.currentSource),
    donorSelection: { eligibleDonors: 1, selectedDonors: 1, limit: 16, method: 'exact_asset_then_subject_key' },
    historicalExtremesAreConfidenceBands: false, holderExecutableExit: false, forecastValidated: false }
  const issue = presentation.snapshotAnalogCashScenarioIssue(value)
  const question = { routeKey: identity.routeKey, destination: identity.destination, amountUnits: '0.9',
    horizonHours: 1, payoutAsset: identity.asset, payoutAssetDecimals: 6 }
  return {
    routeKey: identity.routeKey, destination: identity.destination, requestedAmount: '0.9', requestedRaw: '900000',
    requestedAssetSymbol: 'USDC', requestedAssetAddress: identity.asset, requestedAssetDecimals: 6,
    horizonHours: 1, asOfMs: now, analogCashScenario: value, analogCashIssue: issue,
    currentCash: workbench.analogCashCurrentForWorkbench(issue, question, 'USDC', now),
    conditionalSampledCashPathProjection: { status: 'unavailable', reason: 'insufficient_eligible_history' },
    prospectiveCashModel: null, historicalScenario: null, grossWithdrawals: null, grossInflows: null,
    historicalGrossFlow: null, morphoPayout: null, holderAssessment: null,
    expectedEventEnrollment: null, eventContext: null, historicalOutlook: null,
  }
}
const render = (p) => renderToStaticMarkup(React.createElement(ChakraProvider, null,
  React.createElement(card.ExitPressureCard, p))).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const select = (p) => card.selectedAnalogCashForCard(p.analogCashScenario, p.analogCashIssue, p, p.currentCash)

test('actual Card renders native analog cash ranges and signed Q headroom as cash only', () => {
  const p = fixture(), html = render(p), prior = p.analogCashScenario.prior
  assert.match(html, /ANALOG CASH · CASH ONLY/)
  assert.match(html, /Cash at target/); assert.match(html, /Cash headroom/)
  assert.match(html, /SCENARIO RANGE · 1 donor/); assert.match(html, /SAMPLED/)
  const expected = `${card.formatExitPressureSignedRaw(prior.targetCashHeadroomRange.minimumRaw, 6)}–${card.formatExitPressureSignedRaw(prior.targetCashHeadroomRange.maximumRaw, 6)} USDC`
  assert.ok(html.includes(expected))
  assert.doesNotMatch(html, /Projected exit headroom|confidence interval|% accurate/i)
  assert.equal(p.analogCashScenario.Ea, null)
  assert.ok(Object.isFrozen(p.analogCashIssue.input.donors))
})
for (const [name, mutate] of [
  ['route', (p) => { p.routeKey += ' other' }],
  ['destination', (p) => { p.destination = `0x${'1'.repeat(40)}` }],
  ['asset', (p) => { p.requestedAssetAddress = `0x${'2'.repeat(40)}` }],
  ['decimals', (p) => { p.requestedAssetDecimals = 18 }],
  ['Q', (p) => { p.requestedRaw = '900001' }],
  ['horizon', (p) => { p.horizonHours = 24 }],
  ['hash', (p) => { p.currentCash.blockHash = `0x${'3'.repeat(64)}` }],
  ['clock', (p) => { p.currentCash.readAtUtc = new Date(now - 1).toISOString() }],
  ['cash', (p) => { p.currentCash.cashRaw = '1000001' }],
  ['prior arithmetic', (p) => { p.analogCashScenario.prior.targetCashHeadroomRange.maximumRaw = '999999999' }],
  ['proof expiry', (p) => { p.asOfMs = now + 1800000 }],
  ['before issue', (p) => { p.asOfMs = now - 1 }],
  ['holder claim', (p) => { p.analogCashScenario.Ea = '1000000' }],
  ['validation claim', (p) => { p.analogCashScenario.forecastValidated = true }],
  ['unqualified', (p) => { p.analogCashScenario = { status: 'unqualified', reason: 'source_stale', Ea: null } }],
]) test(`binding rejects ${name}`, () => { const p = fixture(); mutate(p); assert.equal(select(p), null) })

test('actual Card hides analog on native availability, source conflict and initial-deposit mode', () => {
  for (const extra of [
    { conditionalSampledCashPathProjection: { status: 'estimated' } },
    { analogCashSourceConflict: true },
    { scenarioMode: 'initial_deposit', depositAmount: '1' },
  ]) assert.doesNotMatch(render({ ...fixture(), ...extra }), /ANALOG CASH · CASH ONLY/)
})
test('Workbench maps only matching issued source and preserves broad live eligibility', () => {
  const p = fixture(), q = { routeKey: p.routeKey, destination: p.destination, amountUnits: '0.9',
    horizonHours: 1, payoutAsset: p.requestedAssetAddress, payoutAssetDecimals: 6 }
  assert.equal(workbench.analogCashCurrentForWorkbench(p.analogCashIssue, { ...q, amountUnits: '1' }, 'USDC', now), null)
  assert.equal(workbench.analogCashCurrentForWorkbench(p.analogCashIssue, q, 'USDC', now + 1800000), null)
  for (const horizonHours of [1, 24, 48, 168]) assert.equal(workbench.isLiveConditionalProjectionEligible({
    analogCashScenario: { status: 'unqualified', reason: 'source_stale', Ea: null },
  }, { ...q, horizonHours }), true)
})
test('actual Workbench loader requests bounded live enrichment for sparse reviewed native questions', async () => {
  for (const horizonHours of [1, 24, 48, 168]) {
    const q = { routeKey: identity.routeKey, destination: identity.destination, amountUnits: '0.9',
      horizonHours, payoutAsset: identity.asset, payoutAssetDecimals: 6 }
    const body = { routeKey: q.routeKey, destination: q.destination, source: 'prospective_finalized_observations',
      forecast: { claim: 'aggregate_cash_proxy_only', amountUnits: 0.9, horizonHours },
      conditionalSampledCashPathProjection: { status: 'unavailable', reason: 'insufficient_eligible_history' },
      analogCashScenario: { status: 'unqualified', reason: 'source_stale', Ea: null },
      exitImpact: { historicalBacktest: null, historicalBacktestUnavailableReason: 'insufficient_long_history', conditionalProjection: null },
    }
    const urls = [], delivered = []
    const live = await workbench.loadRouteForecastWithLiveCurrent(q, new AbortController().signal,
      (v) => delivered.push(v), async (url) => { urls.push(url); return { ok: true, json: async () => body } })
    assert.ok(live); assert.equal(delivered.length, 1); assert.equal(urls.length, 2)
    assert.equal(urls[0].includes('includeLiveCurrent'), false)
    assert.equal(urls[1].includes('includeLiveCurrent=1'), true)
  }
})
