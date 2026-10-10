import { describe, expect, it } from 'vitest'
import {
  approveMorphoV2HistoricalHolderEaEvidence,
  decodeMorphoV2HistoricalHolderEaEvidencePair,
  encodeMorphoV2HistoricalHolderEaEvidencePair,
  selectMorphoV2HistoricalHolderEaAnchors,
  selectedMorphoV2HistoricalHolderEaEvidence,
} from '@/lib/carry/morphoV2HistoricalHolderEaEvidence'
import { reviewedMorphoV2ProtocolHistory } from '@/lib/carry/morphoV2ReviewedProtocolHistories'
import {
  createMorphoV2HistoricalHolderEaFixture,
  historicalEaUint,
} from './fixtures/morphoV2HistoricalHolderEaFixture'

describe('native arbitrary full-S historical Morpho Ea evidence', () => {
  it.each(['USDC', 'USDT'] as const)(
    'approves %s only against independently selected anchors and complete raw agreement',
    (asset) => {
      const { expected, pair, anchors } = createMorphoV2HistoricalHolderEaFixture(asset)
      const encoded = encodeMorphoV2HistoricalHolderEaEvidencePair(pair, expected)!
      expect(encoded).not.toBeNull()
      const decoded = decodeMorphoV2HistoricalHolderEaEvidencePair(encoded)
      expect(decoded).toEqual(pair)
      const approved = approveMorphoV2HistoricalHolderEaEvidence(decoded, expected)
      expect(approved.points).toEqual(
        anchors.map((p, i) => ({
          source: p.source,
          assetsRaw: (1000001n + BigInt(i) * 77n).toString(),
        })),
      )
      expect(approved.sharesRaw).toBe(expected.sharesRaw)
      expect(approved).toMatchObject({
        olderPastOwnerProven: false,
        executionProven: false,
        forecastValidated: false,
      })
      expect(selectedMorphoV2HistoricalHolderEaEvidence(approved, expected)).toBe(approved)
      expect(Object.isFrozen(approved)).toBe(true)
      expect(Object.isFrozen(approved.points)).toBe(true)
      expect(Object.isFrozen(approved.points[0].source)).toBe(true)
      expect(Object.isFrozen(approved.originHosts)).toBe(true)
    },
  )
  it.each([
    [18, 18],
    [0, 36],
    [36, 0],
    [36, 36],
  ])(
    'preserves unsigned %i/%i native units without rescaling S or Ea',
    (assetDecimals, shareDecimals) => {
      const { pair } = createMorphoV2HistoricalHolderEaFixture('USDT', '123')
      for (const { observation } of pair.origins) {
        observation.assetDecimals = assetDecimals
        observation.shareDecimals = shareDecimals
      }
      const decoded = decodeMorphoV2HistoricalHolderEaEvidencePair(JSON.stringify(pair))
      expect(decoded).toEqual(pair)
      expect(decoded!.origins[0].observation.sharesRaw).toBe('123')
      expect(decoded!.origins[0].observation.traces).toEqual(pair.origins[0].observation.traces)
      expect('status' in decoded!).toBe(false)
    },
  )
  it.each(['USDC', 'USDT'] as const)(
    'rejects unsigned valid unit substitutions against the original %s pilot profile',
    (asset) => {
      for (const [assetDecimals, shareDecimals] of [
        [18, 18],
        [0, 36],
        [36, 0],
      ]) {
        const { pair, expected } = createMorphoV2HistoricalHolderEaFixture(asset)
        for (const { observation } of pair.origins) {
          observation.assetDecimals = assetDecimals
          observation.shareDecimals = shareDecimals
        }
        const decoded = decodeMorphoV2HistoricalHolderEaEvidencePair(JSON.stringify(pair))
        expect(decoded).not.toBeNull()
        expect(() => approveMorphoV2HistoricalHolderEaEvidence(decoded, expected)).toThrow()
        expect(encodeMorphoV2HistoricalHolderEaEvidencePair(pair, expected)).toBeNull()
      }
    },
  )
  it.each([
    ['negative', -1],
    ['fractional', 6.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['numeric string', '18'],
    ['non-numeric', 'unknown'],
    ['null', null],
    ['missing', undefined],
    ['above bound', 37],
  ])('rejects %s units for either native unit field', (_label, value) => {
    for (const field of ['assetDecimals', 'shareDecimals'] as const) {
      const { pair, expected } = createMorphoV2HistoricalHolderEaFixture()
      Reflect.set(pair.origins[0].observation, field, value)
      expect(() => approveMorphoV2HistoricalHolderEaEvidence(pair, expected)).toThrow()
      expect(encodeMorphoV2HistoricalHolderEaEvidencePair(pair, expected)).toBeNull()
      expect(decodeMorphoV2HistoricalHolderEaEvidencePair(JSON.stringify(pair))).toBeNull()
    }
  })
  it('rejects a cloned 18/18 profile even with matching unsigned wire units', () => {
    const { pair, expected } = createMorphoV2HistoricalHolderEaFixture()
    const profile = structuredClone(expected.profile)
    Reflect.set(profile.subject, 'assetDecimals', 18)
    Reflect.set(profile.subject, 'shareDecimals', 18)
    for (const { observation } of pair.origins) {
      observation.assetDecimals = 18
      observation.shareDecimals = 18
    }
    expect(decodeMorphoV2HistoricalHolderEaEvidencePair(JSON.stringify(pair))).toEqual(pair)
    expect(() => selectMorphoV2HistoricalHolderEaAnchors(profile, expected.currentSource)).toThrow()
    expect(() =>
      approveMorphoV2HistoricalHolderEaEvidence(pair, { ...expected, profile }),
    ).toThrow()
    expect(encodeMorphoV2HistoricalHolderEaEvidencePair(pair, { ...expected, profile })).toBeNull()
  })
  it('selects the last at most eight original reviewed points strictly before the current source', () => {
    const { expected } = createMorphoV2HistoricalHolderEaFixture('USDT')
    const all = reviewedMorphoV2ProtocolHistory(expected.profile)!.history.points.map((point) => ({
      ...point,
      source: {
        chainId: point.source.chainId,
        blockNumber: point.source.blockNumber,
        blockHash: point.source.blockHash,
        blockTime: point.source.blockTime,
      },
    }))
    const selected = selectMorphoV2HistoricalHolderEaAnchors(
      expected.profile,
      expected.currentSource,
    )
    expect(selected).toEqual(all.slice(-8))
    expect(selected).toHaveLength(Math.min(8, all.length))
    selected[0].source.blockHash = `0x${'c'.repeat(64)}`
    expect(
      selectMorphoV2HistoricalHolderEaAnchors(expected.profile, expected.currentSource),
    ).toEqual(all.slice(-8))
    const last = all.at(-1)!.source
    const atLast = {
      ...expected.currentSource,
      blockNumber: Number(last.blockNumber),
      blockTime: last.blockTime,
    }
    expect(selectMorphoV2HistoricalHolderEaAnchors(expected.profile, atLast)).toEqual(
      all.slice(0, -1).slice(-8),
    )
    expect(() =>
      selectMorphoV2HistoricalHolderEaAnchors(
        structuredClone(expected.profile),
        expected.currentSource,
      ),
    ).toThrow()
  })
  it('does not rescale captured original S and does not require owner/current holder evidence', () => {
    const { expected, pair } = createMorphoV2HistoricalHolderEaFixture('USDT', '123')
    expect(approveMorphoV2HistoricalHolderEaEvidence(pair, expected).sharesRaw).toBe('123')
    expect('owner' in expected).toBe(false)
    expect(
      encodeMorphoV2HistoricalHolderEaEvidencePair(pair, { ...expected, sharesRaw: '124' }),
    ).toBeNull()
  })
  it.each([
    [
      'disagreeing result',
      (p: ReturnType<typeof createMorphoV2HistoricalHolderEaFixture>['pair']) => {
        p.origins[1].observation.traces[0].result = historicalEaUint(99n)
      },
    ],
    [
      'wrong full S',
      (p) => {
        p.origins[0].observation.sharesRaw = '42'
      },
    ],
    [
      'wrong profile',
      (p) => {
        p.origins[0].observation.profileId = 'made_up'
      },
    ],
    [
      'wrong asset',
      (p) => {
        p.origins[0].observation.asset = `0x${'0'.repeat(40)}`
      },
    ],
    [
      'wrong share units',
      (p) => {
        p.origins[0].observation.shareDecimals = 6
      },
    ],
    [
      'wrong asset units',
      (p) => {
        p.origins[0].observation.assetDecimals = 18
      },
    ],
    [
      'duplicate origin',
      (p) => {
        p.origins[1].host = p.origins[0].host
      },
    ],
    [
      'unconfigured origin',
      (p) => {
        p.origins[1].host = 'unconfigured.example'
      },
    ],
    [
      'missing anchor',
      (p) => {
        p.origins[0].observation.traces.pop()
      },
    ],
    [
      'swapped anchors',
      (p) => {
        p.origins[0].observation.traces.reverse()
      },
    ],
    [
      'invented source',
      (p) => {
        p.origins[0].observation.traces[0].source.blockNumber = '12345'
      },
    ],
    [
      'extra wire source metadata',
      (p) => {
        ;(p.origins[0].observation.traces[0].source as any).role = 'history'
      },
    ],
    [
      'number converted source',
      (p) => {
        ;(p.origins[0].observation.traces[0].source as any).blockNumber = 12345
      },
    ],
    [
      'noncanonical hash pin',
      (p) => {
        ;(p.origins[0].observation.traces[0].params[1] as any).requireCanonical = false
      },
    ],
    [
      'extra from',
      (p) => {
        ;(p.origins[0].observation.traces[0].params[0] as any).from = `0x${'0'.repeat(40)}`
      },
    ],
    [
      'extra gas',
      (p) => {
        ;(p.origins[0].observation.traces[0].params[0] as any).gas = '0x1000'
      },
    ],
    [
      'padded ABI result',
      (p) => {
        ;(p.origins[0].observation.traces[0] as any).result += '00'
      },
    ],
    [
      'uppercase result',
      (p) => {
        p.origins[0].observation.traces[0].result = `0x${'A'.repeat(64)}`
      },
    ],
    [
      'backwards trace clock',
      (p) => {
        p.origins[0].observation.traces[0].completedAtUtc = '2020-01-01T00:00:00.000Z'
      },
    ],
    [
      'non UTC clock',
      (p) => {
        p.origins[0].observation.readAtUtc = '2026-10-08T00:00:00+00:00'
      },
    ],
    [
      'unbounded origin deadline',
      (p) => {
        p.origins[0].observation.deadlineMs = 120_001
      },
    ],
  ] as [string, (p: ReturnType<typeof createMorphoV2HistoricalHolderEaFixture>['pair']) => void][])(
    'rejects %s',
    (_, mutate) => {
      const { pair, expected } = createMorphoV2HistoricalHolderEaFixture()
      mutate(pair)
      expect(encodeMorphoV2HistoricalHolderEaEvidencePair(pair, expected)).toBeNull()
    },
  )
  it('rejects widened two-origin capture span even when each origin is bounded', () => {
    const { pair, expected } = createMorphoV2HistoricalHolderEaFixture()
    const offset = 120_001
    const o = pair.origins[1].observation
    o.startedAtUtc = new Date(Date.parse(o.startedAtUtc) + offset).toISOString()
    o.readAtUtc = new Date(Date.parse(o.readAtUtc) + offset).toISOString()
    for (const t of o.traces) {
      t.startedAtUtc = new Date(Date.parse(t.startedAtUtc) + offset).toISOString()
      t.completedAtUtc = new Date(Date.parse(t.completedAtUtc) + offset).toISOString()
    }
    expect(
      encodeMorphoV2HistoricalHolderEaEvidencePair(pair, {
        ...expected,
        asOfMs: expected.asOfMs + offset,
      }),
    ).toBeNull()
  })
  it('rejects sparse, inherited-index, extra-property and accessor arrays without invoking getters', () => {
    for (const kind of ['sparse', 'extra', 'accessor', 'inherited']) {
      const { pair, expected } = createMorphoV2HistoricalHolderEaFixture()
      const traces = pair.origins[0].observation.traces
      if (kind === 'sparse') delete (traces as any)[0]
      if (kind === 'extra') (traces as any).approval = true
      if (kind === 'accessor')
        Object.defineProperty(traces, '0', {
          get: () => {
            throw new Error('getter must not run')
          },
          enumerable: true,
        })
      if (kind === 'inherited') Object.setPrototypeOf(traces, { ...Array.prototype, 0: traces[0] })
      expect(encodeMorphoV2HistoricalHolderEaEvidencePair(pair, expected)).toBeNull()
    }
  })
  it('rejects duplicate decoded JSON keys, oversized and malformed JSON', () => {
    const { pair, expected } = createMorphoV2HistoricalHolderEaFixture()
    const json = encodeMorphoV2HistoricalHolderEaEvidencePair(pair, expected)!
    expect(
      decodeMorphoV2HistoricalHolderEaEvidencePair(
        json.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      ),
    ).toBeNull()
    expect(
      decodeMorphoV2HistoricalHolderEaEvidencePair(
        json.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
      ),
    ).toBeNull()
    expect(decodeMorphoV2HistoricalHolderEaEvidencePair(' '.repeat(65537) + json)).toBeNull()
    expect(decodeMorphoV2HistoricalHolderEaEvidencePair(json + '{}')).toBeNull()
  })
  it('rejects approval clones, profile clones, rebinding and expiry; snapshots mutable expected values', () => {
    const { pair, expected } = createMorphoV2HistoricalHolderEaFixture()
    const original = {
      ...expected,
      currentSource: structuredClone(expected.currentSource),
      originHosts: [...expected.originHosts] as [string, string],
    }
    const approved = approveMorphoV2HistoricalHolderEaEvidence(pair, expected)
    expect(
      selectedMorphoV2HistoricalHolderEaEvidence(structuredClone(approved), original),
    ).toBeNull()
    expect(
      selectedMorphoV2HistoricalHolderEaEvidence(approved, {
        ...original,
        profile: structuredClone(original.profile),
      }),
    ).toBeNull()
    expect(
      selectedMorphoV2HistoricalHolderEaEvidence(approved, { ...original, sharesRaw: '42' }),
    ).toBeNull()
    expect(
      selectedMorphoV2HistoricalHolderEaEvidence(approved, {
        ...original,
        asOfMs: original.asOfMs - 1,
      }),
    ).toBeNull()
    expect(
      selectedMorphoV2HistoricalHolderEaEvidence(approved, {
        ...original,
        asOfMs: original.asOfMs + 2 * 60 * 60 * 1000,
      }),
    ).toBeNull()
    expect(
      encodeMorphoV2HistoricalHolderEaEvidencePair(pair, {
        ...original,
        asOfMs: Date.parse(original.currentSource.blockTime) + 2 * 60 * 60 * 1000 + 1,
      }),
    ).toBeNull()
    expected.currentSource.blockNumber++
    expected.originHosts[0] = 'mutation.example'
    pair.origins[0].observation.traces[0].result = historicalEaUint(0n)
    expect(selectedMorphoV2HistoricalHolderEaEvidence(approved, original)).toBe(approved)
    expect(approved.points[0].assetsRaw).toBe('1000001')
  })
})
