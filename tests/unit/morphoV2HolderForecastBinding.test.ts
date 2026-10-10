import { describe, expect, it } from 'vitest'
import {
  issuedMorphoV2HolderForecast,
  morphoV2HolderForecastIssueFromResponse,
  morphoV2HolderForecastRenderWindow,
  morphoV2ProtocolEvidenceFromResponse,
} from '@/lib/carry/morphoV2HolderForecastBinding'
import { createMorphoV2HolderForecastFixture as fixture } from './fixtures/morphoV2HolderForecastFixture'

const OWNER = `0x${'b'.repeat(40)}`

describe('browser Morpho native holder forecast binding', () => {
  it.each([1, 24, 48, 168])(
    'binds genuine protocol bytes, full E and exact H%s without sampled cash',
    (H) => {
      const f = fixture(H)
      const value = issuedMorphoV2HolderForecast(
        f.capacityAgreement,
        undefined,
        f.compact,
        f.question,
      )!
      expect(value).not.toBeNull()
      expect(value.input.binding.currentSource).toEqual(f.expected.source)
      expect(value.input.capacityAgreement).toEqual(f.capacityAgreement)
      expect(value.input.binding.requestedRaw).toBe('1000000')
      expect(value.input.current.sourceImplementationEquivalence).toBe(false)
      expect(
        value.input.current.runtimeIdentities.every(
          (id) => id.implementationAddress === null && id.implementationCodeHash === null,
        ),
      ).toBe(true)
      expect(value.input.capacityAgreement).toMatchObject({
        quote: {
          entitlementRaw: '2000000',
          quotedMaxWithdrawRaw: '0',
          entitlementMethod: 'preview_redeem_full_position',
        },
      })
      expect(value.process.scenarios[0].points[0].headroomRaw).toBe('24558')
      expect(value.issueAtUtc).toBe(new Date(f.question.asOfMs).toISOString())
      expect(value.targetAtUtc).toBe(new Date(f.question.asOfMs + H * 3600000).toISOString())
      expect(value.holderExecutableExit).toBe(false)
      expect(value.forecastValidated).toBe(false)
      expect(value.prospectiveValidated).toBe(false)
      expect(value.calibratedProbability).toBe(false)
    },
  )

  it.each([200, 503])('keeps optional evidence and genuine issue on HTTP%s', (status) => {
    const f = fixture(48)
    const response = {
      ...f.response,
      ...(status === 503 ? { error: 'holder_exit_assessment_unavailable' } : {}),
    }
    expect(morphoV2ProtocolEvidenceFromResponse(response, status)).toBe(f.compact)
    const issue = morphoV2HolderForecastIssueFromResponse(response, status, f.question)!
    expect(issue).toMatchObject({
      issuedAtMs: f.question.asOfMs,
      horizonHours: 48,
      owner: OWNER,
      requestedRaw: '1000000',
      source: f.expected.source,
    })
    expect(
      morphoV2ProtocolEvidenceFromResponse({ ...response, error: 'unrelated' }, 503),
    ).toBeNull()
    expect(morphoV2HolderForecastIssueFromResponse(response, 500, f.question)).toBeNull()
  })

  it.each(['owner', 'q', 'asset', 'units', 'route', 'destination', 'horizon', 'source', 'receipt'])(
    'rejects independently selected %s mismatch',
    (mode) => {
      const f = fixture()
      const q = structuredClone(f.question)
      if (mode === 'owner') q.requestedHolderAddress = `0x${'c'.repeat(40)}`
      if (mode === 'q') q.requestedRaw = '999999'
      if (mode === 'asset') q.requestedAssetAddress = `0x${'c'.repeat(40)}`
      if (mode === 'units') q.requestedAssetDecimals = 18
      if (mode === 'route') q.routeKey = 'USDC → something else'
      if (mode === 'destination') q.destination = `0x${'c'.repeat(40)}`
      if (mode === 'horizon') q.horizonHours = 2
      if (mode === 'source')
        q.independentSource = { ...f.expected.source, blockHash: `0x${'c'.repeat(64)}` }
      if (mode === 'receipt') q.asOfMs = f.expected.asOfMs - 60000
      expect(issuedMorphoV2HolderForecast(f.capacityAgreement, undefined, f.compact, q)).toBeNull()
    },
  )

  it('requires approved native quote hosts and full position entitlement, without a generic fallback', () => {
    const f = fixture()
    for (const mode of ['host', 'method', 'entitlement', 'quote', 'none']) {
      const cap = structuredClone(f.capacityAgreement)
      if (mode === 'host') cap.origins[0].host = 'unknown.example'
      if (mode === 'method') cap.quote.entitlementMethod = 'supplied_balance'
      if (mode === 'entitlement') cap.quote.entitlementRaw = '0'
      if (mode === 'quote') cap.origins[1].quote.entitlementRaw = '999'
      expect(
        issuedMorphoV2HolderForecast(
          mode === 'none' ? null : cap,
          undefined,
          f.compact,
          f.question,
        ),
      ).toBeNull()
    }
    expect(
      issuedMorphoV2HolderForecast(f.capacityAgreement, undefined, null, f.question),
    ).toBeNull()
  })

  it('rejects malformed or self-sourced protocol evidence despite a valid independent capacity quote', () => {
    const f = fixture()
    for (const mode of ['ref', 'source', 'clock', 'bytes']) {
      const compact = structuredClone(f.compact)
      if (mode === 'ref')
        compact.origins[0].observation.traces[1].result = { codeRef: 'code_asset' }
      if (mode === 'source')
        compact.origins.forEach((origin) => {
          origin.observation.source.blockHash = `0x${'c'.repeat(64)}`
        })
      if (mode === 'clock')
        compact.origins[0].observation.readAtUtc = new Date(f.question.asOfMs + 1).toISOString()
      if (mode === 'bytes') compact.codeDictionary.code_adapter = '0x00'
      expect(
        issuedMorphoV2HolderForecast(f.capacityAgreement, undefined, compact, f.question),
      ).toBeNull()
    }
  })

  it('keeps receipt issue, H and source immutable while live time only closes the render window', () => {
    const f = fixture(1)
    f.question.independentSource = structuredClone(f.expected.source)
    const issue = morphoV2HolderForecastIssueFromResponse(f.response, 200, f.question)!
    const value = issuedMorphoV2HolderForecast(
      f.capacityAgreement,
      undefined,
      f.compact,
      f.question,
    )!
    const before = JSON.stringify(value)
    expect(Object.isFrozen(value.input.binding.currentSource)).toBe(true)
    expect(morphoV2HolderForecastRenderWindow(value, issue.issuedAtMs - 1)).toBe(false)
    expect(morphoV2HolderForecastRenderWindow(value, issue.issuedAtMs + 1000)).toBe(true)
    expect(
      morphoV2HolderForecastRenderWindow(value, Date.parse(value.sourceProofValidUntil) + 1),
    ).toBe(false)
    expect(morphoV2HolderForecastRenderWindow(value, Date.parse(value.targetAtUtc))).toBe(false)
    expect(morphoV2HolderForecastRenderWindow(structuredClone(value), issue.issuedAtMs)).toBe(false)
    expect(JSON.stringify(value)).toBe(before)
    expect(issue.issuedAtMs).toBe(f.question.asOfMs)
    expect(issue.independentSource).toEqual(f.expected.source)
    expect(
      issuedMorphoV2HolderForecast(f.capacityAgreement, undefined, f.compact, {
        ...f.question,
        asOfMs: Date.parse(value.sourceProofValidUntil) + 1,
      }),
    ).toBeNull()
  })
})
