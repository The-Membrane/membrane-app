import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { umbrellaGhoJointNativeHistoryReadPlan } from '@/lib/carry/umbrellaGhoJointNativeHistory'

// All private-current and capture identities here are controlled unit fixtures.
// They do not authenticate the archived receipt as a fresh acquisition.
const state = vi.hoisted(() => ({
  now: 0,
  current: new WeakMap<object, any>(),
  captures: new WeakMap<object, any>(),
  prepare: vi.fn(),
  capture: vi.fn(),
  begin: vi.fn(),
  record: vi.fn(),
  finish: vi.fn(),
  badPrivacy: false,
  badPhysical: false,
  badRaw: null as null | 'word' | 'code' | 'drift' | 'policy' | 'unsupported',
  expireAfterCapture: false,
  expireAtFinish: false,
  sinkReason: 'qualified',
  gate: null as null | Promise<void>,
}))
vi.mock('@/lib/carry/holderNativeHistoryOriginals.server', () => ({
  beginHolderNativeHistoryOriginalSeries: (v: any) => state.begin(v),
  recordHolderNativeHistoryOriginalBatch: (s: any, v: any) => state.record(s, v),
  finishHolderNativeHistoryOriginalSeries: (s: any, v: any) => state.finish(s, v),
}))
vi.mock('@/lib/carry/umbrellaGhoNativeCapacity.server', () => ({
  selectedOriginalUmbrellaGhoNativeCapacity: (pointer: object, b: any) => {
    const fact = state.current.get(pointer)
    if (
      !fact ||
      b.owner !== fact.owner ||
      b.asset !== fact.asset ||
      b.routeKey !== fact.routeKey ||
      b.destination !== fact.destination ||
      b.assetDecimals !== 18 ||
      b.shareDecimals !== 18 ||
      JSON.stringify(b.source) !== JSON.stringify(fact.source) ||
      b.asOfMs > state.now ||
      b.asOfMs < Date.parse(fact.readAtUtc) ||
      state.now - Date.parse(fact.source.blockTime) > 1800000
    )
      return null
    return fact
  },
}))
vi.mock('@/scripts/research/umbrella-gho-joint-history-capture.mjs', () => ({
  prepareUmbrellaGhoJointHistoryCapturePlan: (v: any) => state.prepare(v),
  captureUmbrellaGhoJointHistoryBatch: (v: any) => state.capture(v),
  selectedOriginalUmbrellaGhoJointHistoryReceiptForRetention: (v: any) =>
    !state.badPrivacy && state.captures.has(v) ? v.receipt : null,
  selectedOriginalUmbrellaGhoJointHistoryBatch: (v: object, p: any) => {
    const original = state.captures.get(v)
    return !state.badPhysical && original?.plan === p && original.nativeRequestsMatch ? v : null
  },
}))
const base = join(
  process.cwd(),
  'data/research/venue-signals/umbrella-gho-joint-native-evidence-2026-10-08',
)
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const indexBytes = readFileSync(join(base, 'evidence-index.json'))
if (sha(indexBytes) !== '98b80e938432a08511ef163040cf24285dacdb61031465b2a8c3dd54cad86e6b')
  throw Error('archive index changed')
const index = JSON.parse(indexBytes.toString())
function original(name: string) {
  const bytes = readFileSync(join(base, name)),
    r = index.files.find((r: any) => r.destination === name)
  if (!r || r.bytes !== bytes.length || r.sha256 !== sha(bytes))
    throw Error('archived fixture changed')
  return JSON.parse(bytes.toString())
}
const historicalPlan = original('history-292/plan.json')
const terminals = [
  original('history-292/batch-0-terminal.json'),
  original('history-292/batch-1-terminal.json'),
]
const currentPath = join(
  process.cwd(),
  'tests/unit/fixtures/umbrella-gho-native-current50-oct8.json',
)
const currentBytes = readFileSync(currentPath)
if (sha(currentBytes) !== '3294e23d58c3dbdbca1b129dd14593a7081d92316cb867522e32353d60df8d3e')
  throw Error('approved current50 fixture changed')
const actualCurrentFact = JSON.parse(currentBytes.toString())
function canonical(v: any): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
        .join(',') +
      '}'
    )
  return JSON.stringify(v)
}
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x)
    Object.freeze(v)
  }
  return v
}
let api: typeof import('@/lib/carry/umbrellaGhoJointHistoricalEvidence.server')
function current(fact = structuredClone(actualCurrentFact)) {
  const pointer = deepFreeze({ fixtureCurrentOnly: true })
  state.current.set(pointer, deepFreeze(fact))
  return pointer
}
function binding(fact = actualCurrentFact) {
  return {
    routeKey: fact.routeKey,
    destination: fact.destination,
    owner: fact.owner,
    asset: fact.asset,
    assetDecimals: 18,
    shareDecimals: 18,
    source: { ...fact.source },
    asOfMs: state.now,
  } as any
}
beforeEach(async () => {
  vi.resetModules()
  state.now = Date.parse('2026-10-08T20:14:00.000Z')
  vi.spyOn(Date, 'now').mockImplementation(() => state.now)
  state.current = new WeakMap()
  state.captures = new WeakMap()
  state.badPrivacy = false
  state.badPhysical = false
  state.badRaw = null
  state.expireAfterCapture = false
  state.expireAtFinish = false
  state.sinkReason = 'qualified'
  state.gate = null
  state.begin.mockReset().mockImplementation(() => ({ fixtureSinkOnly: true }))
  state.record.mockReset()
  state.finish.mockReset().mockImplementation((_s, v) => {
    if (state.expireAtFinish) state.now += 1800000
    return {
      status: state.sinkReason === 'qualified' ? 'retained' : 'unavailable',
      reason: state.sinkReason,
      kind: 'umbrella_gho_history',
      producerReplayQualification: v.qualification,
      recordedBatches: v.batchQualifications.length,
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      historicalOwnership: false,
    }
  })
  state.prepare.mockReset().mockImplementation((v: any) =>
    deepFreeze({
      ...v,
      anchors: historicalPlan.anchors
        .slice(v.batchIndex * 4, v.batchIndex * 4 + 4)
        .map((a: any) => ({
          ...a,
          requests: umbrellaGhoJointNativeHistoryReadPlan({
            cashIndex: a.cashIndex,
            source: a.source,
            currentSource: v.currentSource,
            fullSharesRaw: v.fullSharesRaw,
            cooldownSharesRaw: v.cooldownSharesRaw,
            acquiredAtUtc: new Date(state.now).toISOString(),
          })!,
        })),
    }),
  )
  state.capture.mockReset().mockImplementation(async (plan: any) => {
    if (state.gate) await state.gate
    const receipt = structuredClone(terminals[plan.batchIndex])
    if (state.badRaw) {
      const key =
        state.badRaw === 'code'
          ? 'implementationCode'
          : state.badRaw === 'policy'
            ? 'cooldownSeconds'
            : 'fullEaRaw'
      const specIndex = plan.anchors[0].requests.findIndex((s: any) => s.key === key)
      const row = receipt.ledger[2 + (state.badRaw === 'drift' ? 18 : 0) + specIndex]
      const envelope = JSON.parse(Buffer.from(row.rawBodyBase64, 'base64').toString())
      if (state.badRaw === 'unsupported') {
        delete envelope.result
        envelope.error = { code: -32601, message: 'unit native getter unavailable' }
      } else if (state.badRaw === 'word') envelope.result = '0x01'
      else if (state.badRaw === 'code') envelope.result = '0x1234'
      else envelope.result = '0x' + (BigInt(envelope.result) + 1n).toString(16).padStart(64, '0')
      row.rawBodyBase64 = Buffer.from(JSON.stringify(envelope)).toString('base64')
    }
    const nativeRequestsMatch = plan.anchors.every((a: any, n: number) =>
      a.requests.every((s: any, i: number) =>
        [0, 1].every(
          (o) =>
            canonical(s.request) ===
            canonical({
              method: receipt.ledger[2 + n * 36 + o * 18 + i].request.method,
              params: receipt.ledger[2 + n * 36 + o * 18 + i].request.params,
            }),
        ),
      ),
    )
    const result = deepFreeze({
      receipt,
      accepted: true,
      originalAuthority: false,
      authenticated: false,
    })
    state.captures.set(result, { plan, nativeRequestsMatch })
    if (state.expireAfterCapture) state.now += 1800000
    return result
  })
  api = await import('@/lib/carry/umbrellaGhoJointHistoricalEvidence.server')
})
afterEach(() => vi.restoreAllMocks())
describe('protected Umbrella history producer (isolated original-pointer fixtures)', () => {
  it('derives actual fullS and CS, retains both native batches before replay, and issues after retention', async () => {
    const pointer = current(),
      q = binding(),
      value = await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(pointer, q)
    expect(value).not.toBeNull()
    expect(value!.evidence.points).toHaveLength(8)
    expect(state.capture).toHaveBeenCalledTimes(2)
    expect(state.record).toHaveBeenCalledTimes(2)
    expect(state.begin).toHaveBeenCalledWith({
      kind: 'umbrella_gho_history',
      sharesRaw: actualCurrentFact.fullSharesRaw,
    })
    expect(state.prepare.mock.calls.map(([p]) => [p.fullSharesRaw, p.cooldownSharesRaw])).toEqual([
      [actualCurrentFact.fullSharesRaw, actualCurrentFact.cooldownSharesRaw],
      [actualCurrentFact.fullSharesRaw, actualCurrentFact.cooldownSharesRaw],
    ])
    expect(state.record.mock.invocationCallOrder[1]).toBeLessThan(
      state.finish.mock.invocationCallOrder[0],
    )
    expect(value!.issuedAtUtc).toBe(new Date(state.now).toISOString())
    expect(value!.evidence.acquiredAtUtc).toBe(
      original('history-292/replayed-native-points.json')[7].acquiredAtUtc,
    )
    expect(JSON.stringify(value)).not.toContain('artifactDirectory')
    expect(value!.originalAuthority).toBe(false)
    expect(value!.evidence.forecastIssued).toBe(false)
    expect(value!.evidence.subject.owner).toBeNull()
    expect(value!.evidence.subject.historicalOwnership).toBe(false)
    expect(api.selectedOriginalUmbrellaGhoJointHistoricalEvidence(value, pointer, q)).toHaveLength(
      8,
    )
  })
  it('rejects cloned/serialized current acquisition before any new capture or sink begin', async () => {
    const pointer = current()
    expect(
      await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(structuredClone(pointer), binding()),
    ).toBeNull()
    expect(state.begin).not.toHaveBeenCalled()
    expect(state.capture).not.toHaveBeenCalled()
  })
  it('selects only the exact frozen original history wrapper and complete original holder/source', async () => {
    const pointer = current(),
      q = binding(),
      value = await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(pointer, q)
    expect(value).not.toBeNull()
    expect(Object.isFrozen(value!.evidence.points[0].wire.origins)).toBe(true)
    expect(
      api.selectedOriginalUmbrellaGhoJointHistoricalEvidence(structuredClone(value), pointer, q),
    ).toBeNull()
    expect(api.selectedOriginalUmbrellaGhoJointHistoricalEvidence(value, current(), q)).toBeNull()
    expect(
      api.selectedOriginalUmbrellaGhoJointHistoricalEvidence(value, pointer, {
        ...q,
        owner: '0x1234567890123456789012345678901234567890',
      }),
    ).toBeNull()
    expect(
      api.selectedOriginalUmbrellaGhoJointHistoricalEvidence(value, pointer, {
        ...q,
        source: { ...q.source, blockHash: '0x' + '1'.repeat(64) },
      }),
    ).toBeNull()
  })
  it('rejects privacy-unsafe originals before any raw sink write', async () => {
    state.badPrivacy = true
    expect(await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(current(), binding())).toBeNull()
    expect(state.capture).toHaveBeenCalledTimes(1)
    expect(state.record).not.toHaveBeenCalled()
    expect(state.finish.mock.calls[0][1]).toEqual({
      qualification: false,
      reason: 'replay_rejected',
      batchQualifications: [],
    })
    expect(api.getLastUmbrellaGhoJointHistoricalEvidenceDiagnostic()?.phase).toBe(
      'retention_privacy',
    )
  })
  it('rejects physical-original failure after preserving its exact raw receipt', async () => {
    state.badPhysical = true
    expect(await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(current(), binding())).toBeNull()
    expect(state.record).toHaveBeenCalledTimes(1)
    expect(state.record.mock.calls[0][1].receipt.physicalStarts).toBe(146)
    expect(state.finish.mock.calls[0][1]).toEqual({
      qualification: false,
      reason: 'replay_rejected',
      batchQualifications: [false],
    })
  })
  it.each(['word', 'code', 'drift', 'policy', 'unsupported'] as const)(
    'preserves then rejects %s native raw facts',
    async (bad) => {
      state.badRaw = bad
      expect(
        await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(current(), binding()),
      ).toBeNull()
      expect(state.record).toHaveBeenCalledTimes(1)
      expect(state.finish.mock.calls[0][1].qualification).toBe(false)
      expect(state.capture).toHaveBeenCalledTimes(1)
    },
  )
  it('rechecks actual TTL after await and raw receipt retention, stopping before another146 starts', async () => {
    state.expireAfterCapture = true
    expect(await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(current(), binding())).toBeNull()
    expect(state.record).toHaveBeenCalledTimes(1)
    expect(state.capture).toHaveBeenCalledTimes(1)
    expect(api.getLastUmbrellaGhoJointHistoricalEvidenceDiagnostic()?.phase).toBe('current_recheck')
  })
  it('does not issue if source TTL expires during final manifest fsync', async () => {
    state.expireAtFinish = true
    expect(await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(current(), binding())).toBeNull()
    expect(state.record).toHaveBeenCalledTimes(2)
    expect(state.finish).toHaveBeenCalledTimes(1)
    expect(api.getLastUmbrellaGhoJointHistoricalEvidenceDiagnostic()?.qualified).toBe(false)
  })
  it('keeps valid native facts when local retention is unavailable, without granting authority', async () => {
    state.sinkReason = 'filesystem_unavailable'
    const value = await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(current(), binding())
    expect(value).not.toBeNull()
    expect(value!.authenticated).toBe(false)
    expect(api.getLastUmbrellaGhoJointHistoricalEvidenceDiagnostic()?.retention?.status).toBe(
      'unavailable',
    )
  })
  it('refuses source/artifact drift reported by the retention sink', async () => {
    state.sinkReason = 'source_changed'
    expect(await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(current(), binding())).toBeNull()
    expect(api.getLastUmbrellaGhoJointHistoricalEvidenceDiagnostic()?.retention?.reason).toBe(
      'source_changed',
    )
  })
  it('coalesces sameS+CS requests, then reuses original native history without another capture', async () => {
    let release!: () => void
    state.gate = new Promise<void>((r) => {
      release = r
    })
    const pointer = current(),
      q = binding(),
      a = api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(pointer, q),
      b = api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(pointer, q)
    await Promise.resolve()
    expect(state.capture).toHaveBeenCalledTimes(1)
    release()
    const [first, second] = await Promise.all([a, b])
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    state.gate = null
    expect(await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(pointer, q)).not.toBeNull()
    expect(state.capture).toHaveBeenCalledTimes(2)
  })
  it('keeps one active capture across differentS/CS requests', async () => {
    let release!: () => void
    state.gate = new Promise<void>((r) => {
      release = r
    })
    const first = api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(current(), binding())
    await Promise.resolve()
    const alternate = structuredClone(actualCurrentFact)
    alternate.cooldownSharesRaw = '0'
    expect(
      await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(
        current(alternate),
        binding(alternate),
      ),
    ).toBeNull()
    expect(state.capture).toHaveBeenCalledTimes(1)
    release()
    expect(await first).not.toBeNull()
    expect(state.capture).toHaveBeenCalledTimes(2)
  })
  it('does not reuse the S/CS cache for changed shares or accept old native calldata', async () => {
    const pointer = current(),
      q = binding()
    expect(await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(pointer, q)).not.toBeNull()
    const altered = structuredClone(actualCurrentFact)
    altered.cooldownSharesRaw = '0'
    expect(
      await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(current(altered), binding(altered)),
    ).toBeNull()
    expect(state.prepare.mock.calls[2][0].cooldownSharesRaw).toBe('0')
    expect(state.capture).toHaveBeenCalledTimes(3)
  })
  it('snapshots primitive own data before await, and never invokes an accessor', async () => {
    let release!: () => void
    state.gate = new Promise<void>((r) => {
      release = r
    })
    const pointer = current(),
      q = binding(),
      work = api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(pointer, q)
    q.owner = '0x1234567890123456789012345678901234567890'
    q.source.blockHash = '0x' + '1'.repeat(64)
    release()
    expect(await work).not.toBeNull()
    const getter = vi.fn(() => actualCurrentFact.owner),
      bad = binding()
    Object.defineProperty(bad, 'owner', { get: getter, enumerable: true })
    expect(await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(pointer, bad)).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })
  it('expires original selection under a real advancing render clock', async () => {
    const pointer = current(),
      q = binding(),
      value = await api.readUmbrellaGhoJointHistoricalEvidenceAtIssue(pointer, q)
    expect(value).not.toBeNull()
    state.now = Date.parse(actualCurrentFact.source.blockTime) + 1800001
    expect(
      api.selectedOriginalUmbrellaGhoJointHistoricalEvidence(value, pointer, {
        ...q,
        asOfMs: state.now,
      }),
    ).toBeNull()
  })
})
