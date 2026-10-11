import { readFileSync } from 'node:fs'
import { encodeFunctionData, parseAbi, keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  issuedUsd3JointHolderForecast as issue,
  selectedUsd3JointHolderForecast as select,
  usd3JointHolderForecastRenderWindow as renderWindow,
  usd3JointHolderForecastIssue as receipt,
  selectedUsd3JointHolderForecastIssue as selectReceipt,
  usd3JointHolderForecastFromResponse as responseModel,
  usd3JointHolderForecastIssueFromResponse as responseReceipt,
  type Usd3JointHolderForecastQuestion,
  selectedUsd3JointHolderForecastFromIssue as modelFromReceipt,
} from '@/lib/carry/usd3JointHolderForecastBinding'
import { encodeUsd3JointNativeHistoryEvidence } from '@/lib/carry/usd3JointNativeEvidenceCodec'
import { resolveUsd3JointTrustedProfile } from '@/lib/carry/usd3JointTrustedProfile'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
  selectedHolderExitCapacity,
  type HolderExitCapacityFacts,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import type { Usd3NativeCapacityFact } from '@/lib/carry/usd3ExitQuote'
import { ROUTES } from '@/components/Carry/fixtures'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import config from '@/tools/venue-recorder.config.json'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import {
  buildCanonicalAtomicHolderExitSubjects,
  type HolderExitConditionalProjectionEvidence,
} from '@/lib/carry/holderExitMechanisms'

const subjects = buildCanonicalAtomicHolderExitSubjects(
  buildCarryForecastRegistry(
    ROUTES,
    seed,
    config.venues,
    '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    verifiedDirectSupplyDestinations(),
  ),
)
const route = 'USDC → USD3 [USDC]',
  vault = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
  asset = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const owner = '0x' + 'c'.repeat(40),
  now = Date.parse('2026-10-08T12:15:00.000Z')
const profile = resolveUsd3JointTrustedProfile(route, vault, asset)!
const abi = parseAbi(['function availableWithdrawLimit(address) view returns (uint256)'])
// Encode the same archived original once. Each fixture receives a deep private
// copy before applying unsigned research transformations; the retained baseline
// is never passed to the issuer or mutated by a case. Encoding grants no authority.
const nativeHistoryBaseline = encodeUsd3JointNativeHistoryEvidence(
  JSON.parse(
    readFileSync(
      new URL(
        '../../data/research/venue-signals/usd3-joint-native-history-evidence-2026-10-08/native-originals/01-native-historical-capture.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ),
)
function fixture(H = 1, Q = '1000000') {
  const history = structuredClone(nativeHistoryBaseline)
  // Public unsigned claims are consistently transformed for this synthetic question.
  // This does not create independently authenticated owner-bound historical evidence.
  history.subject.withdrawalLimitSubject = owner
  for (const o of history.origins)
    for (const a of o.anchors) {
      const t = a.find((t) => t.key === 'withdrawal_limit')!
      ;(t.request.params[0] as { data: string }).data = encodeFunctionData({
        abi,
        functionName: 'availableWithdrawLimit',
        args: [owner as `0x${string}`],
      })
    }
  const source = {
    chainId: 1 as const,
    blockNumber: 26150000,
    blockHash: '0x' + 'f'.repeat(64),
    blockTime: '2026-10-08T12:05:00.000Z',
    finalized: true as const,
  }
  const question: Usd3JointHolderForecastQuestion = {
    routeKey: route,
    destination: vault,
    requestedHolderAddress: owner,
    requestedRaw: Q,
    requestedAssetAddress: asset,
    requestedAssetDecimals: 6,
    horizonHours: H,
    asOfMs: now,
    independentSource: structuredClone(source),
  }
  const assessment = {
    status: 'partial',
    routeKey: route,
    destinationAddress: vault,
    owner,
    request: { assetsRaw: Q, assetAddress: asset, horizonHours: H },
    source: { ...source, originValidation: 'single_provider' },
    stages: [],
    finalPayout: { status: 'unavailable', assetAddress: asset, amountRaw: null },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  } as unknown as HolderExitAssessment
  const native: Usd3NativeCapacityFact = {
    owner,
    method: 'availableWithdrawLimit(address)',
    asset: asset as `0x${string}`,
    assetDecimals: 6,
    unit: 'raw_usdc_6',
    capacityRaw: '2000000',
    resultStatus: 'quoted',
    shutdown: false,
    readAtUtc: '2026-10-08T12:11:00.000Z',
    source,
    runtimeProfile: {
      sourceClass: 'pinned_usd3_native_runtime',
      shareDecimals: 6,
      contracts: profile.runtimePins.map((p) => ({
        address: p.address,
        code: history.codeDictionary[p.key] as `0x${string}`,
        keccak256: keccak256(history.codeDictionary[p.key] as `0x${string}`),
      })) as NonNullable<Usd3NativeCapacityFact['runtimeProfile']>['contracts'],
    },
  }
  const facts: HolderExitCapacityFacts = {
    entitlementRaw: '1000000',
    fullPositionEntitlementRaw: '1000000',
    quotedMaxWithdrawRaw: '5',
    quotedMaxWithdrawStatus: 'quoted',
    effectiveLimitRaw: null,
    withdrawalsPaused: null,
    sourceHolderPosition: {
      sharesRaw: history.subject.sharesRaw,
      shareDecimals: 6,
      method: 'balance_of_owner_at_source',
    },
    usd3NativeCapacity: native,
  }
  const quote = buildHolderExitCapacityQuote(assessment, facts, now)!
  const capacity = agreeHolderExitCapacityQuotes(
    { host: profile.originHosts[0], quote },
    { host: profile.originHosts[1], quote: structuredClone(quote) },
    now,
  )!
  return { history, source, question, assessment, facts, capacity }
}
function reAgree(f: ReturnType<typeof fixture>) {
  return agreeHolderExitCapacityQuotes(
    f.capacity.origins[0],
    f.capacity.origins[1],
    f.question.asOfMs,
  )!
}
function successfulFixture() {
  const f = fixture(),
    Q = f.question.requestedRaw!
  const assessment = structuredClone(f.assessment)
  assessment.status = 'assessed'
  assessment.stages = [
    {
      name: 'withdrawal',
      assetAddress: asset as `0x${string}`,
      amountRaw: Q,
      relatedToRequest: true,
      status: 'simulated',
    },
  ]
  assessment.finalPayout = {
    status: 'simulated',
    assetAddress: asset as `0x${string}`,
    amountRaw: Q,
  }
  const quote = buildHolderExitCapacityQuote(
    assessment,
    { ...f.facts, quotedMaxWithdrawRaw: '2000000' },
    now,
  )!
  const capacity = agreeHolderExitCapacityQuotes(
    { host: profile.originHosts[0], quote },
    { host: profile.originHosts[1], quote: structuredClone(quote) },
    now,
  )!
  const question = {
    routeKey: route,
    destinationAddress: vault,
    owner,
    assetsRaw: Q,
    finalAssetAddress: asset,
    finalAssetDecimals: 6,
  }
  const subject = subjects.find((s) => s.routeKey === route && s.destinationAddress === vault)!
  const executionAgreement: HolderExitConditionalProjectionEvidence = {
    question: structuredClone(question),
    routeAndContractIdentityVerified: true,
    inputAndFinalAssetAddressesVerified: true,
    simulations: profile.originHosts.map((originHost) => ({
      question: structuredClone(question),
      originHost,
      source: structuredClone(f.source),
      kind: 'full_route_execution',
      execution: 'single_call',
      fullRouteExecutionVerified: true,
      requiredStages: subject.stages.map((name) => ({ name, status: 'executed' as const })),
      finalAssetAmountRaw: Q,
      status: 'simulated',
    })),
  }
  return { ...f, assessment, capacity, executionAgreement }
}
describe('private USD3 holder forecast from agreed current facts and unsigned native history claims', () => {
  it('accepts legitimate acyclic source/profile/array aliases while privately cloning and retaining the original current agreement', () => {
    const f = fixture()
    const binding = {
      routeKey: route,
      destination: vault,
      owner,
      requestedRaw: f.question.requestedRaw!,
      asset,
      assetDecimals: 6,
      currentSource: f.source,
      asOfMs: now,
    }
    // Check the fixture at the existing capacity boundary independently of this binding.
    expect(selectedHolderExitCapacity(f.capacity, binding)).not.toBeNull()
    const sharedSource = f.capacity.quote.source,
      sharedProfile = f.capacity.quote.usd3NativeCapacity!.runtimeProfile!
    for (const q of [f.capacity.quote, ...f.capacity.origins.map((o) => o.quote)]) {
      q.source = sharedSource
      q.usd3NativeCapacity!.source = sharedSource
      q.usd3NativeCapacity!.runtimeProfile = sharedProfile
    }
    // These references are aliases, not an ancestor cycle, and satisfy exact native consensus.
    expect(f.capacity.origins[0].quote.source).toBe(f.capacity.origins[1].quote.source)
    expect(f.capacity.origins[0].quote.usd3NativeCapacity!.runtimeProfile!.contracts).toBe(
      sharedProfile.contracts,
    )
    expect(selectedHolderExitCapacity(f.capacity, binding)).not.toBeNull()
    const m = issue(f.capacity, f.history, f.question)!
    expect(m).not.toBeNull()
    const question = structuredClone(f.question),
      r = receipt(m)!
    sharedSource.blockHash = '0x' + 'e'.repeat(64)
    sharedProfile.contracts[0].code = '0x6001'
    f.capacity.quote.sourceHolderPosition!.sharesRaw = '2'
    expect(m.source.blockHash).toBe(f.source.blockHash)
    expect(m.sharesRaw).toBe('1000000')
    expect(modelFromReceipt(r, question, now + 1000)).toBe(m)
  })
  it('rejects direct and array ancestor cycles and untouched getter inputs without accepting cyclic execution proof', () => {
    const f = fixture()
    const cycle = structuredClone(f.capacity) as typeof f.capacity & { cycle?: unknown }
    cycle.cycle = cycle
    expect(issue(cycle, f.history, f.question)).toBeNull()
    const arrayCycle = structuredClone(f.capacity)
    ;(arrayCycle.origins as unknown[]).push(arrayCycle.origins)
    expect(issue(arrayCycle, f.history, f.question)).toBeNull()
    const execution: { simulations: unknown[] } = { simulations: [] }
    execution.simulations.push(execution)
    expect(issue(f.capacity, f.history, f.question, execution)).toBeNull()
    let touched = false
    const accessor = structuredClone(f.capacity)
    Object.defineProperty(accessor, 'quote', {
      enumerable: true,
      get() {
        touched = true
        return f.capacity.quote
      },
    })
    expect(issue(accessor, f.history, f.question)).toBeNull()
    expect(touched).toBe(false)
  })
  it.each([1, 24, 48, 168])(
    'retains H%s joint math and full-position metadata with no original authentication',
    (H) => {
      const f = fixture(H),
        m = issue(f.capacity, f.history, f.question)!
      expect(m).not.toBeNull()
      expect(m.issueAtUtc).toBe(new Date(now).toISOString())
      expect(m.targetAtUtc).toBe(new Date(now + H * 3600000).toISOString())
      expect(m.input.current.readAtUtc).toBe('2026-10-08T12:11:00.000Z')
      expect(m.knowledgeCutoffUtc).toBe('2026-10-08T12:11:00.000Z')
      expect(m.process.input).toEqual(m.input)
      expect(m.input.history).toHaveLength(4)
      expect(m.process.intervalInputs).toHaveLength(3)
      expect(m.counts.attempted).toBe(3)
      expect(m).toMatchObject({
        profileId: profile.id,
        sharesRaw: '1000000',
        fullEaRaw: '1000000',
        requestedRaw: '1000000',
        asset,
        assetDecimals: 6,
        shareDecimals: 6,
        MRaw: null,
        ownerMaxWithdrawRaw: '5',
        ownerMaxWithdrawIsFutureFunding: false,
        authenticated: false,
        originalAuthority: false,
        authoritativeNativeCapture: false,
        historicalPastOwnershipProven: false,
        historicalOwnership: false,
        ownerCommitmentQualified: false,
        holderExecutableExit: false,
        executionProven: false,
        forecastValidated: false,
        prospectiveValidated: false,
        calibrationProven: false,
        calibratedProbability: false,
      })
      expect(Object.isFrozen(m.process.intervalInputs[0].input)).toBe(true)
      expect(select(m, f.question)).toBe(m)
    },
  )
  it('subtracts Q once without changing independent full S/Ea or donor flows', () => {
    const a = fixture(),
      b = fixture(1, '500000')
    const x = issue(a.capacity, a.history, a.question)!,
      y = issue(b.capacity, b.history, b.question)!
    expect(x.fullEaRaw).toBe(y.fullEaRaw)
    expect(x.sharesRaw).toBe(y.sharesRaw)
    expect(x.process.scenarios.map((s) => s.donor.jointDeltaRaw)).toEqual(
      y.process.scenarios.map((s) => s.donor.jointDeltaRaw),
    )
    for (let n = 0; n < x.process.scenarios.length; n++) {
      const one = x.process.scenarios[n].targetHeadroomRaw,
        two = y.process.scenarios[n].targetHeadroomRaw
      if (one !== null && two !== null) expect(BigInt(two) - BigInt(one)).toBe(500000n)
    }
  })
  it('selects only original models/receipts and complete original questions while render time advances separately', () => {
    const f = fixture(),
      m = issue(f.capacity, f.history, f.question)!,
      r = receipt(m)!
    expect(r).toMatchObject({
      issuedAtMs: now,
      source: f.source,
      owner,
      sharesRaw: '1000000',
      fullEaRaw: '1000000',
      block: String(f.source.blockNumber),
    })
    expect(selectReceipt(r, f.question, now + 1000)).toBe(r)
    expect(select(structuredClone(m), f.question)).toBeNull()
    expect(selectReceipt(structuredClone(r), f.question)).toBeNull()
    expect(receipt(JSON.parse(JSON.stringify(m)))).toBeNull()
    for (const patch of [
      { requestedRaw: '2' },
      { horizonHours: 24 },
      { requestedHolderAddress: vault },
      { requestedAssetAddress: vault },
      { asOfMs: now + 1 },
      { independentSource: { ...f.source, blockHash: '0x' + 'e'.repeat(64) } },
    ]) {
      expect(select(m, { ...f.question, ...patch })).toBeNull()
      expect(selectReceipt(r, { ...f.question, ...patch })).toBeNull()
    }
    expect(renderWindow(m, now - 1)).toBe(false)
    expect(renderWindow(m, Date.parse(f.source.blockTime) + 1800000)).toBe(true)
    expect(renderWindow(m, Date.parse(f.source.blockTime) + 1800001)).toBe(false)
    expect(renderWindow(m, Date.parse(m.targetAtUtc))).toBe(false)
    f.question.requestedRaw = '2'
    f.history.subject.sharesRaw = '9'
    f.capacity.quote.entitlementRaw = '1'
    expect(m.input.requestedRaw).toBe('1000000')
    expect(m.input.history[0].hypotheticalSharesRaw).toBe('1000000')
  })
  it('requires own original read clocks and shutdown false on aggregate and both origins', () => {
    for (const location of ['aggregate', 'first', 'second'] as const)
      for (const change of [
        'omitRead',
        'nullRead',
        'futureRead',
        'beforeBlock',
        'badUTC',
        'omitShutdown',
        'trueShutdown',
        'nullShutdown',
      ] as const) {
        const f = fixture(),
          fact =
            location === 'aggregate'
              ? f.capacity.quote.usd3NativeCapacity!
              : f.capacity.origins[location === 'first' ? 0 : 1].quote.usd3NativeCapacity!
        if (change === 'omitRead') delete fact.readAtUtc
        if (change === 'nullRead') fact.readAtUtc = null
        if (change === 'futureRead') fact.readAtUtc = new Date(now + 1).toISOString()
        if (change === 'beforeBlock') fact.readAtUtc = '2026-10-08T12:04:59.000Z'
        if (change === 'badUTC') fact.readAtUtc = '2026-10-08T12:11:00Z'
        if (change === 'omitShutdown') delete fact.shutdown
        if (change === 'trueShutdown') fact.shutdown = true
        if (change === 'nullShutdown') fact.shutdown = null
        expect(issue(f.capacity, f.history, f.question), `${location}:${change}`).toBeNull()
      }
    const f = fixture()
    for (const origin of f.capacity.origins) delete origin.quote.usd3NativeCapacity!.readAtUtc
    expect(issue(reAgree(f), f.history, f.question)).toBeNull()
  })
  it('rejects source/S/owner/units/pinned runtime changes and stale or future acquisition clocks', () => {
    for (const edit of [
      (f: ReturnType<typeof fixture>) => {
        f.history.subject.sharesRaw = '2'
      },
      (f: ReturnType<typeof fixture>) => {
        f.history.subject.withdrawalLimitSubject = vault
      },
      (f: ReturnType<typeof fixture>) => {
        f.history.codeDictionary.proxy_code = '0x6001'
      },
      (f: ReturnType<typeof fixture>) => {
        f.capacity.origins[0].host = 'fake.example'
      },
      (f: ReturnType<typeof fixture>) => {
        f.question.requestedHolderAddress = '0x' + '0'.repeat(40)
      },
      (f: ReturnType<typeof fixture>) => {
        f.question.asOfMs = Date.parse(f.source.blockTime) + 1800001
      },
      (f: ReturnType<typeof fixture>) => {
        f.question.asOfMs = Date.parse('2026-10-08T12:10:00.000Z')
      },
    ]) {
      const f = fixture()
      edit(f)
      expect(issue(f.capacity, f.history, f.question)).toBeNull()
    }
    const sameBlock = fixture()
    sameBlock.question.independentSource = {
      ...sameBlock.source,
      blockNumber: sameBlock.source.blockNumber + 1,
    }
    expect(issue(sameBlock.capacity, sameBlock.history, sameBlock.question)).toBeNull()
    const zeroShares = fixture()
    zeroShares.capacity.quote.sourceHolderPosition!.sharesRaw = '0'
    expect(issue(zeroShares.capacity, zeroShares.history, zeroShares.question)).toBeNull()
    const futureHistory = fixture()
    futureHistory.question.asOfMs = Date.parse('2026-10-08T12:10:00.000Z')
    for (const o of futureHistory.capacity.origins)
      o.quote.usd3NativeCapacity!.readAtUtc = '2026-10-08T12:09:00.000Z'
    expect(issue(reAgree(futureHistory), futureHistory.history, futureHistory.question)).toBeNull()
  })
  it('retains native zero C, excludes unsupported adjacent donors, and rejects unknown current C', () => {
    const f = fixture()
    for (const o of f.capacity.origins) o.quote.usd3NativeCapacity!.capacityRaw = '0'
    const zero = issue(reAgree(f), f.history, f.question)!
    expect(zero).not.toBeNull()
    expect(zero.currentMeasurement.nativeLimitRaw).toBe('0')
    for (const o of f.history.origins) {
      const t = o.anchors[0].find((t) => t.key === 'withdrawal_limit')!
      t.response = {
        jsonrpc: '2.0',
        id: t.request.id,
        error: { code: -32000, message: 'native_withdrawal_limit_unavailable' },
      }
    }
    const partial = issue(reAgree(f), f.history, f.question)!
    expect(partial).not.toBeNull()
    expect(partial.counts.excluded).toBe(1)
    expect(partial.process.targetSummary).toBeNull()
    expect(partial.input.history[0].availableWithdrawLimitRaw).toBeNull()
    for (const o of f.capacity.origins) {
      o.quote.usd3NativeCapacity!.capacityRaw = null
      o.quote.usd3NativeCapacity!.resultStatus = 'unsupported'
    }
    expect(issue(reAgree(f), f.history, f.question)).toBeNull()
  })
  it('rejects input getters and sparse/extra bounded question data before access', () => {
    const f = fixture()
    let touched = false
    const q = structuredClone(f.question)
    Object.defineProperty(q, 'asOfMs', {
      enumerable: true,
      get() {
        touched = true
        return now
      },
    })
    expect(issue(f.capacity, f.history, q)).toBeNull()
    expect(touched).toBe(false)
    const m = issue(f.capacity, f.history, f.question)!
    expect(select(m, q)).toBeNull()
    expect(touched).toBe(false)
    const capacity = structuredClone(f.capacity)
    Object.defineProperty(capacity, 'quote', {
      enumerable: true,
      get() {
        touched = true
        return f.capacity.quote
      },
    })
    expect(issue(capacity, f.history, f.question)).toBeNull()
    expect(touched).toBe(false)
    const sparse = structuredClone(f.history)
    delete sparse.origins[0].anchors[0][1]
    expect(issue(f.capacity, sparse, f.question)).toBeNull()
    expect(
      issue(f.capacity, f.history, {
        ...f.question,
        approve: () => true,
      } as Usd3JointHolderForecastQuestion),
    ).toBeNull()
  })
  it('reconstructs privately from successful or matching capacity-only responses and rejects serialized issue claims', () => {
    const f = fixture(),
      body = { capacityAgreement: f.capacity, usd3JointHistoricalEvidence: f.history }
    expect(responseModel(body, 200, f.question)).not.toBeNull()
    expect(
      responseReceipt({ ...body, error: 'holder_exit_assessment_unavailable' }, 503, f.question),
    ).not.toBeNull()
    expect(responseModel(body, 503, f.question)).toBeNull()
    expect(responseModel(body, 500, f.question)).toBeNull()
    expect(
      responseModel({ ...body, usd3JointHistoricalEvidence: undefined }, 200, f.question),
    ).toBeNull()
    expect(responseModel({ forecastValidated: true, receipt: {} }, 200, f.question)).toBeNull()
  })
  it('preserves actual successful 200 capacity through matching execution evidence while future execution remains unproven', () => {
    const f = successfulFixture()
    expect(f.capacity.quote.successfulRequestedRawLowerBound).toBe(f.question.requestedRaw)
    expect(
      f.capacity.origins.every(
        (o) => o.quote.successfulRequestedRawLowerBound === f.question.requestedRaw,
      ),
    ).toBe(true)
    const body = {
      capacityAgreement: f.capacity,
      usd3JointHistoricalEvidence: f.history,
      executionAgreement: f.executionAgreement,
    }
    const m = responseModel(body, 200, f.question)!
    expect(m).not.toBeNull()
    expect(issue(f.capacity, f.history, f.question, f.executionAgreement)).not.toBeNull()
    expect(m).toMatchObject({
      holderExecutableExit: false,
      executionProven: false,
      forecastValidated: false,
      calibratedProbability: false,
      authenticated: false,
      originalAuthority: false,
    })
    expect(modelFromReceipt(receipt(m), f.question, now + 1000)).toBe(m)
    expect(
      responseModel(
        { capacityAgreement: f.capacity, usd3JointHistoricalEvidence: f.history },
        200,
        f.question,
      ),
    ).toBeNull()
    expect(issue(f.capacity, f.history, f.question)).toBeNull()
    expect(issue(f.capacity, f.history, f.question, { executionVerified: true })).toBeNull()
    for (const change of ['source', 'Q', 'owner'] as const) {
      const proof = structuredClone(f.executionAgreement)
      if (change === 'source') proof.simulations[0].source.blockHash = '0x' + 'e'.repeat(64)
      if (change === 'Q') proof.question.assetsRaw = '2'
      if (change === 'owner') proof.question.owner = vault
      expect(responseModel({ ...body, executionAgreement: proof }, 200, f.question)).toBeNull()
    }
    let touched = false
    const accessor = structuredClone(f.executionAgreement)
    Object.defineProperty(accessor, 'question', {
      enumerable: true,
      get() {
        touched = true
        return f.executionAgreement.question
      },
    })
    expect(issue(f.capacity, f.history, f.question, accessor)).toBeNull()
    expect(touched).toBe(false)
  })
  it('retrieves the original issued model by receipt even after retained historical/current payloads change', () => {
    const f = successfulFixture(),
      originalQuestion = structuredClone(f.question)
    const m = issue(f.capacity, f.history, f.question, f.executionAgreement)!,
      r = receipt(m)!
    const before = JSON.stringify(m)
    f.history.subject.sharesRaw = '2'
    f.history.subject.withdrawalLimitSubject = vault
    for (const o of f.history.origins) {
      const t = o.anchors[0].find((t) => t.key === 'native_ea')!
      t.response = { jsonrpc: '2.0', id: t.request.id, result: '0x' + '0'.repeat(63) + '1' }
    }
    for (const q of [f.capacity.quote, ...f.capacity.origins.map((o) => o.quote)]) {
      q.sourceHolderPosition!.sharesRaw = '2'
      q.entitlementRaw = '2'
      q.fullPositionEntitlementRaw = '2'
      q.usd3NativeCapacity!.capacityRaw = '1'
      q.usd3NativeCapacity!.readAtUtc = new Date(now).toISOString()
    }
    f.executionAgreement.question.owner = vault
    f.question.asOfMs = now + 1
    expect(modelFromReceipt(r, originalQuestion, now + 1000)).toBe(m)
    expect(JSON.stringify(m)).toBe(before)
    expect(modelFromReceipt(r, f.question)).toBeNull()
    expect(modelFromReceipt(structuredClone(r), originalQuestion)).toBeNull()
    expect(modelFromReceipt(JSON.parse(JSON.stringify(r)), originalQuestion)).toBeNull()
    expect(modelFromReceipt({ ...r, sharesRaw: '2' }, originalQuestion)).toBeNull()
    expect(modelFromReceipt(r, { ...originalQuestion, requestedRaw: '2' })).toBeNull()
    expect(modelFromReceipt(r, { ...originalQuestion, horizonHours: 24 })).toBeNull()
    expect(
      modelFromReceipt(r, originalQuestion, Date.parse(f.source.blockTime) + 1800001),
    ).toBeNull()
  })
})
