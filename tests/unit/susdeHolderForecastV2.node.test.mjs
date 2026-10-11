import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import capacityModule from '../../lib/carry/susdeCurrentProtocolCapacity.ts'
import issuerModule from '../../lib/carry/server/susdeHolderForecastIssuer.ts'
import bindingModule from '../../lib/carry/susdeHolderForecastBinding.ts'
import pinModule from '../../lib/carry/susdeJointHistoryEvidenceSet.ts'

const {
  readSusdeCurrentProtocolOrigin,
  susdeCurrentProtocolReadPlan,
  issueSusdeCurrentProtocolCapacityEvidence,
} = capacityModule
const {
  issueSusdeHolderForecastEnvelopeV2,
  issueSusdeHolderForecastV2FromNativeOrigins,
  issueSusdeHolderForecastFromNativeOrigins,
} = issuerModule
const {
  fetchSusdeHolderForecastResponse,
  selectedSusdeHolderForecast,
  susdeHolderForecastIssueFromResponse,
} = bindingModule
const { susdePinnedJointHistoryEvidenceSet } = pinModule
const NOW = Date.parse('2026-10-08T04:16:00.000Z')
const names = ['first.example', 'second.example']
const capture = JSON.parse(
  readFileSync(
    'data/research/venue-signals/susde-joint-native-history-2026-10-08T00-10.json',
    'utf8',
  ),
)
const codes = capture.capture.hosts[0].traces[0]
  .filter((t) => t.request.method === 'eth_getCode')
  .map((t) => t.result)

// Native runtime bytes with explicitly synthetic, fresh getter states.
function expected(at = NOW) {
  return {
    owner: `0x${'a'.repeat(40)}`,
    requestedRaw: '1000000',
    source: {
      chainId: 1,
      blockNumber: '26111000',
      blockHash: `0x${'b'.repeat(64)}`,
      blockTime: new Date(at - 60000).toISOString(),
      finalized: true,
    },
    activeSharesRaw: '5000000',
    activeEntitlementRaw: '5500000',
    maxWithdrawRaw: '5500000',
    pendingAssetsRaw: '2500000',
    storedCooldownEndUnix: String(at / 1000 - 120),
    cooldownDurationSeconds: '86400',
    initiationStatus: 'success',
    pendingClaimStatus: 'success',
  }
}
function client(e) {
  const plan = susdeCurrentProtocolReadPlan(e)
  const word = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`
  const header = {
    number: `0x${BigInt(e.source.blockNumber).toString(16)}`,
    hash: e.source.blockHash,
    timestamp: `0x${BigInt(Date.parse(e.source.blockTime) / 1000).toString(16)}`,
  }
  const results = {
    opening_header: header,
    closing_header: header,
    code_vault: codes[0],
    code_asset: codes[1],
    code_silo: codes[2],
    vaultCashRaw: word('9000000'),
    siloCashRaw: word('3000000'),
    cooldowns: word(e.storedCooldownEndUnix) + word(e.pendingAssetsRaw).slice(2),
  }
  for (const key of [
    'activeSharesRaw',
    'activeEntitlementRaw',
    'maxWithdrawRaw',
    'cooldownDurationSeconds',
  ])
    results[key] = word(e[key])
  return {
    reads: 0,
    async request(wire) {
      this.reads++
      const spec = plan.find(
        (p) => p.method === wire.method && JSON.stringify(p.params) === JSON.stringify(wire.params),
      )
      assert.ok(spec)
      return results[
        wire.method === 'eth_getBlockByNumber' && this.reads === 12 ? 'closing_header' : spec.key
      ]
    },
  }
}
async function nativePair(e = expected(), at = NOW) {
  const clients = [client(e), client(e)]
  const origins = []
  for (const [i, c] of clients.entries()) {
    const observation = await readSusdeCurrentProtocolOrigin(c, e, { now: () => at + i * 10 })
    assert.ok(observation)
    origins.push({ origin: names[i], observation })
  }
  return { e, origins, clients, at: at + 20 }
}
function core(e) {
  const history = susdePinnedJointHistoryEvidenceSet()
  return {
    status: 'partial',
    routeKey: 'USDe → Staked USDe [USDe]',
    destinationAddress: history.addresses.vault,
    owner: e.owner,
    request: { assetsRaw: e.requestedRaw, assetAddress: history.addresses.asset, horizonHours: 24 },
    source: {
      ...e.source,
      blockNumber: Number(e.source.blockNumber),
      originValidation: 'two_provider',
    },
    finalPayout: { assetAddress: history.addresses.asset, status: 'unassessed', amountRaw: null },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    stages: [
      {
        name: 'cooldown_initiation',
        status: 'simulated',
        assetAddress: history.addresses.asset,
        amountRaw: e.requestedRaw,
        relatedToRequest: true,
      },
      {
        name: 'pending_claim',
        status: 'simulated',
        assetAddress: history.addresses.asset,
        amountRaw: e.pendingAssetsRaw,
        relatedToRequest: false,
      },
    ],
    cooldownCondition: {
      exitMode: 'cooldown',
      durationSeconds: 86400,
      initiationStatus: 'success',
      directWithdrawalStatus: null,
      pendingClaimStatus: 'success',
      pendingAssetsRaw: e.pendingAssetsRaw,
      aggregateSiloUsdeRaw: '3000000',
      newRequestWouldResetPending: true,
      pendingClaimEarliestAt: null,
      ifInitiatedAtCheckedBlockEarliestAt: null,
    },
  }
}
async function admit(issued, e, change = (v) => v, status = 200) {
  const history = susdePinnedJointHistoryEvidenceSet()
  const body = {
    routeKey: 'USDe → Staked USDe [USDe]',
    destinationAddress: history.addresses.vault,
    owner: e.owner,
    assetsRaw: e.requestedRaw,
    horizonHours: 24,
    chainId: 1,
  }
  const question = {
    routeKey: body.routeKey,
    destination: body.destinationAddress,
    requestedHolderAddress: e.owner,
    requestedRaw: e.requestedRaw,
    requestedAssetAddress: history.addresses.asset,
    requestedAssetDecimals: 18,
    horizonHours: 24,
    asOfMs: NOW + 21,
    source: e.source,
  }
  const oldFetch = globalThis.fetch,
    oldNow = Date.now
  globalThis.fetch = async () => ({
    status,
    json: async () =>
      change({ ...core(e), susdeHolderForecastEnvelope: structuredClone(issued.envelope) }),
  })
  Date.now = () => question.asOfMs
  try {
    return { ...(await fetchSusdeHolderForecastResponse(body)), question }
  } finally {
    globalThis.fetch = oldFetch
    Date.now = oldNow
  }
}

test('authenticated v2 uses six captures, 24 paired rows and 22 donors at all four horizons', async () => {
  const p = await nativePair()
  const issued = issueSusdeHolderForecastV2FromNativeOrigins(p.origins, p.e, p.at)
  assert.ok(issued)
  assert.deepEqual(
    p.clients.map((c) => c.reads),
    [12, 12],
  )
  const e = issued.envelope,
    history = susdePinnedJointHistoryEvidenceSet()
  assert.equal(e.schema, 'susde_holder_forecast_envelope_v2')
  assert.equal(e.evidenceSetSha256, history.evidenceSetSha256)
  assert.equal(Object.hasOwn(e, 'historyCaptureSha256'), false)
  assert.equal(history.sources.length, 6)
  assert.equal(e.inputCommon.history.rows.length, 24)
  assert.equal(e.inputCommon.history.dailyDonorCount, 22)
  assert.equal(e.inputCommon.current.activeEntitlementRaw, '5500000')
  assert.deepEqual(e.inputCommon.current.evidence, issued.evidence)
  for (const h of [1, 24, 48, 168]) {
    const m = e.modelsByHorizonHours[h]
    assert.equal(m.metadata.donorCount, 22)
    assert.equal(m.active.funding.scenarios.length, 22)
    assert.equal(m.pending.effectiveWholePayoutRaw, '2500000')
    assert.equal(m.newCooldown.effectiveWholePayoutRaw, '3500000')
    assert.equal(m.issueAtUtc, new Date(p.at).toISOString())
    assert.equal(m.targetAtUtc, new Date(p.at + h * 3600000).toISOString())
    for (const flag of [
      'executable',
      'fullHolderAbility',
      'forecastValidated',
      'prospectiveValidated',
    ])
      assert.equal(m[flag], false)
    assert.equal(m.metadata.calibratedProbability, false)
  }
  assert.equal(Object.isFrozen(e.inputCommon.history.rows), true)
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e)
  const legacy = issueSusdeHolderForecastFromNativeOrigins(p.origins, p.e, p.at)
  assert.equal(legacy.envelope.schema, 'susde_holder_forecast_envelope_v1')
  assert.equal(legacy.envelope.modelsByHorizonHours[24].metadata.donorCount, 3)
})

test('v2 rejects copies, non-native issuance, changed current rights, source, origins and clocks', async () => {
  const p = await nativePair(),
    issued = issueSusdeHolderForecastV2FromNativeOrigins(p.origins, p.e, p.at)
  assert.ok(issued)
  for (const copy of [
    structuredClone(issued.evidence),
    { ...issued.evidence, approved: true },
    issueSusdeCurrentProtocolCapacityEvidence(p.origins, p.e, p.at),
  ])
    assert.equal(issueSusdeHolderForecastEnvelopeV2(copy, p.e, names, p.at), null)
  assert.equal(
    issueSusdeHolderForecastV2FromNativeOrigins(structuredClone(p.origins), p.e, p.at),
    null,
  )
  assert.equal(
    issueSusdeHolderForecastV2FromNativeOrigins(
      [p.origins[0], { ...p.origins[1], observation: p.origins[0].observation }],
      p.e,
      p.at,
    ),
    null,
  )
  for (const key of [
    'owner',
    'requestedRaw',
    'activeSharesRaw',
    'activeEntitlementRaw',
    'pendingAssetsRaw',
  ])
    assert.equal(
      issueSusdeHolderForecastEnvelopeV2(
        issued.evidence,
        { ...p.e, [key]: key === 'owner' ? `0x${'c'.repeat(40)}` : '42' },
        names,
        p.at,
      ),
      null,
    )
  for (const clock of [p.at - 1, p.at + 1, NOW + 1800001, NaN])
    assert.equal(issueSusdeHolderForecastEnvelopeV2(issued.evidence, p.e, names, clock), null)
  assert.equal(
    issueSusdeHolderForecastEnvelopeV2(issued.evidence, p.e, [...names].reverse(), p.at),
    null,
  )
  assert.equal(
    issueSusdeHolderForecastEnvelopeV2(
      issued.evidence,
      { ...p.e, source: { ...p.e.source, blockHash: `0x${'d'.repeat(64)}` } },
      names,
      p.at,
    ),
    null,
  )
  const earlyAt = Date.parse('2026-10-08T04:14:00.000Z')
  const early = await nativePair(expected(earlyAt), earlyAt)
  assert.equal(issueSusdeHolderForecastV2FromNativeOrigins(early.origins, early.e, early.at), null)
})

test('v2 fetch binds exact history/current/all outputs, original issue and matching question', async () => {
  const p = await nativePair(),
    issued = issueSusdeHolderForecastV2FromNativeOrigins(p.origins, p.e, p.at)
  assert.ok(issued)
  const { result, question } = await admit(issued, p.e)
  const envelope = result.susdeHolderForecastEnvelope
  const issue = susdeHolderForecastIssueFromResponse(result, 200, question)
  assert.ok(issue)
  assert.equal(selectedSusdeHolderForecast(structuredClone(envelope), question), null)
  assert.equal(selectedSusdeHolderForecast(issued.envelope, question), null)
  for (const horizonHours of [1, 24, 48, 168]) {
    const model = selectedSusdeHolderForecast(envelope, { ...question, horizonHours })
    assert.ok(model)
    assert.equal(model.input.history.evidenceSetSha256, issued.envelope.evidenceSetSha256)
    assert.equal(model.metadata.donorCount, 22)
    assert.equal(model.issueAtUtc, issued.envelope.issueAtUtc)
    assert.equal(
      selectedSusdeHolderForecast(envelope, { ...question, horizonHours, asOfMs: NOW + 1000 }),
      model,
    )
  }
  for (const override of [
    { requestedRaw: '999999' },
    { requestedHolderAddress: `0x${'f'.repeat(40)}` },
    { source: { ...question.source, blockHash: `0x${'f'.repeat(64)}` } },
    { asOfMs: Date.parse(envelope.sourceProofValidUntil) + 1 },
    { horizonHours: 2 },
  ])
    assert.equal(selectedSusdeHolderForecast(envelope, { ...question, ...override }), null)
  const mutations = [
    (e) => {
      e.evidenceSetSha256 = '0'.repeat(64)
    },
    (e) => {
      e.historyCaptureSha256 = e.evidenceSetSha256
    },
    (e) => {
      e.inputCommon.history.rows[0].vaultUsdeRaw = '1'
    },
    (e) => {
      e.inputCommon.current.activeEntitlementRaw = '1'
    },
    (e) => {
      e.modelsByHorizonHours[168].active.funding.targetSummary.empiricalP90HeadroomRaw = '1'
    },
    (e) => {
      e.modelsByHorizonHours[48].metadata.calibratedProbability = true
    },
    (e) => {
      delete e.modelsByHorizonHours[1]
    },
  ]
  for (const mutate of mutations) {
    const bad = await admit(issued, p.e, (r) => {
      mutate(r.susdeHolderForecastEnvelope)
      return r
    })
    assert.equal(susdeHolderForecastIssueFromResponse(bad.result, 200, bad.question), null)
    assert.equal(bad.result.status, 'partial')
  }
})
