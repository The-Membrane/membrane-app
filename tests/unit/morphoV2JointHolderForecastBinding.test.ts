import { describe, expect, it } from 'vitest'
import { sha256, stringToHex } from 'viem'
import {
  issuedMorphoV2JointHolderForecast,
  morphoV2JointHolderForecastFromResponse,
  morphoV2JointHolderForecastIssue,
  morphoV2JointHolderForecastIssueFromResponse,
  morphoV2JointHolderForecastRenderWindow,
  selectedMorphoV2JointHolderForecast,
  selectedMorphoV2JointHolderForecastIssue,
  selectedMorphoV2JointHolderForecastFromIssue,
} from '@/lib/carry/morphoV2JointHolderForecastBinding'
import { encodeMorphoV2HistoricalHolderEaEvidencePair } from '@/lib/carry/morphoV2HistoricalHolderEaEvidence'
import { reviewedMorphoV2ProtocolHistory } from '@/lib/carry/morphoV2ReviewedProtocolHistories'
import {
  createMorphoV2JointHolderForecastFixture as fixture,
  jointUint,
  MORPHO_JOINT_RETAINED_FIXED_S,
} from './fixtures/morphoV2JointHolderForecastFixture'

type Fixture = ReturnType<typeof fixture>
const hash = (text: string) => sha256(stringToHex(text)).slice(2)
function issue(f: Fixture) {
  return issuedMorphoV2JointHolderForecast(
    f.capacityAgreement,
    undefined,
    f.compactProtocol,
    f.compactHolder,
    f.compactHistorical,
    f.question,
  )
}

describe('private joint Morpho holder forecast with fully synthetic current source', () => {
  it.each([1, 24, 48, 168])(
    'issues H%s with independent full S/Ea, Q once, M unknown and native prior donors',
    (H) => {
      const f = fixture('USDT', MORPHO_JOINT_RETAINED_FIXED_S, false, H)
      const model = issue(f)!
      expect(model).not.toBeNull()
      expect(model.sharesRaw).toBe(MORPHO_JOINT_RETAINED_FIXED_S)
      expect(model.fullEaRaw).toBe('10587996327')
      expect(model.requestedRaw).toBe('1000000')
      expect(model.process.queuedCompetingMRaw).toBeNull()
      expect(model.process.sourceSnapshot.fixedShareEntitlement).toEqual({
        method: 'native_preview_redeem_fixed_shares',
        sharesRaw: model.sharesRaw,
        assetsRaw: model.fullEaRaw,
      })
      expect(model.process.persistenceBaseline.headroomRaw).toBe(
        String(BigInt(model.process.persistenceBaseline.availableRaw) - BigInt(model.requestedRaw)),
      )
      expect(model.attemptedDonorCount).toBe(6)
      expect(model.process.scenarios.length + model.process.excludedDonors.length).toBe(
        model.attemptedDonorCount,
      )
      expect(model.historicalEaMethod).toBe('reviewed_fixed_S_native_quotes')
      expect(model.targetAtUtc).toBe(new Date(f.question.asOfMs + H * 3600000).toISOString())
      expect(model.issueAtUtc).toBe(new Date(f.question.asOfMs).toISOString())
      expect(Date.parse(model.knowledgeCutoffUtc)).toBeLessThanOrEqual(f.question.asOfMs)
      expect(model).toMatchObject({
        authenticated: false,
        holderExecutableExit: false,
        forecastValidated: false,
        prospectiveValidated: false,
        calibratedProbability: false,
        historicalPastOwnershipProven: false,
      })
      for (const scenario of model.process.scenarios) {
        if (scenario.status === 'usable')
          expect(scenario.sampledDuration).toMatchObject({
            unknownBetweenCheckpoints: true,
            trueFirstLossClaim: false,
            continuousProof: false,
          })
      }
    },
  )

  it.each(['USDC', 'USDT'] as const)(
    'issues %s for arbitrary S only with exact native historical Ea anchors',
    (asset) => {
      const f = fixture(asset, '987654321123456789', true)
      const model = issue(f)!
      expect(model).not.toBeNull()
      expect(model.sharesRaw).toBe('987654321123456789')
      expect(model.fullEaRaw).toBe('10587996327')
      expect(model.historicalEaMethod).toBe('native_current_full_S_historical_quotes')
      expect(model.attemptedDonorCount).toBe(f.anchors.length - 1)
      const first = model.process.scenarios[0]
      // Ea delta comes from native 1,000,001 -> 1,000,078 responses, never a scaled fixed-S history.
      expect(first.signedDeltaByChannel.fullEa).toBe('77')
      expect(model.knowledgeCutoffUtc).toBe(f.historical.origins[0].observation.readAtUtc)
      expect(model.process.sourceSnapshot.regime).toMatchObject({
        profile: f.profile.id,
        runtimeCodeIdentity: hash(JSON.stringify(model.input.current.runtimeIdentities)),
        configurationIdentity: hash(JSON.stringify(model.input.current.configured)),
        feePolicyIdentity: hash(
          JSON.stringify([
            model.input.current.point.prongs.market[5],
            model.input.current.point.prongs.feeRecipient,
          ]),
        ),
      })
    },
  )

  it('requires native historical bytes for USDC and non-retained USDT S; malformed present bytes never fall back', () => {
    expect(issue(fixture('USDC', '123', false))).toBeNull()
    expect(issue(fixture('USDT', '123', false))).toBeNull()
    const f = fixture()
    for (const historical of ['', '{}', 1, { approved: true }])
      expect(
        issuedMorphoV2JointHolderForecast(
          f.capacityAgreement,
          undefined,
          f.compactProtocol,
          f.compactHolder,
          historical,
          f.question,
        ),
      ).toBeNull()
  })

  it.each([
    'protocol',
    'holder',
    'profile',
    'shares',
    'Ea',
    'source',
    'owner',
    'units',
    'hosts',
    'method',
    'position',
  ])('rejects missing or independently mismatched %s', (kind) => {
    const f = fixture()
    let protocol: unknown = f.compactProtocol,
      holder: unknown = f.compactHolder
    if (kind === 'protocol') protocol = null
    if (kind === 'holder') holder = null
    if (kind === 'profile') f.question.requestedAssetAddress = `0x${'c'.repeat(40)}`
    if (kind === 'owner') f.question.requestedHolderAddress = `0x${'c'.repeat(40)}`
    if (kind === 'units') f.question.requestedAssetDecimals = 18
    if (kind === 'source') f.question.independentSource!.blockHash = `0x${'c'.repeat(64)}`
    if (kind === 'hosts') f.capacityAgreement.origins[0].host = 'unconfigured.example'
    if (kind === 'shares') {
      const raw = JSON.parse(f.compactHolder)
      raw.origins.forEach((o: any) => {
        o.observation.traces[0].result = jointUint(1n)
      })
      holder = JSON.stringify(raw)
    }
    if (kind === 'Ea') {
      const raw = JSON.parse(f.compactHolder)
      raw.origins.forEach((o: any) => {
        o.observation.traces[1].result = jointUint(1n)
      })
      holder = JSON.stringify(raw)
    }
    if (kind === 'method') f.capacityAgreement.quote.entitlementMethod = 'supplied_balance'
    if (kind === 'position') delete f.capacityAgreement.quote.sourceHolderPosition
    expect(
      issuedMorphoV2JointHolderForecast(
        f.capacityAgreement,
        undefined,
        protocol,
        holder,
        undefined,
        f.question,
      ),
    ).toBeNull()
  })

  it.each([
    'holder-source',
    'holder-owner',
    'holder-share-units',
    'holder-asset',
    'holder-host',
    'holder-duplicate',
    'protocol-host',
    'protocol-code',
    'protocol-fee',
  ])('rejects forged %s native bytes', (kind) => {
    const f = fixture()
    let holder = f.compactHolder
    const raw = JSON.parse(holder),
      protocol = structuredClone(f.compactProtocol)
    if (kind === 'holder-source') raw.origins[0].observation.source.blockNumber++
    if (kind === 'holder-owner')
      raw.origins[0].observation.traces[0].params[0].data = `0x70a08231${'0'.repeat(24)}${'c'.repeat(40)}`
    if (kind === 'holder-share-units') raw.origins[0].observation.shareDecimals = 6
    if (kind === 'holder-asset') raw.origins[0].observation.asset = f.profile.subject.destination
    if (kind === 'holder-host') raw.origins[0].host = 'evil.example'
    if (kind === 'holder-duplicate') raw.origins[1].host = raw.origins[0].host
    if (kind === 'protocol-host') protocol.origins[0].host = 'evil.example'
    if (kind === 'protocol-code') protocol.codeDictionary.code_vault = '0x00'
    if (kind === 'protocol-fee')
      protocol.origins.forEach((o) => {
        o.observation.traces.find((t) => t.key === 'feeRecipient')!.result = jointUint(1n)
      })
    holder = JSON.stringify(raw)
    expect(
      issuedMorphoV2JointHolderForecast(
        f.capacityAgreement,
        undefined,
        protocol,
        holder,
        undefined,
        f.question,
      ),
    ).toBeNull()
  })

  it.each(['S', 'profile', 'source', 'hosts', 'Ea', 'missing-anchor', 'future-clock'])(
    'rejects arbitrary-S historical %s mismatch without fallback',
    (kind) => {
      const f = fixture('USDT', '123', true)
      const raw = JSON.parse(f.compactHistorical!)
      if (kind === 'S') raw.origins[0].observation.sharesRaw = '124'
      if (kind === 'profile')
        raw.origins[0].observation.profileId = 'morpho_v2_usdc_reviewed_protocol_history'
      if (kind === 'source')
        raw.origins[0].observation.currentSource.blockHash = `0x${'c'.repeat(64)}`
      if (kind === 'hosts') raw.origins[0].host = 'first.example'
      if (kind === 'Ea') raw.origins[0].observation.traces[0].result = jointUint(99n)
      if (kind === 'missing-anchor') raw.origins[0].observation.traces.pop()
      if (kind === 'future-clock')
        raw.origins[0].observation.readAtUtc = new Date(f.question.asOfMs + 1).toISOString()
      expect(
        issuedMorphoV2JointHolderForecast(
          f.capacityAgreement,
          undefined,
          f.compactProtocol,
          f.compactHolder,
          JSON.stringify(raw),
          f.question,
        ),
      ).toBeNull()
    },
  )

  it('retains censored NET tails and suppresses the complete headline', () => {
    const f = fixture('USDT', '123', true, 168)
    // Both native origins agree: large negative historical Ea delta makes a future stock negative.
    f.historical.origins.forEach((o) => {
      o.observation.traces[0].result = jointUint(1000000000000n)
      o.observation.traces[1].result = jointUint(0n)
    })
    f.compactHistorical = encodeMorphoV2HistoricalHolderEaEvidencePair(
      f.historical,
      f.historicalExpected,
    )!
    const model = issue(f)!
    expect(model).not.toBeNull()
    expect(model.process.scenarios.some((s) => s.status === 'censored')).toBe(true)
    expect(model.completeDonorSet).toBe(false)
    expect(model.process.descriptiveExpectedFlow.headline).toBeNull()
    expect(model.process.scenarios.length + model.process.excludedDonors.length).toBe(
      model.attemptedDonorCount,
    )
    expect(model.process.descriptiveExpectedFlow.censoredScenarioCount).toBeGreaterThan(0)
  })

  it('keeps immutable private receipts, rejects clones/rebinding and enforces source TTL and target expiry', () => {
    const f = fixture('USDT', '123', true, 1),
      model = issue(f)!
    expect(model).not.toBeNull()
    const receipt = morphoV2JointHolderForecastIssue(model)!
    expect(Object.isFrozen(model.process.sourceSnapshot)).toBe(true)
    expect(Object.isFrozen(receipt.source)).toBe(true)
    expect(receipt).toMatchObject({
      sharesRaw: '123',
      fullEaRaw: model.fullEaRaw,
      independentSource: f.question.independentSource,
    })
    expect(selectedMorphoV2JointHolderForecast(model, f.question, f.question.asOfMs + 1000)).toBe(
      model,
    )
    expect(
      selectedMorphoV2JointHolderForecastIssue(receipt, f.question, f.question.asOfMs + 1000),
    ).toBe(receipt)
    expect(selectedMorphoV2JointHolderForecast(structuredClone(model), f.question)).toBeNull()
    expect(morphoV2JointHolderForecastIssue(structuredClone(model))).toBeNull()
    expect(
      selectedMorphoV2JointHolderForecastIssue(structuredClone(receipt), f.question),
    ).toBeNull()
    expect(morphoV2JointHolderForecastRenderWindow(model, f.question.asOfMs - 1)).toBe(false)
    expect(morphoV2JointHolderForecastRenderWindow(model, Date.parse(model.targetAtUtc))).toBe(
      false,
    )
    const long = issue(fixture('USDT', MORPHO_JOINT_RETAINED_FIXED_S, false, 168))!
    expect(Date.parse(long.sourceProofValidUntil)).toBe(
      Date.parse(long.source.blockTime) + 30 * 60 * 1000,
    )
    expect(
      morphoV2JointHolderForecastRenderWindow(long, Date.parse(long.sourceProofValidUntil)),
    ).toBe(true)
    expect(
      morphoV2JointHolderForecastRenderWindow(long, Date.parse(long.sourceProofValidUntil) + 1),
    ).toBe(false)
    expect(
      morphoV2JointHolderForecastRenderWindow(
        long,
        Date.parse(long.source.blockTime) + 2 * 60 * 60 * 1000,
      ),
    ).toBe(false)
    expect(
      selectedMorphoV2JointHolderForecastIssue(receipt, { ...f.question, requestedRaw: '1' }),
    ).toBeNull()
    expect(
      selectedMorphoV2JointHolderForecast(model, { ...f.question, horizonHours: 24 }),
    ).toBeNull()
    expect(
      selectedMorphoV2JointHolderForecast(model, { ...f.question, independentSource: undefined }),
    ).toBeNull()
    expect(
      selectedMorphoV2JointHolderForecast(model, { ...f.question, asOfMs: f.question.asOfMs + 1 }),
    ).toBeNull()
    f.question.requestedHolderAddress = `0x${'c'.repeat(40)}`
    expect(selectedMorphoV2JointHolderForecast(model, f.question)).toBeNull()
  })

  it.each([200, 503])(
    'binds the optional response on HTTP%s only through complete native evidence',
    (status) => {
      const f = fixture()
      const response = {
        ...f.response,
        ...(status === 503 ? { error: 'holder_exit_assessment_unavailable' } : {}),
      }
      expect(morphoV2JointHolderForecastFromResponse(response, status, f.question)).not.toBeNull()
      const receipt = morphoV2JointHolderForecastIssueFromResponse(response, status, f.question)!
      expect(selectedMorphoV2JointHolderForecastIssue(receipt, f.question)).toBe(receipt)
      expect(
        morphoV2JointHolderForecastFromResponse(
          { ...response, morphoV2CurrentHolderPositionEvidence: undefined },
          status,
          f.question,
        ),
      ).toBeNull()
      expect(
        morphoV2JointHolderForecastFromResponse({ ...response, error: 'other' }, 503, f.question),
      ).toBeNull()
      expect(morphoV2JointHolderForecastFromResponse(response, 500, f.question)).toBeNull()
    },
  )

  it('does not label retrospective native history as knowledge available before its recorded cutoff', () => {
    const f = fixture()
    const cutoff = Date.parse(reviewedMorphoV2ProtocolHistory(f.profile)!.knowledgeCutoff)
    expect(issue({ ...f, question: { ...f.question, asOfMs: cutoff - 1 } })).toBeNull()
    const model = issue(f)!
    expect(model).not.toBeNull()
    expect(Date.parse(model.knowledgeCutoffUtc)).toBeLessThanOrEqual(f.question.asOfMs)
    expect(model.process.claims).toMatchObject({
      pastOwnership: false,
      calibratedProbability: false,
      futureGuarantee: false,
    })
    expect('holdoutScore' in model).toBe(false)
    expect('accuracy' in model).toBe(false)
  })
})

describe('original Morpho receipt and honest issue horizon', () => {
  it('retains the original frozen model after all retained envelopes are replaced', () => {
    const f = fixture('USDT', '987654321123456789', true)
    const model = issue(f)!
    const receipt = morphoV2JointHolderForecastIssue(model)!
    const retained: Record<string, unknown> = { ...f.response }
    retained.morphoV2CurrentProtocolCapacityEvidence = {}
    retained.morphoV2CurrentHolderPositionEvidence = '{}'
    retained.morphoV2HistoricalHolderEaEvidence = '{}'
    expect(morphoV2JointHolderForecastFromResponse(retained, 200, f.question)).toBeNull()
    expect(selectedMorphoV2JointHolderForecastFromIssue(receipt, f.question)).toBe(model)
    expect(
      selectedMorphoV2JointHolderForecastFromIssue(structuredClone(receipt), f.question),
    ).toBeNull()
    expect(
      selectedMorphoV2JointHolderForecastFromIssue(receipt, {
        ...f.question,
        requestedRaw: '2000000',
      }),
    ).toBeNull()
    expect(
      selectedMorphoV2JointHolderForecastFromIssue(
        receipt,
        f.question,
        Date.parse(model.sourceProofValidUntil) + 1,
      ),
    ).toBeNull()
  })
  it('counts actual subsecond source age once and keeps native source measurement intact', () => {
    const f = fixture('USDT', '987654321123456789', true, 1)
    f.question.asOfMs += 60123
    const model = issue(f)!
    expect(model).not.toBeNull()
    const age = f.question.asOfMs - Date.parse(f.expected.source.blockTime)
    expect(model.process.sourceAgeMs).toBe(age)
    expect(model.process.horizonMs).toBe(3600000)
    expect(model.process.projectionElapsedMs).toBe(age + 3600000)
    expect(Date.parse(model.targetAtUtc)).toBe(f.question.asOfMs + 3600000)
    expect(model.assetSymbol).toBe('USDT')
    expect(model.process.sourceSnapshot.source.blockTime).toBe(f.expected.source.blockTime)
    const sample = model.process.scenarios.find((s) => s.status === 'usable')
    expect(sample?.status).toBe('usable')
    if (sample?.status === 'usable') {
      expect(sample.sampledDuration?.checkpoints[0].elapsedMs).toBe(0)
      expect(sample.sampledDuration?.checkpoints.at(-1)?.elapsedMs).toBe(3600000)
    }
  })
})
