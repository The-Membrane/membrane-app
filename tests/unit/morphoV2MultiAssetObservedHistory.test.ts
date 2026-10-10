import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { encodeFunctionResult, parseAbi } from 'viem'
import {
  MORPHO_V2_MULTI_ASSET_OBSERVED_HISTORY_PINS as PINS,
  MORPHO_V2_MULTI_ASSET_OBSERVED_PARENT_PINS as PARENT,
  loadMorphoV2MultiAssetObservedProtocolHistory,
  replayMorphoV2MultiAssetObservedProtocolHistory,
  type MorphoV2MultiAssetObservedArchiveTexts,
} from '@/lib/carry/morphoV2MultiAssetObservedHistory.server'
import {
  approveReviewedMorphoV2ProtocolHistory,
  reviewedMorphoV2ProtocolHistory,
} from '@/lib/carry/morphoV2ReviewedProtocolHistories'
import {
  isAppOwnedMorphoV2TrustedProfile,
  resolveMorphoV2TrustedProfile,
  type MorphoV2TrustedProfile,
} from '@/lib/carry/morphoV2TrustedProfiles'
import {
  morphoV2ProtocolReadPlan,
  type MorphoV2ProtocolCapacityObservation,
} from '@/lib/carry/morphoV2ProtocolCapacityReplay'
import { morphoV2AdapterCapacityMath } from '@/lib/carry/morphoV2AdapterCapacityMath'
import { encodeMorphoV2ProtocolEvidencePair } from '@/lib/carry/morphoV2ProtocolEvidenceCodec'
import {
  approveMorphoV2HolderPositionEvidence,
  encodeMorphoV2HolderPositionEvidence,
} from '@/lib/carry/morphoV2HolderPositionEvidence'
import {
  encodeMorphoV2HistoricalHolderEaEvidencePair,
  morphoV2HistoricalHolderEaCalldata,
  selectMorphoV2HistoricalHolderEaAnchors,
} from '@/lib/carry/morphoV2HistoricalHolderEaEvidence'
import { issuedMorphoV2JointHolderForecast } from '@/lib/carry/morphoV2JointHolderForecastBinding'
import { prewarmMorphoV2ProtocolHistory } from '@/lib/carry/morphoV2CurrentProtocolCapacityEvidence'
import {
  agreeHolderExitCapacityQuotes,
  buildHolderExitCapacityQuote,
} from '@/lib/carry/holderExitCapacity'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  createMorphoV2JointHolderForecastFixture,
  jointUint,
} from './fixtures/morphoV2JointHolderForecastFixture'

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const read = (path: string) => readFileSync(path, 'utf8')
const keys = [
  [
    'AUSD → VaultV2 [AUSD]',
    '0x32401b9fb79065bc15949de0bd43927492f02f0c',
    '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
  ],
  [
    'EURCV → VaultV2 [EURCV]',
    '0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f',
    '0x5f7827fdeb7c20b443265fc2f40845b715385ff2',
  ],
  [
    'LINK → VaultV2 [LINK]',
    '0x610f5b68bd1eed68af649a3fd3dc2caa1ee4ae7e',
    '0x514910771af9ca656af840dff83e8264ecf986ca',
  ],
] as const
function archive(profile: MorphoV2TrustedProfile): MorphoV2MultiAssetObservedArchiveTexts {
  const pin = PINS[profile.id]
  return {
    terminalText: read(pin.directory + '/terminal.json'),
    inputPlanText: read(pin.directory + '/input-plan.json'),
    parentAuditText: read(PARENT.audit.path),
    parentClockManifestText: read(PARENT.clocks.path),
    parentClockProofText: read(pin.parentClockPath),
    points: [0, 1, 2].map((index) => ({
      factsText: read(pin.directory + `/point_${index}-facts.json`),
      originalsText: read(pin.directory + `/point_${index}-originals.json`),
    })),
  }
}

/** Synthetic future headers and actual-holder bytes for gate testing only.
 * Native archived economic units/configuration are retained; the holder is new.
 * No retained S=1e18 research preview is used as the holder's historical Ea. */
function holderFixture(
  profile: MorphoV2TrustedProfile,
  texts: MorphoV2MultiAssetObservedArchiveTexts,
  sharesRaw: string,
) {
  const base = createMorphoV2JointHolderForecastFixture('USDT', sharesRaw, true)
  const start = Date.parse('2026-10-09T12:00:00.000Z')
  const utc = (offset: number) => new Date(start + offset).toISOString()
  const source = { ...base.expected.source, blockNumber: 26200000, blockTime: utc(0) }
  const expected = { ...base.expected, profile, source, asOfMs: start + 10000 }
  const native = JSON.parse(texts.points[0].factsText).nativeFacts
  const original = JSON.parse(texts.points[0].originalsText)
  const market = native.market.map(BigInt) as bigint[]
  market[4] = BigInt(start / 1000)
  const math = morphoV2AdapterCapacityMath({
    market,
    at: BigInt(start / 1000),
    borrowRate: BigInt(native.borrowRate),
    internalShares: BigInt(native.internalSupplyShares),
    actualShares: BigInt(native.position[0]),
    blueCash: BigInt(native.blueCash),
    allowance: BigInt(native.adapterAllowance),
    idleCash: BigInt(native.idle),
    allocations: [0, 1, 2].map((index) => BigInt(native['allocation' + index])),
    enrolled: true,
  })
  const specs = morphoV2ProtocolReadPlan(source, market, profile)
  const pair: MorphoV2ProtocolCapacityObservation = {
    origins: expected.originHosts.map((host) => ({
      host,
      observation: {
        source: structuredClone(source),
        startedAtUtc: utc(1000),
        readAtUtc: utc(4100),
        deadlineMs: 8000,
        traces: specs.map((spec, index) => {
          let result: unknown
          if (spec.key.startsWith('header_'))
            result = {
              number: `0x${source.blockNumber.toString(16)}`,
              hash: source.blockHash,
              timestamp: `0x${(BigInt(start) / 1000n).toString(16)}`,
            }
          else if (spec.key === 'market')
            result = encodeFunctionResult({
              abi: parseAbi([
                'function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)',
              ]),
              functionName: 'market',
              result: market as unknown as readonly [
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
                bigint,
              ],
            })
          else if (spec.key === 'borrowRate') result = jointUint(BigInt(native.borrowRate))
          else if (spec.key === 'adapterExpectedAssets')
            result = jointUint(BigInt(math.internalPositionAssetsRaw))
          else {
            const found = original.traces.find(
              (trace: any) =>
                trace.host === host &&
                trace.request.method === spec.method &&
                (typeof spec.params[0] === 'string'
                  ? trace.request.params[0].toLowerCase() === spec.params[0].toLowerCase()
                  : trace.request.params[0].to.toLowerCase() ===
                      (spec.params[0] as { to: string }).to.toLowerCase() &&
                    trace.request.params[0].data.toLowerCase() ===
                      (spec.params[0] as { data: string }).data.toLowerCase()),
            )
            if (!found) throw Error('missing_observed_fixture_prong_' + spec.key)
            result = found.envelope.result
          }
          return {
            key: spec.key,
            method: spec.method,
            params: structuredClone(spec.params),
            result,
            startedAtUtc: utc(1000 + index * 100),
            completedAtUtc: utc(1100 + index * 100),
          }
        }),
      },
    })),
  }
  const question = {
    ...base.question,
    routeKey: profile.subject.routeKey,
    destination: profile.subject.destination,
    requestedAssetAddress: profile.subject.asset,
    requestedAssetDecimals: profile.subject.assetDecimals,
    asOfMs: expected.asOfMs,
    independentSource: source,
  }
  const fullEaRaw = base.holderExpected.fullEaRaw
  const assessment = {
    status: 'assessed',
    routeKey: question.routeKey,
    destinationAddress: question.destination,
    owner: question.requestedHolderAddress,
    request: {
      assetsRaw: question.requestedRaw,
      assetAddress: question.requestedAssetAddress,
      horizonHours: question.horizonHours,
    },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        status: 'reverted',
        relatedToRequest: true,
        amountRaw: question.requestedRaw,
        assetAddress: question.requestedAssetAddress,
      },
    ],
    finalPayout: {
      status: 'unassessed',
      amountRaw: null,
      assetAddress: question.requestedAssetAddress,
    },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  } as HolderExitAssessment
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: fullEaRaw,
      quotedMaxWithdrawRaw: '0',
      quotedMaxWithdrawStatus: 'quoted',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
      sourceHolderPosition: { sharesRaw, shareDecimals: 18, method: 'balance_of_owner_at_source' },
    },
    question.asOfMs,
  )!
  const agreement = agreeHolderExitCapacityQuotes(
    { host: expected.originHosts[0], quote },
    { host: expected.originHosts[1], quote },
    question.asOfMs,
  )!
  const holderExpected = {
    ...base.holderExpected,
    ...profile.subject,
    destination: profile.subject.destination as `0x${string}`,
    asset: profile.subject.asset as `0x${string}`,
    source,
    asOfMs: question.asOfMs,
  }
  const holder = structuredClone(base.holder)
  for (const { observation } of holder.origins) {
    Object.assign(observation, profile.subject, {
      source,
      startedAtUtc: utc(5000),
      readAtUtc: utc(5200),
    })
    observation.traces.forEach((trace, index) => {
      trace.params[0].to = profile.subject.destination as `0x${string}`
      trace.params[1].blockHash = source.blockHash
      trace.startedAtUtc = utc(5000 + index * 100)
      trace.completedAtUtc = utc(5100 + index * 100)
    })
  }
  const historicalExpected = {
    ...base.historicalExpected,
    profile,
    currentSource: source,
    sharesRaw,
    asOfMs: question.asOfMs,
  }
  const historical = structuredClone(base.historical)
  const anchors = selectMorphoV2HistoricalHolderEaAnchors(profile, source)
  for (const { observation } of historical.origins) {
    Object.assign(observation, profile.subject, {
      profileId: profile.id,
      currentSource: source,
      sharesRaw,
      startedAtUtc: utc(6000),
      readAtUtc: utc(6200),
    })
    observation.traces = anchors.map((point, index) => ({
      source: point.source,
      key: 'previewRedeem',
      method: 'eth_call',
      params: [
        {
          to: profile.subject.destination as `0x${string}`,
          data: morphoV2HistoricalHolderEaCalldata(sharesRaw),
        },
        { blockHash: point.source.blockHash as `0x${string}`, requireCanonical: true },
      ],
      result: jointUint(1000001n + BigInt(index) * 77n),
      startedAtUtc: utc(6000 + index * 100),
      completedAtUtc: utc(6100 + index * 100),
    }))
  }
  const compactProtocol = encodeMorphoV2ProtocolEvidencePair(pair, expected, digest)!
  approveMorphoV2HolderPositionEvidence(holder, holderExpected)
  const compactHolder = encodeMorphoV2HolderPositionEvidence(holder)
  const compactHistorical = encodeMorphoV2HistoricalHolderEaEvidencePair(
    historical,
    historicalExpected,
  )!
  expect(compactProtocol).toBeTruthy()
  expect(compactHolder).toBeTruthy()
  expect(compactHistorical).toBeTruthy()
  const issue = (prior: unknown) =>
    issuedMorphoV2JointHolderForecast(
      agreement,
      undefined,
      compactProtocol,
      compactHolder,
      prior,
      question,
    )
  return { issue, compactHistorical, historical, historicalExpected }
}

describe('three app-owned observational Morpho histories', () => {
  it('bounds aggregate input and rejects sparse arrays or accessors before reading their values', () => {
    const profile = resolveMorphoV2TrustedProfile(...keys[0])!
    const texts = archive(profile)
    const oversized = structuredClone(texts)
    const chunk = 'x'.repeat(8 * 1024 * 1024)
    oversized.terminalText = chunk
    oversized.inputPlanText = chunk
    oversized.parentAuditText = chunk
    oversized.parentClockManifestText = chunk
    expect(replayMorphoV2MultiAssetObservedProtocolHistory(profile, oversized)).toBeNull()
    const sparse = structuredClone(texts)
    Reflect.deleteProperty(sparse.points, '1')
    expect(replayMorphoV2MultiAssetObservedProtocolHistory(profile, sparse)).toBeNull()
    let invoked = false
    const getter = { ...texts }
    Object.defineProperty(getter, 'terminalText', {
      enumerable: true,
      get: () => {
        invoked = true
        return texts.terminalText
      },
    })
    expect(replayMorphoV2MultiAssetObservedProtocolHistory(profile, getter)).toBeNull()
    expect(invoked).toBe(false)
  })

  it('rejects a multiply linked private native file', async () => {
    const profile = resolveMorphoV2TrustedProfile(...keys[0])!
    const pin = PINS[profile.id]
    const terminal = read(pin.directory + '/terminal.json')
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'morpho-observed-hardlink-')))
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(temporary)
    try {
      const directory = join(temporary, pin.directory)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const path = join(directory, 'terminal.json')
      const descriptor = openSync(path, 'wx', 0o600)
      try {
        writeSync(descriptor, terminal)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      linkSync(path, join(directory, 'terminal-alias.json'))
      expect(statSync(path).nlink).toBe(2)
      expect(await loadMorphoV2MultiAssetObservedProtocolHistory(profile)).toBeNull()
      expect(await prewarmMorphoV2ProtocolHistory(profile)).toBe(false)
    } finally {
      cwd.mockRestore()
      rmSync(temporary, { recursive: true, force: true })
    }
  })

  it.each(keys)(
    'verifies %s against retained native bytes and post-retention clocks',
    async (...key) => {
      const profile = resolveMorphoV2TrustedProfile(...key)!
      expect(isAppOwnedMorphoV2TrustedProfile(profile)).toBe(true)
      const texts = archive(profile)
      const history = reviewedMorphoV2ProtocolHistory(profile)!
      expect(replayMorphoV2MultiAssetObservedProtocolHistory(profile, texts)).toEqual(history)
      expect(await loadMorphoV2MultiAssetObservedProtocolHistory(profile)).toEqual(history)
      expect(await prewarmMorphoV2ProtocolHistory(profile)).toBe(true)
      expect(history.history.points).toHaveLength(2)
      expect(history.history.elapsedSeconds).toEqual([86400])
      expect(history.knowledgeCutoff).toBe(
        JSON.parse(texts.parentClockProofText).result.availableAtUtc,
      )
      expect(history.nativeQualification).toBeUndefined()
      expect(history.protocolOnlyQualification).toMatchObject({
        researchSharesRaw: '1000000000000000000',
        capturedCurrentOwnerSharesRaw: '0',
        historicalOwner: null,
        arbitraryShareScalingApproved: false,
        currentHolderEntitlementApproved: false,
        MRaw: null,
        authenticated: false,
        executionValidated: false,
        calibratedProbability: false,
        forecastValidated: false,
        coveragePromotion: false,
        originalTerminalPostRetentionQualified: false,
        parentObservedPostRetentionWithinDeadline: true,
      })
      expect(profile.nativeHistory.references).toEqual([])
      expect(profile.nativeHistory.qualification.fixedSharesRaw).toBeNull()
      expect(profile.nativeHistory.qualification.originalOwner).toBeNull()
    },
  )

  it.each(keys)('rejects cloned profiles and mutated %s frames or raw archive seals', (...key) => {
    const profile = resolveMorphoV2TrustedProfile(...key)!
    const texts = archive(profile)
    const history = reviewedMorphoV2ProtocolHistory(profile)!
    const frameDigest = digest(JSON.stringify(history))
    expect(approveReviewedMorphoV2ProtocolHistory(profile, history, digest)).toBe(true)
    expect(
      replayMorphoV2MultiAssetObservedProtocolHistory(structuredClone(profile), texts),
    ).toBeNull()
    for (const mutate of [
      (frame: typeof history) => {
        frame.subject.asset = keys[0][2] === frame.subject.asset ? keys[1][2] : keys[0][2]
      },
      (frame: typeof history) => {
        frame.configured.adapter = keys[0][1]
      },
      (frame: typeof history) => {
        frame.history.points[0].prongs.blueCashRaw = '0'
      },
      (frame: typeof history) => {
        frame.history.points[0].prongs.market[0] = '1'
      },
      (frame: typeof history) => {
        frame.knowledgeCutoff = frame.history.points[1].source.blockTime
      },
      (frame: typeof history) => {
        frame.protocolOnlyQualification!.arbitraryShareScalingApproved = true as false
      },
      (frame: typeof history) => {
        Object.assign(frame, { authenticated: true })
      },
    ]) {
      const candidate = structuredClone(history)
      mutate(candidate)
      expect(approveReviewedMorphoV2ProtocolHistory(profile, candidate, digest)).toBe(false)
      expect(approveReviewedMorphoV2ProtocolHistory(profile, candidate, () => frameDigest)).toBe(
        false,
      )
    }
    for (const name of ['terminalText', 'parentAuditText', 'parentClockProofText'] as const) {
      const candidate = structuredClone(texts)
      const value = JSON.parse(candidate[name])
      value.sha256 = '0'.repeat(64)
      candidate[name] = JSON.stringify(value)
      expect(replayMorphoV2MultiAssetObservedProtocolHistory(profile, candidate)).toBeNull()
    }
    const altered = structuredClone(texts)
    const facts = JSON.parse(altered.points[1].factsText)
    facts.nativeFacts.blueCash = '0'
    const { sha256: _old, ...body } = facts
    facts.sha256 = digest(JSON.stringify(body))
    altered.points[1].factsText = JSON.stringify(facts)
    expect(replayMorphoV2MultiAssetObservedProtocolHistory(profile, altered)).toBeNull()
    expect(Object.isFrozen(PINS[profile.id])).toBe(true)
  })

  it.each(keys)(
    'requires new same-S historical native quotes for %s including research-sized holders',
    (...key) => {
      const profile = resolveMorphoV2TrustedProfile(...key)!
      const texts = archive(profile)
      for (const sharesRaw of ['1000000000000000000', '987654321123456789']) {
        const f = holderFixture(profile, texts, sharesRaw)
        expect(f.issue(undefined)).toBeNull()
        const model = f.issue(f.compactHistorical)!
        expect(model).not.toBeNull()
        expect(model.sharesRaw).toBe(sharesRaw)
        expect(model.historicalEaMethod).toBe('native_current_full_S_historical_quotes')
        expect(model.process.queuedCompetingMRaw).toBeNull()
        expect(model.attemptedDonorCount).toBe(1)
        expect(model).toMatchObject({
          authenticated: false,
          forecastValidated: false,
          calibratedProbability: false,
        })
        const mismatched = structuredClone(f.historical)
        mismatched.origins[0].observation.sharesRaw =
          sharesRaw === '1000000000000000000' ? '987654321123456789' : '1000000000000000000'
        expect(
          encodeMorphoV2HistoricalHolderEaEvidencePair(mismatched, f.historicalExpected),
        ).toBeNull()
        expect(f.issue('{}')).toBeNull()
      }
    },
  )
})
