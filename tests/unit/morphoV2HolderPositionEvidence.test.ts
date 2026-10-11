import { describe, expect, it } from 'vitest'
import {
  approveMorphoV2HolderPositionEvidence,
  decodeMorphoV2HolderPositionEvidence,
  encodeMorphoV2HolderPositionEvidence,
  selectedMorphoV2HolderPositionEvidence,
  type MorphoV2HolderPositionEvidence,
  type MorphoV2HolderPositionExpectation,
} from '@/lib/carry/morphoV2HolderPositionEvidence'

const OWNER = `0x${'1'.repeat(40)}` as const
const VAULT = `0x${'2'.repeat(40)}` as const
const ASSET = `0x${'3'.repeat(40)}` as const
const HASH = `0x${'a'.repeat(64)}` as const
const BLOCK_TIME = '2026-10-08T00:00:00.000Z'
const START = '2026-10-08T00:00:10.000Z'
const END = '2026-10-08T00:00:11.000Z'
const RAW = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`
const BALANCE_DATA = `0x70a08231${OWNER.slice(2).padStart(64, '0')}` as const
const PREVIEW_DATA = (n: bigint) => `0x4cdad506${n.toString(16).padStart(64, '0')}` as `0x${string}`
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function fixture(shares = 42n, ea = 67n) {
  const expected: MorphoV2HolderPositionExpectation = {
    routeKey: 'Registered route',
    destination: VAULT,
    owner: OWNER,
    asset: ASSET,
    assetDecimals: 6,
    shareDecimals: 18,
    source: {
      chainId: 1,
      blockNumber: 26_100_000,
      blockHash: HASH,
      blockTime: BLOCK_TIME,
      finalized: true,
    },
    sharesRaw: shares.toString(),
    fullEaRaw: ea.toString(),
    originHosts: ['eth-mainnet.g.alchemy.com', 'ethereum.publicnode.com'],
    asOfMs: Date.parse(END),
  }
  const observation: MorphoV2HolderPositionEvidence['origins'][0]['observation'] = {
    schemaVersion: 1,
    kind: 'morpho_v2_holder_position_origin_v1',
    routeKey: expected.routeKey,
    destination: VAULT,
    asset: ASSET,
    assetDecimals: 6,
    shareDecimals: 18,
    source: clone(expected.source),
    startedAtUtc: START,
    readAtUtc: END,
    deadlineMs: 120_000,
    traces: [
      {
        key: 'balanceOf',
        method: 'eth_call',
        params: [
          { to: VAULT, data: BALANCE_DATA },
          { blockHash: HASH, requireCanonical: true },
        ],
        result: RAW(shares),
        startedAtUtc: START,
        completedAtUtc: START,
      },
      {
        key: 'previewRedeem',
        method: 'eth_call',
        params: [
          { to: VAULT, data: PREVIEW_DATA(shares) },
          { blockHash: HASH, requireCanonical: true },
        ],
        result: RAW(ea),
        startedAtUtc: START,
        completedAtUtc: END,
      },
    ],
  }
  const evidence: MorphoV2HolderPositionEvidence = {
    schemaVersion: 1,
    kind: 'morpho_v2_holder_position_pair_v1',
    origins: [
      { host: expected.originHosts[0], observation: clone(observation) },
      { host: expected.originHosts[1], observation: clone(observation) },
    ],
  }
  return { expected, evidence }
}

describe('retained Morpho holder native position evidence', () => {
  it('retains both raw calls and approves only a conditional full-position match', () => {
    const { expected, evidence } = fixture()
    const decoded = decodeMorphoV2HolderPositionEvidence(
      encodeMorphoV2HolderPositionEvidence(evidence),
    )
    expect(decoded).toEqual(evidence)
    const approved = approveMorphoV2HolderPositionEvidence(decoded, expected)
    expect(approved).toMatchObject({
      sharesRaw: '42',
      fullEaRaw: '67',
      authenticated: false,
      executionProven: false,
      forecastValidated: false,
    })
    expect(selectedMorphoV2HolderPositionEvidence(approved, expected)).toBe(approved)
    expect(Object.isFrozen(approved.source)).toBe(true)
    expect(Object.isFrozen(approved.originHosts)).toBe(true)
  })

  it.each([
    [
      'owner calldata',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.traces[0].params[0].data = `0x70a08231${'4'.repeat(64)}`
      },
    ],
    [
      'requested-Q substituted for full S',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.traces[1].params[0].data = PREVIEW_DATA(1n)
      },
    ],
    [
      'raw share result',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.traces[0].result = RAW(43n)
      },
    ],
    [
      'raw full Ea result',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[1].observation.traces[1].result = RAW(68n)
      },
    ],
    [
      'vault call destination',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.traces[0].params[0].to = OWNER
      },
    ],
    [
      'block hash pin',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.traces[1].params[1].blockHash = `0x${'b'.repeat(64)}`
      },
    ],
    [
      'share units',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[1].observation.shareDecimals = 6
      },
    ],
    [
      'asset identity',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[1].observation.asset = OWNER
      },
    ],
    [
      'same origin twice',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[1].host = e.origins[0].host
      },
    ],
    [
      'unconfigured origin',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[1].host = 'attacker.example'
      },
    ],
    [
      'trailing result bytes',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.traces[1].result = `${RAW(67n)}00`
      },
    ],
    [
      'short result bytes',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.traces[1].result = '0x43'
      },
    ],
    [
      'noncanonical pin',
      (e: MorphoV2HolderPositionEvidence) => {
        Object.assign(e.origins[0].observation.traces[0].params[1], { requireCanonical: false })
      },
    ],
    [
      'extra caller or gas',
      (e: MorphoV2HolderPositionEvidence) => {
        Object.assign(e.origins[0].observation.traces[0].params[0], {
          from: OWNER,
          gas: '0x100000',
        })
      },
    ],
    [
      'unknown approval flag',
      (e: MorphoV2HolderPositionEvidence) => {
        Object.assign(e, { approved: true })
      },
    ],
    [
      'unfinalized source',
      (e: MorphoV2HolderPositionEvidence) => {
        Object.assign(e.origins[0].observation.source, { finalized: false })
      },
    ],
    [
      'noncanonical block time',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.source.blockTime = '2026-10-08T00:00:00Z'
      },
    ],
    [
      'unsafe block number',
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.source.blockNumber = Number.MAX_SAFE_INTEGER + 1
      },
    ],
  ] as const)('rejects %s', (_, mutate) => {
    const { expected, evidence } = fixture()
    mutate(evidence)
    expect(() => approveMorphoV2HolderPositionEvidence(evidence, expected)).toThrow()
  })

  it('requires independent source, holder, shares, Ea and units bindings', () => {
    for (const patch of [
      { owner: VAULT },
      { destination: OWNER },
      { sharesRaw: '1' },
      { fullEaRaw: '1' },
      { assetDecimals: 18 },
      { routeKey: 'Other route' },
    ]) {
      const { expected, evidence } = fixture()
      expect(() =>
        approveMorphoV2HolderPositionEvidence(evidence, { ...expected, ...patch }),
      ).toThrow()
    }
    const { expected, evidence } = fixture()
    expect(() =>
      approveMorphoV2HolderPositionEvidence(evidence, {
        ...expected,
        source: { ...expected.source, blockNumber: expected.source.blockNumber + 1 },
      }),
    ).toThrow()
  })

  it('enforces a two-minute observation deadline and ordered finite UTC traces', () => {
    for (const mutate of [
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.deadlineMs = 120_001
      },
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.deadlineMs = 999
      },
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.deadlineMs = Infinity
      },
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.traces[1].startedAtUtc = BLOCK_TIME
      },
      (e: MorphoV2HolderPositionEvidence) => {
        e.origins[0].observation.traces[0].completedAtUtc = 'not a time'
      },
    ]) {
      const { expected, evidence } = fixture()
      mutate(evidence)
      expect(() => approveMorphoV2HolderPositionEvidence(evidence, expected)).toThrow()
    }
    const { expected, evidence } = fixture()
    expect(() =>
      approveMorphoV2HolderPositionEvidence(evidence, {
        ...expected,
        asOfMs: Date.parse(BLOCK_TIME) + 7_200_001,
      }),
    ).toThrow()
    expect(() =>
      approveMorphoV2HolderPositionEvidence(evidence, { ...expected, asOfMs: Date.parse(START) }),
    ).toThrow()
  })

  it.each([
    ['one hour apart', 3_600_000, false],
    ['one millisecond past the pair limit', 119_001, false],
    ['exactly two minutes end to end', 119_000, true],
    ['overlapping origins', 500, true],
  ] as const)('bounds the entire pair capture: %s', (_, offsetMs, accepted) => {
    const { expected, evidence } = fixture()
    const shifted = evidence.origins[1].observation
    const shift = (time: string) => new Date(Date.parse(time) + offsetMs).toISOString()
    shifted.startedAtUtc = shift(shifted.startedAtUtc)
    shifted.readAtUtc = shift(shifted.readAtUtc)
    for (const trace of shifted.traces) {
      trace.startedAtUtc = shift(trace.startedAtUtc)
      trace.completedAtUtc = shift(trace.completedAtUtc)
    }
    expected.asOfMs = Date.parse(shifted.readAtUtc)
    // Both origins still have a valid one-second capture and the same fresh source.
    if (accepted) {
      expect(
        decodeMorphoV2HolderPositionEvidence(encodeMorphoV2HolderPositionEvidence(evidence)),
      ).toEqual(evidence)
      expect(approveMorphoV2HolderPositionEvidence(evidence, expected).sharesRaw).toBe('42')
    } else {
      expect(() => encodeMorphoV2HolderPositionEvidence(evidence)).toThrow()
      expect(() => decodeMorphoV2HolderPositionEvidence(JSON.stringify(evidence))).toThrow()
      expect(() => approveMorphoV2HolderPositionEvidence(evidence, expected)).toThrow()
    }
  })

  it('rejects duplicate/escaped keys, oversized payloads, extra traces and accessors', () => {
    const { evidence } = fixture()
    const text = encodeMorphoV2HolderPositionEvidence(evidence)
    for (const malformed of [
      text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      text.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
      `${' '.repeat(32 * 1024)}${text}`,
      text + '{}',
    ])
      expect(() => decodeMorphoV2HolderPositionEvidence(malformed)).toThrow()
    const extra = clone(evidence)
    extra.origins[0].observation.traces.push(clone(extra.origins[0].observation.traces[0]))
    expect(() => encodeMorphoV2HolderPositionEvidence(extra)).toThrow()
    let invoked = false
    Object.defineProperty(evidence, 'kind', {
      enumerable: true,
      get: () => {
        invoked = true
        return 'morpho_v2_holder_position_pair_v1'
      },
    })
    expect(() => encodeMorphoV2HolderPositionEvidence(evidence)).toThrow()
    expect(invoked).toBe(false)
  })

  it('does not transfer approval through JSON, a spread, mutation or stale selection', () => {
    const { expected, evidence } = fixture()
    const approved = approveMorphoV2HolderPositionEvidence(evidence, expected)
    expect(selectedMorphoV2HolderPositionEvidence(clone(approved), expected)).toBeNull()
    expect(selectedMorphoV2HolderPositionEvidence({ ...approved }, expected)).toBeNull()
    expect(Reflect.set(approved, 'sharesRaw', '1')).toBe(false)
    expect(
      selectedMorphoV2HolderPositionEvidence(approved, { ...expected, sharesRaw: '1' }),
    ).toBeNull()
    expect(
      selectedMorphoV2HolderPositionEvidence(approved, {
        ...expected,
        asOfMs: Date.parse(BLOCK_TIME) + 7_200_001,
      }),
    ).toBeNull()
    expected.sharesRaw = '1'
    evidence.origins[0].observation.traces[0].result = RAW(1n)
    expect(approved.sharesRaw).toBe('42')
  })

  it('permits native zero shares/zero Ea without implying an executable exit', () => {
    const { expected, evidence } = fixture(0n, 0n)
    const approved = approveMorphoV2HolderPositionEvidence(evidence, expected)
    expect(approved).toMatchObject({ sharesRaw: '0', fullEaRaw: '0', executionProven: false })
  })
})
