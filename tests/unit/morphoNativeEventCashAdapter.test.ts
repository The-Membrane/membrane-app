import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  MORPHO_EVENT_CASH_MANIFEST_PATH,
  MORPHO_EVENT_CASH_MANIFEST_SHA,
  readPinnedMorphoEventCashTexts,
  replayPinnedMorphoNativeEventCashDataset,
  analyzeMorphoNativeEventCashDataset,
  scoreRetrospectiveNativeCashResearchCase,
  type PinnedMorphoEventCashText,
  type MorphoNativeEventCashDataset,
} from '../../lib/carry/morphoNativeEventCashAdapter.server'
import {
  selectEventConditionedNetScenarios,
  type EventConditionedNetInput,
  type ReviewedNetEvent,
} from '../../lib/carry/eventConditionedNetScenarios'

const CUTOFF = '2026-10-09T12:00:00.000Z'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
let texts: PinnedMorphoEventCashText[]
let dataset: MorphoNativeEventCashDataset
beforeAll(() => {
  texts = readPinnedMorphoEventCashTexts()
  dataset = replayPinnedMorphoNativeEventCashDataset(texts, CUTOFF)
})
const changed = (id: string, transform: (body: Record<string, unknown>) => void, reseal = false) =>
  texts.map((t) => {
    if (t.descriptorId !== id) return t
    const body = JSON.parse(t.rawText) as Record<string, unknown>
    transform(body)
    if (reseal) {
      const { sha256: ignored, ...rest } = body
      void ignored
      body.sha256 = hash(JSON.stringify(rest))
    }
    return { descriptorId: id, rawText: JSON.stringify(body) + '\n' }
  })
const day = (n: number) => new Date(Date.UTC(2026, 9, n)).toISOString()
const h = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const subject = {
  routeKey: 'research cash exact subject',
  destination: '0x' + '11'.repeat(20),
  asset: '0x' + '22'.repeat(20),
  assetDecimals: 6,
}
const taxonomy = {
  namespace: 'reviewed_fixture',
  eventType: 'Deposit',
  reviewRef: 'controlled_unsigned_fixture',
}
const regime = 'metric_only:ERC20.balanceOf(vault):chain1:' + subject.asset + ':decimals6'
function controlled(
  cash: string[] = Array.from({ length: 7 }, (_, i) => String(1000 + 10 * i)),
): EventConditionedNetInput {
  const points = cash.map((cashRaw, index) => ({
    index,
    block: String(100 + index),
    blockHash: h(100 + index),
    sourceAtUtc: day(index + 1),
    availableAtUtc: CUTOFF,
    regime,
    cashRaw,
    provenanceRef: 'controlled_unsigned_native_units:' + index,
  }))
  const last = points.at(-1)!
  return {
    informationMode: 'retrospective_training',
    target: {
      subject,
      regime,
      source: {
        block: last.block,
        blockHash: last.blockHash,
        sourceAtUtc: last.sourceAtUtc,
        availableAtUtc: CUTOFF,
      },
    },
    knowledgeCutoffUtc: CUTOFF,
    taxonomy,
    scope: { kind: 'exact_subject' },
    parameters: {
      lookbackSeconds: 120 * 86400,
      eventResponseWindowSeconds: 3 * 86400,
      minimumIntervalSeconds: 18 * 3600,
      maximumGapSeconds: 30 * 3600,
      horizonSeconds: 86400,
      minimumMatchedIntervals: 2,
      minimumEventClusters: 2,
      maximumScenariosPerSubject: 128,
    },
    histories: [{ subject, points }],
    events: [],
  }
}
function event(n: number): ReviewedNetEvent {
  return {
    subject,
    regime,
    taxonomy,
    eventId: 'event:' + n,
    storyId: 'story:' + n,
    duplicateGroupId: 'duplicate:' + n,
    knowledgeBasis: 'reviewed_occurrence_without_publication',
    kind: 'official_observed',
    occurredAtUtc: day(n),
    firstKnownAtUtc: CUTOFF,
    fetchedAtUtc: CUTOFF,
    availableAtUtc: CUTOFF,
    publishedAtUtc: null,
    occurrenceProof: {
      kind: 'official_effective',
      occurredAtUtc: day(n),
      availableAtUtc: CUTOFF,
      sourceRef: 'controlled_unsigned_occurrence:' + n,
      reviewRef: taxonomy.reviewRef,
      block: null,
      blockHash: null,
    },
  }
}

describe('fixed native Morpho Deposit and same-subject cash adapter', () => {
  it('admits every exact pinned original and preserves the full 51-prefix chain', () => {
    const manifestText = readFileSync(MORPHO_EVENT_CASH_MANIFEST_PATH, 'utf8')
    expect(hash(manifestText)).toBe(MORPHO_EVENT_CASH_MANIFEST_SHA)
    expect(texts).toHaveLength(57)
    expect(texts.reduce((n, t) => n + Buffer.byteLength(t.rawText), 0)).toBe(6609912)
    expect(dataset.counts).toEqual({
      cashSubjects: 64,
      cashPoints: 7669,
      originalBundles: 51,
      rawNativeLogs: 1372,
      nativeDepositEvents: 620,
      subjectsWithNativeDeposits: 28,
    })
    expect(dataset.excludedCashSubjects).toHaveLength(4)
  })
  it('retains the paired EURCV occurrence and derives native signed NET exactly once', () => {
    const c = dataset.cases.find(
      (c) => c.identity.destination === '0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f',
    )!
    const e = c.input.events.find((e) => e.occurrenceProof?.block === '25880451')!
    expect(e.occurredAtUtc).toBe('2026-09-01T05:51:11.000Z')
    expect(e.firstKnownAtUtc).toBe('2026-10-01T05:31:05.851Z')
    expect(e.occurrenceProof?.blockHash).toBe(
      '0xe39a895105907560642ba1a64db580d0fe0560f5713b51d1391ab92d87827a5a',
    )
    expect(e.occurrenceProof?.sourceRef).toContain(
      'bodySHA=8ea0d198f5f90ae87b9f6dc9fdb5f51e8b719ccdaeb74b6eb13c255c0fbdaece',
    )
    const selection = selectEventConditionedNetScenarios(c.input)!
    const rate = selection.subjects[0].baselineNativeNet.find(
      (r) => r.fromIndex === 88 && r.toIndex === 89,
    )!
    expect(rate.netDeltaRaw).toBe('464425659898644488641588')
    expect(BigInt(rate.endCashRaw) - BigInt(rate.startCashRaw)).toBe(BigInt(rate.netDeltaRaw))
    expect(selection.assumptions.grossWithdrawalsDeductedAgain).toBe(false)
  })
  it('keeps the envelope clock distinct from the measured verification boundary', () => {
    const c = dataset.cases.find((c) => c.input.events.length > 0)!
    expect(c.originalCashAvailableAtUtc).toBe('2026-10-05T10:57:37.472Z')
    expect(c.verificationAvailableAtUtc).toBe(CUTOFF)
    for (const e of c.input.events) {
      expect(e.fetchedAtUtc).toBe(e.firstKnownAtUtc)
      expect(e.availableAtUtc).toBe(CUTOFF)
      expect(e.occurrenceProof?.availableAtUtc).toBe(CUTOFF)
      expect(e.publishedAtUtc).toBeNull()
      expect(e.knowledgeBasis).toBe('reviewed_occurrence_without_publication')
    }
    expect(dataset.verificationClockBasis).toBe('caller_asserted_research_cutoff')
  })
  it('denies a cutoff before the original cash retention witness', () => {
    expect(() =>
      replayPinnedMorphoNativeEventCashDataset(texts, '2026-10-04T12:00:00.000Z'),
    ).toThrow('cutoff_before_retention')
  })
  it('rejects a malformed cutoff rather than inventing a historical issue', () => {
    expect(() => replayPinnedMorphoNativeEventCashDataset(texts, '2026-10-09')).toThrow(
      'research_cutoff',
    )
  })
  it('cannot replay native events as known at historical donor starts', () => {
    const c = dataset.cases.find((c) => c.input.events.length > 0)!
    const selection = selectEventConditionedNetScenarios({
      ...c.input,
      informationMode: 'as_of_replay',
    })!
    expect(selection.subjects[0].matched).toHaveLength(0)
    expect(selection.subjects[0].baselineNativeNet.length).toBeGreaterThan(0)
  })
  it('rejects missing enrollment or prefix originals', () => {
    expect(() => replayPinnedMorphoNativeEventCashDataset(texts.slice(1), CUTOFF)).toThrow(
      'original_count',
    )
  })
  it('rejects duplicate prefix IDs even when bytes are genuinely retained', () => {
    const a = [...texts]
    a[6] = texts[5]
    expect(() => replayPinnedMorphoNativeEventCashDataset(a, CUTOFF)).toThrow('original_identity')
  })
  it('rejects a foreign original identifier', () => {
    const a = [...texts]
    a[6] = { ...a[6], descriptorId: 'unreviewed_native_file' }
    expect(() => replayPinnedMorphoNativeEventCashDataset(a, CUTOFF)).toThrow('original_identity')
  })
  it('rejects a resealed predecessor-chain substitution', () => {
    expect(() =>
      replayPinnedMorphoNativeEventCashDataset(
        changed(
          'event_bundle_2',
          (b) => {
            b.previousSha256 = '0'.repeat(64)
          },
          true,
        ),
        CUTOFF,
      ),
    ).toThrow('original_file_pin')
  })
  it('rejects a resealed paired log subject substitution', () => {
    expect(() =>
      replayPinnedMorphoNativeEventCashDataset(
        changed(
          'event_bundle_1',
          (b) => {
            const slices = b.slices as { witnesses: { raw: { address: string }[] }[] }[]
            const row = slices.flatMap((s) => s.witnesses.flatMap((w) => w.raw))[0]
            row.address = subject.destination
          },
          true,
        ),
        CUTOFF,
      ),
    ).toThrow('original_file_pin')
  })
  it('rejects a resealed native event-header timestamp substitution', () => {
    expect(() =>
      replayPinnedMorphoNativeEventCashDataset(
        changed(
          'event_bundle_1',
          (b) => {
            const slices = b.slices as { witnesses: { eventHeaders: { timestamp: string }[] }[] }[]
            slices.flatMap((s) => s.witnesses.flatMap((w) => w.eventHeaders))[0].timestamp = '1'
          },
          true,
        ),
        CUTOFF,
      ),
    ).toThrow('original_file_pin')
  })
  it('rejects exact-subject cash asset and decimals substitutions', () => {
    expect(() =>
      replayPinnedMorphoNativeEventCashDataset(
        changed(
          'cash_audit',
          (b) => {
            const histories = b.histories as Record<string, { identity: { assetDecimals: number } }>
            Object.values(histories)[0].identity.assetDecimals = 18
          },
          true,
        ),
        CUTOFF,
      ),
    ).toThrow('original_file_pin')
  })
  it('rejects old retention clock rewriting despite a fresh body seal', () => {
    expect(() =>
      replayPinnedMorphoNativeEventCashDataset(
        changed(
          'cash_pins',
          (b) => {
            const pins = b.pins as Record<string, { availableAt: string }>
            Object.values(pins)[0].availableAt = '2026-09-01T00:00:00.000Z'
          },
          true,
        ),
        CUTOFF,
      ),
    ).toThrow('original_file_pin')
  })
  it('rejects whitespace changes to the immutable native file bytes', () => {
    const a = texts.map((t) =>
      t.descriptorId === 'event_bundle_1' ? { ...t, rawText: t.rawText + ' ' } : t,
    )
    expect(() => replayPinnedMorphoNativeEventCashDataset(a, CUTOFF)).toThrow('original_file_pin')
  })
  it('does not invoke raw-text getters', () => {
    let calls = 0
    const a = [...texts]
    a[0] = Object.defineProperty({ descriptorId: texts[0].descriptorId }, 'rawText', {
      enumerable: true,
      get() {
        calls++
        throw Error('getter_called')
      },
    }) as PinnedMorphoEventCashText
    expect(() => replayPinnedMorphoNativeEventCashDataset(a, CUTOFF)).toThrow('input_descriptor')
    expect(calls).toBe(0)
  })
  it('rejects prototypes, cycles and sparse original arrays', () => {
    const p = [...texts]
    p[0] = Object.assign(Object.create({ inherited: true }), texts[0])
    expect(() => replayPinnedMorphoNativeEventCashDataset(p, CUTOFF)).toThrow('input_prototype')
    const cycle: unknown[] = []
    cycle.push(cycle)
    expect(() => replayPinnedMorphoNativeEventCashDataset(cycle, CUTOFF)).toThrow('input_object')
    const sparse = [...texts]
    delete sparse[0]
    expect(() => replayPinnedMorphoNativeEventCashDataset(sparse, CUTOFF)).toThrow('input_array')
  })
  it('rejects descriptor depth and raw-text bounds before parsing', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 18; i++) deep = { child: deep }
    expect(() => replayPinnedMorphoNativeEventCashDataset(deep, CUTOFF)).toThrow('input_bounds')
    const a = [...texts]
    a[0] = { ...a[0], rawText: 'x'.repeat(8192 * 1024 + 1) }
    expect(() => replayPinnedMorphoNativeEventCashDataset(a, CUTOFF)).toThrow('input_string_bounds')
  })
  it('retains baseline donors for all no-event exact subjects', () => {
    const c = dataset.cases.find((c) => c.input.events.length === 0)!
    const s = selectEventConditionedNetScenarios(c.input)!
    expect(s.subjects[0].status).toBe('insufficient_event_matches')
    expect(s.subjects[0].matched).toHaveLength(0)
    expect(s.subjects[0].baselineNativeNet.length).toBeGreaterThan(0)
  })
  it('does not lower the two-cluster threshold to force a fitted event model', () => {
    for (const c of dataset.cases.filter((c) => c.input.events.length)) {
      const s = selectEventConditionedNetScenarios(c.input)!
      expect(s.parameters.minimumEventClusters).toBe(2)
      expect(s.subjects[0].counts.matchedEventClusters).toBeLessThanOrEqual(1)
      expect(s.subjects[0].status).toBe('insufficient_event_matches')
      expect(s.comparison.independentSampleCount).toBeNull()
    }
  })
  it('labels every metric regime as semantic cash only and grants no holder authority', () => {
    for (const c of dataset.cases) {
      expect(c.metricRegime).toContain('metric_only:ERC20.balanceOf(vault)')
      expect(c.policyRegimeVerified).toBe(false)
      expect(c.protocolConfigurationStable).toBe(false)
      expect(c.input.target.subject).toEqual(c.identity)
    }
    expect(dataset.authenticated).toBe(false)
    expect(dataset.originalAuthority).toBe(false)
    expect(dataset.holderExecutableExit).toBe(false)
    expect(dataset.calibrated).toBe(false)
    expect(dataset.competingMRaw).toBeNull()
  })
  it('requires the exact local research preparation object for aggregate analysis', () => {
    expect(() => analyzeMorphoNativeEventCashDataset(clone(dataset))).toThrow(
      'original_research_dataset_required',
    )
  })
})

describe('retrospective chronological native-cash scorer', () => {
  it('uses strict prior donors with four warmup folds and two scored folds', () => {
    const folds = scoreRetrospectiveNativeCashResearchCase(controlled())!
    expect(folds).toHaveLength(6)
    expect(folds.map((f) => f.baseline.status)).toEqual([
      'insufficient_training',
      'insufficient_training',
      'insufficient_training',
      'insufficient_training',
      'scored',
      'scored',
    ])
    for (const f of folds.filter((f) => f.baseline.status === 'scored')) {
      expect(f.latestTrainingEndpointAtUtc! < f.originSourceAtUtc).toBe(true)
      expect(f.baseline.absoluteErrorRaw).toBe('0')
      expect(f.persistence.absoluteErrorRaw).toBe('10')
      expect(f.baseline.covered).toBe(true)
      expect(f.sourceAgeMs).toBe(0)
      expect(f.sourceTimeOriginIsCounterfactual).toBe(true)
      expect(f.historicallyIssuedForecast).toBe(false)
    }
  })
  it('does not fit on a changed held-out cash label', () => {
    const a = controlled(),
      b = clone(a)
    b.histories[0].points[5].cashRaw = '5000'
    const x = scoreRetrospectiveNativeCashResearchCase(a)![4]
    const z = scoreRetrospectiveNativeCashResearchCase(b)![4]
    expect(z.baseline.predictedEndCashRaw).toBe(x.baseline.predictedEndCashRaw)
    expect(z.baseline.donorCount).toBe(x.baseline.donorCount)
    expect(z.latestTrainingEndpointAtUtc).toBe(x.latestTrainingEndpointAtUtc)
    expect(z.baseline.absoluteErrorRaw).toBe('3950')
  })
  it('excludes later native event occurrences from earlier feature selection', () => {
    const input = controlled()
    input.events = [event(6)]
    const f = scoreRetrospectiveNativeCashResearchCase(input)![4]
    expect(f.featuresLatestOccurrenceAtUtc).toBeNull()
    expect(f.eventAssociated.status).toBe('insufficient_training')
    expect(f.baseline.absoluteErrorRaw).toBe('0')
  })
  it('keeps event scores null when overlapping events have only one support cluster', () => {
    const input = controlled()
    input.events = [event(1), event(2)]
    const f = scoreRetrospectiveNativeCashResearchCase(input)!.at(-1)!
    expect(f.matchedEventClusters).toBe(1)
    expect(f.eventAssociated.predictedEndCashRaw).toBeNull()
    expect(f.eventAssociated.reason).toBe('insufficient_distinct_event_clusters')
    expect(f.baseline.status).toBe('scored')
  })
  it('does not backdate event or endpoint availability for a historical replay', () => {
    const input = controlled()
    input.events = [event(2)]
    input.knowledgeCutoffUtc = day(7)
    expect(scoreRetrospectiveNativeCashResearchCase(input)).toBeNull()
  })
  it('does not score a held-out endpoint retained after the present cutoff', () => {
    const input = controlled()
    input.histories[0].points[5].availableAtUtc = '2026-10-10T12:00:00.000Z'
    const f = scoreRetrospectiveNativeCashResearchCase(input)![4]
    expect(f.baseline.status).toBe('censored')
    expect(f.baseline.reason).toBe('heldout_observation_not_available_at_knowledge_cutoff')
    expect(f.actualEndCashRaw).toBeNull()
    expect(f.baseline.absoluteErrorRaw).toBeNull()
    expect(f.persistence.absoluteErrorRaw).toBeNull()
  })
  it('denies an as-of mode from the retrospective scorer', () => {
    const input = controlled()
    input.informationMode = 'as_of_replay'
    expect(scoreRetrospectiveNativeCashResearchCase(input)).toBeNull()
  })
  it('projects by actual 25-hour elapsed duration with exact integer floor', () => {
    const input = controlled()
    input.histories[0].points[6].sourceAtUtc = '2026-10-07T01:00:00.000Z'
    input.target.source.sourceAtUtc = input.histories[0].points[6].sourceAtUtc
    const f = scoreRetrospectiveNativeCashResearchCase(input)!.at(-1)!
    expect(f.actualDurationMs).toBe(25 * 3600000)
    expect(f.baseline.predictedEndCashRaw).toBe('1060')
  })
  it('uses signed negative NET rates without another withdrawal deduction', () => {
    const input = controlled(['100', '90', '80', '70', '60', '50', '40'])
    const f = scoreRetrospectiveNativeCashResearchCase(input)!.at(-1)!
    expect(f.baseline.predictedEndCashRaw).toBe('40')
    expect(f.baseline.absoluteErrorRaw).toBe('0')
    expect(f.persistence.absoluteErrorRaw).toBe('10')
  })
  it('grades signed NET when a negative physical stock band is censored', () => {
    const f = scoreRetrospectiveNativeCashResearchCase(
      controlled(['101', '76', '51', '26', '1', '1', '1']),
    )![4]
    expect(f.baseline.status).toBe('scored')
    expect(f.baseline.physicalStockBandStatus).toBe('censored_boundary_risk')
    expect(f.baseline.physicalStockBoundaryReason).toBe('negative_projected_cash')
    expect(f.baseline.predictedEndCashRaw).toBeNull()
    expect(f.baseline.band).toBeNull()
    expect(f.baseline.projectedLatentEndCashRaw).toBe('-24')
    expect(f.baseline.predictedNETRaw).toBe('-25')
    expect(f.baseline.actualNETRaw).toBe('0')
    expect(f.baseline.NETErrorRaw).toBe('-25')
    expect(f.baseline.absoluteNETErrorRaw).toBe('25')
    expect(f.persistence.absoluteErrorRaw).toBe('0')
    expect(
      scoreRetrospectiveNativeCashResearchCase(
        controlled(['101', '76', '51', '26', '1', '1', '1']),
      )!.filter((x) => x.baseline.status === 'scored'),
    ).toHaveLength(2)
  })
  it('keeps a finite median NET score when an extreme donor crosses the cash boundary', () => {
    const f = scoreRetrospectiveNativeCashResearchCase(
      controlled(['110', '10', '20', '30', '20', '30', '40']),
    )![4]
    expect(f.baseline.status).toBe('scored')
    expect(f.baseline.predictedNETRaw).toBe('10')
    expect(f.baseline.actualNETRaw).toBe('10')
    expect(f.baseline.absoluteNETErrorRaw).toBe('0')
    expect(f.baseline.projectedLatentEndCashRaw).toBe('30')
    expect(f.baseline.latentBand?.minimumRaw).toBe('-80')
    expect(f.baseline.physicalStockBandStatus).toBe('censored_boundary_risk')
    expect(f.baseline.band).toBeNull()
    expect(f.persistence.absoluteErrorRaw).toBe('10')
  })
  it('keeps raw amounts beyond safe Number precision exact', () => {
    const base = 10n ** 30n
    const cash = Array.from({ length: 7 }, (_, i) => String(base + BigInt(i) * 10n))
    const f = scoreRetrospectiveNativeCashResearchCase(controlled(cash))!.at(-1)!
    expect(f.baseline.predictedEndCashRaw).toBe(String(base + 60n))
    expect(f.baseline.absoluteErrorRaw).toBe('0')
  })
  it('censors a held-out index gap without hiding persistence', () => {
    const input = controlled()
    input.histories[0].points[6].index = 8
    const f = scoreRetrospectiveNativeCashResearchCase(input)!.at(-1)!
    expect(f.baseline.status).toBe('censored')
    expect(f.baseline.reason).toBe('heldout_gap_or_metric_regime_mismatch')
    expect(f.persistence.absoluteErrorRaw).toBe('10')
  })
  it('censors a held-out metric regime change', () => {
    const input = controlled()
    input.histories[0].points[6].regime = 'metric_changed'
    const f = scoreRetrospectiveNativeCashResearchCase(input)!.at(-1)!
    expect(f.baseline.reason).toBe('heldout_gap_or_metric_regime_mismatch')
    expect(f.baseline.predictedEndCashRaw).toBeNull()
  })
  it('does not read a forged scorer input accessor', () => {
    let calls = 0
    const input = controlled()
    Object.defineProperty(input, 'events', {
      enumerable: true,
      get() {
        calls++
        throw Error('getter')
      },
    })
    expect(scoreRetrospectiveNativeCashResearchCase(input)).toBeNull()
    expect(calls).toBe(0)
  })
})
