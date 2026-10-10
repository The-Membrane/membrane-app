import { readFileSync } from 'node:fs'
import type { NextApiRequest, NextApiResponse } from 'next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { carryForecastRequest } from '@/pages/api/carry/forecast'
import { buildSubjectManifest } from '@/scripts/record-carry-cash-issues.mjs'
import { readConfiguredLiveCurrentCash } from '@/scripts/research/carry-live-current-cash.mjs'
import {
  issueAnalogCashScenario,
  readAuthenticatedAnalogLiveCash,
  verifyAnalogCashLedger,
} from '@/lib/carry/analogCashScenarioIssuer.server'
import { reviewedAnalogCashSubject } from '@/lib/carry/analogCashProfileRegistry.server'
import type { ConditionalSampledCashHistory } from '@/lib/carry/conditionalSampledCashPathProjection'

const state = vi.hoisted(() => ({ observations: [] as any[] }))
// These mocks stand at the existing authenticated disk/RPC boundaries. The
// issuer remains real: raw copied evidence does not receive its private token.
vi.mock('@/scripts/lib/localCarryCashStore.mjs', async (original) => ({
  ...(await original<typeof import('@/scripts/lib/localCarryCashStore.mjs')>()),
  verifyLocalCarryCash: () => ({ count: 0, records: [], last: null }),
  localCarryCashObservationsFromVerified: () => state.observations,
}))
vi.mock('@/scripts/lib/localCarryCashIssueStore.mjs', () => ({
  verifyLocalCashIssueLedgerFromVerified: () => null,
}))
vi.mock('@/scripts/research/carry-live-current-cash.mjs', () => ({
  readConfiguredLiveCurrentCash: vi.fn(),
}))
const histories = Object.values(
  JSON.parse(
    readFileSync(
      'data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json',
      'utf8',
    ),
  ).histories,
) as ConditionalSampledCashHistory[]
const base = histories.find((h) => h.identity.routeKey === 'USDC → supply on Aave V3')!
const target = {
  route_key: 'USDC → VaultV2 [USDC]',
  destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
}
const now = Date.parse('2026-10-08T12:00:00.000Z')
let manifest: Awaited<ReturnType<typeof buildSubjectManifest>>
function fixture(sparse = true) {
  const historyFor = (s: typeof target) =>
    histories.find(
      (h) => h.identity.routeKey === s.route_key && h.identity.destination === s.destination,
    )
  const observations = base.points.map((point, index) => ({
    collectionMode: 'retrospective',
    anchorAt: new Date(Date.parse(point[3]) + 1000).toISOString(),
    manifestSha256: base.witness.manifestSha256,
    receiptSha256: index === 119 ? base.witness.lastDailyReceiptSha256 : 'a'.repeat(64),
    firstLocalReceiptAt: base.witness.availableAt,
    source: { block: point[1], blockHash: point[2], blockAt: point[3] },
    subjects: manifest.subjects.map((s) => {
      const h = historyFor(s),
        p = h?.points.find((p) => p[0] === index)
      const absent = !p || (sparse && s.destination === target.destination)
      return {
        routeKey: s.route_key,
        destination: s.destination,
        state: absent ? 'no_code' : 'observed',
        reason: absent ? 'destination_not_deployed' : null,
        asset: absent ? null : s.asset,
        assetDecimals: absent ? null : h!.identity.assetDecimals,
        cashRaw: absent ? null : p![4],
      }
    }),
  }))
  return [
    ...observations,
    {
      collectionMode: 'current',
      anchorAt: new Date(now - 1000).toISOString(),
      manifestSha256: base.witness.manifestSha256,
      receiptSha256: 'b'.repeat(64),
      firstLocalReceiptAt: new Date(now).toISOString(),
      source: {
        block: '26190000',
        blockHash: `0x${'b'.repeat(64)}`,
        blockAt: new Date(now - 1000).toISOString(),
      },
      subjects: manifest.subjects.map((s) => ({
        routeKey: s.route_key,
        destination: s.destination,
        state: 'observed',
        reason: null,
        asset: s.asset,
        assetDecimals:
          historyFor(s)?.identity.assetDecimals ??
          reviewedAnalogCashSubject(s)?.identity.assetDecimals ??
          18,
        cashRaw: '100000000',
      })),
    },
  ]
}
function request(ledger = verifyAnalogCashLedger(manifest)) {
  return {
    currentLedger: ledger,
    donorLedger: ledger,
    subject: target,
    requestedRaw: '1000000',
    horizonHours: 24,
    issueAtUtc: new Date(now).toISOString(),
    currentSourceConflict: false,
    nativeProjection: {
      status: 'unavailable' as const,
      reason: 'insufficient_eligible_history' as const,
    },
  }
}
async function api(query: Record<string, string> = {}) {
  let code = 0,
    body: any
  const res = {
    setHeader() {},
    status(n: number) {
      code = n
      return this
    },
    json(b: unknown) {
      body = b
      return this
    },
  }
  await carryForecastRequest(
    {
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' },
      query: {
        routeKey: target.route_key,
        destination: target.destination,
        amountUnits: '1',
        horizonHours: '24',
        includeLiveCurrent: '0',
        ...query,
      },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
    async () => ({ status: 'unavailable', reason: 'no_exact_model_match' }),
    async () => ({ status: 'unavailable', reason: 'not_enrolled' }),
  )
  return { code, body }
}
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  vi.stubEnv('NODE_ENV', 'development')
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('network_disabled')
    }),
  )
  manifest = await buildSubjectManifest()
  state.observations = fixture()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('private authenticated analog CASH issuer', () => {
  it('issues reviewed sparse cash only, retains original proofs, and bounds qualified donors rather than grid rows', () => {
    const result = issueAnalogCashScenario(request())
    expect(result.status).toBe('analog_cash_scenario')
    if (result.status !== 'analog_cash_scenario') throw Error(result.reason)
    expect(result).toMatchObject({
      Ea: null,
      holderExecutableExit: false,
      forecastValidated: false,
      historicalExtremesAreConfidenceBands: false,
      donorSelection: { selectedDonors: 16, limit: 16 },
    })
    expect(result.donorSelection.eligibleDonors).toBeGreaterThan(16)
    expect(result.prior.input.currentSource).toMatchObject({
      block: '26190000',
      readAt: new Date(now).toISOString(),
      manifestSha256: base.witness.manifestSha256,
      receiptSha256: 'b'.repeat(64),
    })
    expect(result.prior.sourceProofValidUntil).toBe('2026-10-08T12:29:59.000Z')
    expect(
      result.prior.input.donors.every(
        (d) =>
          d.profile.mechanismFamily === 'allocated_vault' &&
          d.profile.assetRiskClass === 'stable' &&
          d.history.witness.availableAt === base.witness.availableAt,
      ),
    ).toBe(true)
    expect(
      result.prior.scenarios.every((s) =>
        s.process.scenarios.every((p) => p.points.every((point) => point.entitlementRaw === null)),
      ),
    ).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects copied verifier output even when every receipt field agrees', () => {
    const input = request()
    expect(
      issueAnalogCashScenario({ ...input, currentLedger: structuredClone(input.currentLedger) }),
    ).toMatchObject({
      status: 'unqualified',
      reason: 'authenticated_ledger_required',
    })
    expect(
      issueAnalogCashScenario({ ...input, donorLedger: structuredClone(input.donorLedger) }),
    ).toMatchObject({
      status: 'unqualified',
      reason: 'authenticated_ledger_required',
    })
  })
  it('freezes independent ledger evidence against later caller mutation', () => {
    const input = request(),
      before = issueAnalogCashScenario(input)
    state.observations
      .at(-1)
      .subjects.find((s: any) => s.destination === target.destination).cashRaw = '0'
    expect(issueAnalogCashScenario(input)).toEqual(before)
  })
  it.each(['zero', 'stale', 'absent'])('keeps %s current cash unqualified', (change) => {
    const current = state.observations.at(-1)
    if (change === 'zero')
      current.subjects.find((s: any) => s.destination === target.destination).cashRaw = '0'
    if (change === 'stale') current.source.blockAt = new Date(now - 3600000).toISOString()
    if (change === 'absent') state.observations.pop()
    expect(issueAnalogCashScenario(request())).toMatchObject({
      status: 'unqualified',
      reason:
        change === 'zero'
          ? 'zero_current_cash_has_no_normalization_base'
          : change === 'stale'
            ? 'source_stale'
            : 'authenticated_current_source_unavailable',
    })
  })
  it('preserves native errors and the source conflict gate', () => {
    expect(issueAnalogCashScenario({ ...request(), currentSourceConflict: true })).toMatchObject({
      reason: 'current_source_conflict',
    })
    expect(
      issueAnalogCashScenario({
        ...request(),
        nativeProjection: { status: 'unavailable', reason: 'history_unverified' },
      }),
    ).toMatchObject({ reason: 'history_unverified' })
  })
  it('authenticates actual reader output and rejects an identical copied live source', async () => {
    const input = request()
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValueOnce({
      status: 'available',
      sourceKind: 'live_read_only_two_origin_finalized',
      routeKey: target.route_key,
      destination: target.destination,
      asset: target.asset,
      assetDecimals: 6,
      cashRaw: '110000000',
      block: '26190001',
      blockHash: `0x${'c'.repeat(64)}`,
      blockAt: new Date(now - 500).toISOString(),
      readAtUtc: new Date(now).toISOString(),
    })
    const liveCurrent = await readAuthenticatedAnalogLiveCash(
      { routeKey: target.route_key, destination: target.destination },
      { manifest },
    )
    expect(issueAnalogCashScenario({ ...input, liveCurrent }).status).toBe('analog_cash_scenario')
    expect(
      issueAnalogCashScenario({ ...input, liveCurrent: structuredClone(liveCurrent) }),
    ).toMatchObject({ reason: 'authenticated_live_source_required' })
  })
  it('bypasses the general reader cache even when the caller requests caching', async () => {
    request()
    vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValueOnce({
      status: 'unavailable',
      reason: 'rpc_origins_unavailable',
    })
    await readAuthenticatedAnalogLiveCash(
      { routeKey: target.route_key, destination: target.destination },
      { manifest, cache: true },
    )
    expect(readConfiguredLiveCurrentCash).toHaveBeenCalledWith(
      { routeKey: target.route_key, destination: target.destination },
      { manifest, cache: false, maxSourceAgeMs: 1800000 },
    )
  })
  it.each(['rpcUrls', 'clientFactory', 'readVault', 'readDirect', 'clock', 'origins'])(
    'rejects caller %s injection before invoking the configured reader',
    async (key) => {
      request()
      const options = { manifest, [key]: key === 'rpcUrls' ? 'https://fake.invalid' : () => ({}) }
      expect(
        await readAuthenticatedAnalogLiveCash(
          { routeKey: target.route_key, destination: target.destination },
          options,
        ),
      ).toMatchObject({ status: 'unavailable', reason: 'unsupported_live_read_options' })
      expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
    },
  )
  it('rejects unverified or copied manifests before invoking the configured reader', async () => {
    expect(
      await readAuthenticatedAnalogLiveCash(
        { routeKey: target.route_key, destination: target.destination },
        { manifest },
      ),
    ).toMatchObject({ reason: 'authenticated_manifest_required' })
    request()
    expect(
      await readAuthenticatedAnalogLiveCash(
        { routeKey: target.route_key, destination: target.destination },
        { manifest: structuredClone(manifest) },
      ),
    ).toMatchObject({ reason: 'authenticated_manifest_required' })
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
  })
  it('rejects caller-selected receipt directories before granting ledger provenance', () => {
    expect(() => verifyAnalogCashLedger(manifest, '/private/tmp/caller-fabricated-cash')).toThrow(
      'unsupported_analog_cash_root',
    )
  })
  it('reconstructs private own history even when the caller falsely labels it insufficient', () => {
    state.observations = fixture(false)
    expect(issueAnalogCashScenario(request())).toMatchObject({
      status: 'unqualified',
      reason: 'own_native_history_preferred',
    })
  })
  it.each(['cash_origin_disagreement', 'finalized_block_disagreement'])(
    'censors actual %s instead of reverting to fresh sealed current cash',
    async (reason) => {
      const input = request()
      vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValueOnce({
        status: 'unavailable',
        reason,
      })
      const liveCurrent = await readAuthenticatedAnalogLiveCash(
        { routeKey: target.route_key, destination: target.destination },
        { manifest },
      )
      expect(issueAnalogCashScenario({ ...input, liveCurrent })).toMatchObject({
        status: 'unqualified',
        reason: 'current_source_conflict',
      })
    },
  )
  it('does not treat generic ERC4626/foreign native units as a reviewed mechanism', () => {
    expect(reviewedAnalogCashSubject({ ...target, destination: `0x${'1'.repeat(40)}` })).toBeNull()
    const eurcv = histories.find((h) => h.identity.routeKey === 'EURCV → VaultV2 [EURCV]')!
    expect(
      reviewedAnalogCashSubject({
        route_key: eurcv.identity.routeKey,
        destination: eurcv.identity.destination,
        asset: eurcv.identity.asset,
      })?.identity.assetDecimals,
    ).toBe(18)
  })
})

describe('actual carry forecast API analog CASH field', () => {
  it('attaches a concrete fallback alongside unavailable sparse native history with exact Q/horizon', async () => {
    const { code, body } = await api({ amountUnits: '2.5', horizonHours: '48' })
    expect(code).toBe(200)
    expect(body.conditionalSampledCashPathProjection).toMatchObject({
      status: 'unavailable',
      reason: 'insufficient_eligible_history',
    })
    expect(body.analogCashScenario).toMatchObject({
      status: 'analog_cash_scenario',
      Ea: null,
      prior: {
        input: { requestedRaw: '2500000', horizonHours: 48 },
        targetAtUtc: '2026-10-10T12:00:00.000Z',
      },
    })
    expect(readConfiguredLiveCurrentCash).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['1', '24', '48', '168'])('prefers own native history at H%s', async (horizonHours) => {
    state.observations = fixture(false)
    const { code, body } = await api({ horizonHours })
    expect(code).toBe(200)
    expect(body.conditionalSampledCashPathProjection.status).toBe('estimated')
    expect(body.analogCashScenario).toMatchObject({
      status: 'unqualified',
      reason: 'own_native_history_preferred',
    })
  })
  it.each(['cash_origin_disagreement', 'finalized_block_disagreement'])(
    'preserves actual %s in the API despite a fresh sealed fallback',
    async (reason) => {
      vi.mocked(readConfiguredLiveCurrentCash).mockResolvedValueOnce({
        status: 'unavailable',
        reason,
      })
      const { code, body } = await api({ includeLiveCurrent: '1' })
      expect(code).toBe(200)
      expect(readConfiguredLiveCurrentCash).toHaveBeenCalledOnce()
      expect(readConfiguredLiveCurrentCash).toHaveBeenCalledWith(
        { routeKey: target.route_key, destination: target.destination },
        expect.objectContaining({ cache: false }),
      )
      expect(body.analogCashScenario).toMatchObject({
        status: 'unqualified',
        reason: 'current_source_conflict',
      })
    },
  )
})
