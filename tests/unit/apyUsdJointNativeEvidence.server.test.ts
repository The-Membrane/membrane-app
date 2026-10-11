import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  plans: new WeakSet<object>(),
  originals: new WeakMap<object, object>(),
  records: [] as any[],
  finishes: [] as any[],
  captureCalls: 0,
  historyCalls: 0,
  failedCapture: false,
  incomplete: false,
  historyFailure: -1,
  expireDuringFinish: false,
  retentionReason: 'qualified',
  capturedSubjects: [] as string[],
  retentionMs: 0,
  closureDigest: 'a'.repeat(64) as string | undefined,
  anchorMismatch: false,
}))
vi.mock('@/scripts/research/apyusd-joint-native-history-capture.mjs', () => {
  const prepare = (input: any) => {
    const p = structuredClone(input)
    mocks.plans.add(p)
    return p
  }
  const publish = (plan: any, wire: any) => {
    const value = {
      accepted: !mocks.failedCapture,
      batches: [
        { plan, receipt: { failure: mocks.failedCapture ? 'native_failure' : null, ledger: [] } },
      ],
      wire,
    }
    mocks.originals.set(value, plan)
    return value
  }
  return {
    prepareApyUsdJointNativeCurrentCapturePlan: prepare,
    prepareApyUsdJointNativeHistoryCapturePlan: prepare,
    captureApyUsdJointNativeCurrent: vi.fn(async (plan: any) => {
      mocks.captureCalls++
      return publish(plan, {
        origins: [0, 1].map(() => ({ acquiredAtUtc: new Date().toISOString() })),
      })
    }),
    captureApyUsdJointNativeHistoryBatch: vi.fn(async (plan: any) => {
      mocks.historyCalls++
      mocks.capturedSubjects.push(plan.fullSharesRaw)
      const rows = [0, 1].map((n) => ({
        binding: {
          ...plan,
          cashIndex: 112 + plan.batchIndex * 2 + n,
          source: {
            ...plan.currentSource,
            blockNumber: 80 + plan.batchIndex * 2 + n,
            blockTime: new Date(
              Date.now() - (10 - plan.batchIndex * 2 - n) * 86400000,
            ).toISOString(),
          },
          owner: null,
        },
        wire: { origins: [0, 1].map(() => ({ acquiredAtUtc: new Date().toISOString() })) },
      }))
      if (mocks.anchorMismatch && plan.batchIndex === 0) rows[0].binding.cashIndex = 119
      const value = publish(plan, rows)
      if (plan.batchIndex === mocks.historyFailure) value.accepted = false
      return value
    }),
    selectedOriginalApyUsdJointNativeCapture: (value: any, plan: any) =>
      mocks.originals.get(value) === plan && value.accepted ? value : null,
    selectedOriginalApyUsdJointNativeReceiptsForRetention: (value: any) =>
      mocks.originals.has(value) ? value.batches : null,
  }
})
vi.mock('@/lib/carry/holderNativeHistoryOriginals.server', () => ({
  // Synthetic fixtures must never write into the actual research data directory.
  beginHolderNativeHistoryOriginalSeries: vi.fn((input: any) => ({ input })),
  recordHolderNativeHistoryOriginalBatch: vi.fn((handle: any, record: any) => {
    mocks.records.push({ handle, record })
  }),
  finishHolderNativeHistoryOriginalSeries: vi.fn((handle: any, qualification: any) => {
    mocks.finishes.push({ handle, qualification })
    if (mocks.expireDuringFinish) vi.setSystemTime(Date.now() + 1800001)
    if (mocks.retentionMs) vi.setSystemTime(Date.now() + mocks.retentionMs)
    return {
      status: mocks.retentionReason === 'qualified' ? 'retained' : 'unavailable',
      reason: mocks.retentionReason,
      recordedBatches: 1,
      producerReplayQualification: qualification.qualification,
      ...(mocks.closureDigest ? { sourceClosureSha256: mocks.closureDigest } : {}),
      originalAuthority: false,
      authenticated: false,
      executionQualified: false,
      historicalOwnership: false,
    }
  }),
}))
vi.mock('@/lib/carry/apyUsdJointNativeEvidence', () => ({
  APY_USD_JOINT_NATIVE_ANCHORS: [112, 113, 114, 115, 116, 117, 118, 119].map((cashIndex) => ({
    cashIndex,
  })),
  // Orchestration-only native facts. Actual raw ABI replay is tested by the separate codec suite.
  apyUsdJointNativeCurrentReadPlan: () => [],
  replayApyUsdJointNativeCurrent: (_wire: any, b: any) => ({
    owner: b.owner,
    vestingAddress: null,
    runtimeIdentities: [],
    current: {
      source: b.source,
      readAtUtc: b.acquiredAtUtc,
      fullSharesRaw: b.candidateReceiptIds[0] === '0' ? '0' : '391143432',
      runtimeRegime: 'synthetic_only',
      vaultUnlockingFeeWad: '1000000000000000',
      feeCurve: { minFeeWad: '0' },
      receiptInventory: { complete: !mocks.incomplete },
    },
    originalAuthority: false,
    authenticated: false,
    executionAuthority: false,
  }),
  replayApyUsdJointNativeHistoryPoint: (_wire: any, b: any) => ({
    source: b.source,
    acquiredAtUtc: b.acquiredAtUtc,
    fullSharesRaw: b.fullSharesRaw,
    runtimeRegime: b.currentRuntimeRegime,
    runtimeIdentities: [],
    vestingAddress: null,
    vaultUnlockingFeeWad: b.vaultUnlockingFeeWad,
    feeCurve: { minFeeWad: '0' },
    owner: null,
    historicalOwnership: false,
  }),
}))
const T = Date.parse('2026-10-08T23:10:00.000Z')
const question = () => ({
  routeKey: 'apxUSD → ApyUSD [apxUSD]',
  destination: '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a',
  asset: '0x98a878b1cd98131b271883b390f68d2c90674665',
  owner: '0x9830d6b37fe7488707cc4ad7f8b481d75eb2a8c2',
  candidateReceiptIds: ['881'],
  source: {
    chainId: 1 as const,
    finalized: true as const,
    blockNumber: 100,
    blockHash: '0x' + 'a'.repeat(64),
    blockTime: new Date(T).toISOString(),
  },
  asOfMs: T,
})
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(T)
  mocks.records = []
  mocks.finishes = []
  mocks.captureCalls = 0
  mocks.historyCalls = 0
  mocks.failedCapture = false
  mocks.incomplete = false
  mocks.historyFailure = -1
  mocks.expireDuringFinish = false
  mocks.retentionReason = 'qualified'
  mocks.capturedSubjects = []
  mocks.retentionMs = 0
  mocks.closureDigest = 'a'.repeat(64)
  mocks.anchorMismatch = false
})
afterEach(() => {
  vi.useRealTimers()
})
const getProducer = () => import('@/lib/carry/apyUsdJointNativeEvidence.server')
describe('protected APY native orchestration (isolated synthetic acquisitions)', () => {
  it('retains before private replay and only exact original objects select', async () => {
    const m = await getProducer(),
      q = question(),
      current = await m.acquireApyUsdJointNativeCurrent(q)
    expect(current).not.toBeNull()
    expect(mocks.records).toHaveLength(1)
    expect(mocks.records[0].record.capturedAccepted).toBe(true)
    expect(m.selectedOriginalApyUsdJointNativeCurrent(current, q)).toBe(current!.fact)
    expect(m.selectedOriginalApyUsdJointNativeCurrent(structuredClone(current), q)).toBeNull()
    expect(
      m.selectedOriginalApyUsdJointNativeCurrent(current, { ...q, owner: '0x' + '1'.repeat(40) }),
    ).toBeNull()
    expect(Object.isFrozen(current!.fact.current)).toBe(true)
  })
  it('rejects accessors without invoking them and isolates caller mutation', async () => {
    const m = await getProducer(),
      q = question()
    let touched = false
    Object.defineProperty(q, 'owner', {
      enumerable: true,
      get() {
        touched = true
        return ''
      },
    })
    expect(await m.acquireApyUsdJointNativeCurrent(q)).toBeNull()
    expect(touched).toBe(false)
    expect(mocks.captureCalls).toBe(0)
    const input = question(),
      pending = m.acquireApyUsdJointNativeCurrent(input)
    input.candidateReceiptIds[0] = '1140'
    const current = await pending
    expect(current!.evidence.binding.candidateReceiptIds).toEqual(['881'])
  })
  it('preserves failed originals unqualified and rejects incomplete NFT enumeration', async () => {
    const m = await getProducer()
    mocks.failedCapture = true
    expect(await m.acquireApyUsdJointNativeCurrent(question())).toBeNull()
    expect(mocks.records).toHaveLength(1)
    expect(mocks.finishes[0].qualification.qualification).toBe(false)
    mocks.failedCapture = false
    mocks.incomplete = true
    expect(await m.acquireApyUsdJointNativeCurrent(question())).toBeNull()
    expect(m.apyUsdJointNativeEvidenceDiagnostic()?.qualified).toBe(false)
  })
  it('does not mint authority from remote filesystem unavailability or ignore source drift', async () => {
    const m = await getProducer()
    mocks.retentionReason = 'filesystem_unavailable'
    const current = await m.acquireApyUsdJointNativeCurrent(question())
    expect(current?.originalAuthority).toBe(false)
    expect(current).not.toBeNull()
    mocks.retentionReason = 'source_changed'
    expect(await m.acquireApyUsdJointNativeCurrent(question())).toBeNull()
  })
  it('rechecks actual source TTL after retention finalization', async () => {
    const m = await getProducer()
    mocks.expireDuringFinish = true
    expect(await m.acquireApyUsdJointNativeCurrent(question())).toBeNull()
    expect(m.apyUsdJointNativeEvidenceDiagnostic()?.qualified).toBe(false)
  })
  it('captures four separate two-anchor batches at actual S including zero, then reuses same-S originals', async () => {
    const m = await getProducer(),
      q = question()
    q.candidateReceiptIds = ['0']
    const current = (await m.acquireApyUsdJointNativeCurrent(q))!,
      h = (await m.readApyUsdJointNativeHistoryAtIssue(current, q))!
    expect(h.evidence.points.map((p) => p.binding.cashIndex)).toEqual([
      112, 113, 114, 115, 116, 117, 118, 119,
    ])
    expect(mocks.capturedSubjects).toEqual(['0', '0', '0', '0'])
    expect(
      mocks.records
        .slice(1)
        .every((r) => r.record.batchIndex === 0 && r.handle.input.kind === 'apy_usd_history'),
    ).toBe(true)
    const selected = m.selectedOriginalApyUsdJointNativeHistory(h, current, q)
    expect(selected).toHaveLength(8)
    expect(selected!.every((p) => p.owner === null)).toBe(true)
    expect(Object.isFrozen(selected)).toBe(true)
    expect(m.selectedOriginalApyUsdJointNativeHistory(structuredClone(h), current, q)).toBeNull()
    expect(await m.readApyUsdJointNativeHistoryAtIssue(current, q)).not.toBeNull()
    expect(mocks.historyCalls).toBe(4)
  })
  it('retains a rejecting historical batch and never issues a partial eight-anchor history', async () => {
    const m = await getProducer(),
      q = question(),
      current = (await m.acquireApyUsdJointNativeCurrent(q))!
    mocks.historyFailure = 1
    expect(await m.readApyUsdJointNativeHistoryAtIssue(current, q)).toBeNull()
    expect(mocks.historyCalls).toBe(2)
    expect(mocks.records).toHaveLength(3)
    expect(m.apyUsdJointNativeEvidenceDiagnostic()?.qualified).toBe(false)
  })
  it('coalesces the same original subject into one four-batch series', async () => {
    const m = await getProducer(),
      q = question(),
      current = (await m.acquireApyUsdJointNativeCurrent(q))!
    const [a, b] = await Promise.all([
      m.readApyUsdJointNativeHistoryAtIssue(current, q),
      m.readApyUsdJointNativeHistoryAtIssue(current, q),
    ])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(mocks.historyCalls).toBe(4)
    expect(m.selectedOriginalApyUsdJointNativeHistory(a, current, q)).toHaveLength(8)
  })
  it('uses retained receipt discovery only as hints and requires fresh native completeness', async () => {
    const m = await getProducer()
    expect(m.apyUsdJointNativeReceiptCandidateHints(question().owner)).toEqual(['881'])
    expect(m.apyUsdJointNativeReceiptCandidateHints('0x' + '1'.repeat(40))).toEqual([])
    expect(m.apyUsdJointNativeReceiptCandidateHints(question().owner, '1137')).toEqual(['1137'])
    expect(() => m.apyUsdJointNativeReceiptCandidateHints(question().owner, '00')).toThrow()
    mocks.incomplete = true
    expect(await m.acquireApyUsdJointNativeCurrent(question())).toBeNull()
  })
  it('preserves acquisition and post-retention availability clocks separately through cache reuse', async () => {
    const m = await getProducer(),
      q = question()
    mocks.retentionMs = 100
    const current = (await m.acquireApyUsdJointNativeCurrent(q))!
    expect(current.fact.current.readAtUtc).toBe(new Date(T).toISOString())
    expect(current.availableAtUtc).toBe(new Date(T + 200).toISOString())
    expect(m.selectedOriginalApyUsdJointNativeCurrent(current, q)).toBeNull()
    q.asOfMs = Date.now()
    const h = (await m.readApyUsdJointNativeHistoryAtIssue(current, q))!
    expect(Date.parse(h.evidence.availableAtUtc)).toBe(T + 600)
    expect(Date.parse(h.issuedAtUtc)).toBe(T + 600)
    expect(Date.parse(h.evidence.acquiredAtUtc)).toBe(T + 500)
    vi.setSystemTime(T + 1000)
    q.asOfMs = Date.now()
    const reused = (await m.readApyUsdJointNativeHistoryAtIssue(current, q))!
    expect(reused.evidence.availableAtUtc).toBe(h.evidence.availableAtUtc)
    expect(reused.evidence.acquiredAtUtc).toBe(h.evidence.acquiredAtUtc)
    expect(reused.issuedAtUtc).toBe(new Date(T + 1000).toISOString())
    expect(mocks.historyCalls).toBe(4)
  })
  it('rejects source/future clocks and hidden requested amount without native starts', async () => {
    const m = await getProducer(),
      q = question()
    expect(await m.acquireApyUsdJointNativeCurrent({ ...q, asOfMs: T + 1 })).toBeNull()
    expect(
      await m.acquireApyUsdJointNativeCurrent({
        ...q,
        source: { ...q.source, blockTime: new Date(T + 1).toISOString() },
      }),
    ).toBeNull()
    expect(await m.acquireApyUsdJointNativeCurrent({ ...q, requestedRaw: '1' } as any)).toBeNull()
    expect(mocks.captureCalls).toBe(0)
  })
  it('reuses same-S history for a fresh owner/source while preserving the original reference and clocks', async () => {
    const m = await getProducer(),
      q = question(),
      first = (await m.acquireApyUsdJointNativeCurrent(q))!
    const a = (await m.readApyUsdJointNativeHistoryAtIssue(first, q))!
    vi.setSystemTime(T + 1000)
    const next = {
      ...q,
      owner: '0x' + '1'.repeat(40),
      asOfMs: Date.now(),
      source: {
        ...q.source,
        blockNumber: 101,
        blockHash: '0x' + 'b'.repeat(64),
        blockTime: new Date(T + 1000).toISOString(),
      },
    }
    const fresh = (await m.acquireApyUsdJointNativeCurrent(next))!,
      b = (await m.readApyUsdJointNativeHistoryAtIssue(fresh, next))!
    expect(mocks.historyCalls).toBe(4)
    expect(
      b.evidence.points.every(
        (p) => JSON.stringify(p.binding.currentSource) === JSON.stringify(q.source),
      ),
    ).toBe(true)
    expect(b.evidence.acquiredAtUtc).toBe(a.evidence.acquiredAtUtc)
    expect(b.evidence.availableAtUtc).toBe(a.evidence.availableAtUtc)
    expect(m.selectedOriginalApyUsdJointNativeHistory(b, fresh, next)).toHaveLength(8)
    // Q/H do not enter this native source binding or historical getter plan.
    expect(Object.hasOwn(b.evidence, 'requestedRaw')).toBe(false)
    expect(Object.hasOwn(b.evidence, 'horizonHours')).toBe(false)
  })
  it('invalidates cache reuse for a changed captured executing source closure', async () => {
    const m = await getProducer(),
      q = question(),
      first = (await m.acquireApyUsdJointNativeCurrent(q))!
    expect(await m.readApyUsdJointNativeHistoryAtIssue(first, q)).not.toBeNull()
    mocks.closureDigest = 'b'.repeat(64)
    const fresh = (await m.acquireApyUsdJointNativeCurrent(q))!
    expect(await m.readApyUsdJointNativeHistoryAtIssue(fresh, q)).not.toBeNull()
    expect(mocks.historyCalls).toBe(8)
  })
  it('rejects a source/anchor mismatch and a same-height replacement reference', async () => {
    const m = await getProducer(),
      q = question(),
      first = (await m.acquireApyUsdJointNativeCurrent(q))!
    mocks.anchorMismatch = true
    expect(await m.readApyUsdJointNativeHistoryAtIssue(first, q)).toBeNull()
    mocks.anchorMismatch = false
    expect(await m.readApyUsdJointNativeHistoryAtIssue(first, q)).not.toBeNull()
    const replacement = { ...q, source: { ...q.source, blockHash: '0x' + 'b'.repeat(64) } }
    const fresh = (await m.acquireApyUsdJointNativeCurrent(replacement))!
    expect(await m.readApyUsdJointNativeHistoryAtIssue(fresh, replacement)).toBeNull()
  })
  it('does not grant cross-acquisition closure equivalence when local snapshots are unavailable', async () => {
    const m = await getProducer(),
      q = question()
    mocks.closureDigest = undefined
    mocks.retentionReason = 'filesystem_unavailable'
    const a = (await m.acquireApyUsdJointNativeCurrent(q))!
    expect(await m.readApyUsdJointNativeHistoryAtIssue(a, q)).not.toBeNull()
    expect(await m.readApyUsdJointNativeHistoryAtIssue(a, q)).not.toBeNull()
    expect(mocks.historyCalls).toBe(4)
    const b = (await m.acquireApyUsdJointNativeCurrent(q))!
    expect(await m.readApyUsdJointNativeHistoryAtIssue(b, q)).not.toBeNull()
    expect(mocks.historyCalls).toBe(8)
  })
})
