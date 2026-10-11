import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { susdePinnedJointHistory } from '@/lib/carry/susdeJointHistoryPins'
import {
  susdePinnedJointHistoryEvidenceSet,
  SUSDE_JOINT_HISTORY_EVIDENCE_SET_PIN,
} from '@/lib/carry/susdeJointHistoryEvidenceSet'
import {
  buildSusdeHolderTimeProcess,
  buildSusdeHolderTimeProcessV2,
  selectedSusdeHolderTimeProcessV2,
  type SusdeHolderTimeProcessV2Input,
} from '@/lib/carry/susdeHolderTimeProcess'

const UNIT = 10n ** 18n
const clone = <T>(value: T): T => structuredClone(value)
function fixture(): SusdeHolderTimeProcessV2Input {
  const history = susdePinnedJointHistoryEvidenceSet()
  return {
    history,
    requestedRaw: String(10n * UNIT),
    issueAtUtc: '2026-10-08T04:16:00.000Z',
    horizonHours: 24,
    analysisMode: 'issue_time_conditional',
    current: {
      owner: '0x' + 'a'.repeat(40),
      source: {
        chainId: 1,
        blockNumber: '26145100',
        blockHash: '0x' + 'b'.repeat(64),
        blockTime: '2026-10-08T04:15:00.000Z',
        finalized: true,
      },
      readAtUtc: '2026-10-08T04:15:30.000Z',
      captureReceiptSha256: 'c'.repeat(64),
      addresses: clone(history.addresses),
      runtimeIdentities: clone(history.runtimeIdentities),
      assetDecimals: 18,
      activeSharesRaw: String(100n * UNIT),
      activeEntitlementRaw: String(100n * UNIT),
      activeEntitlementMethod: 'preview_redeem_full_active_position',
      maxWithdrawRaw: String(100n * UNIT),
      pendingAssetsRaw: String(50n * UNIT),
      storedCooldownEndUnix: String(Date.parse('2026-10-10T00:00:00.000Z') / 1000),
      cooldownDurationSeconds: '86400',
      vaultCashRaw: history.rows.at(-1)!.vaultUsdeRaw,
      siloCashRaw: String(40n * UNIT),
      evidence: { testOnlyApprovedCompleteEvidence: true },
    },
  }
}
function build(input = fixture()) {
  const approved = clone(input.current)
  return buildSusdeHolderTimeProcessV2(
    input,
    (current) => JSON.stringify(current) === JSON.stringify(approved),
  )
}
function initiate(input = fixture()) {
  input.current.successfulExactQInitiation = {
    requestedRaw: input.requestedRaw,
    owner: input.current.owner,
    source: clone(input.current.source),
    receiptSha256: 'd'.repeat(64),
  }
  return input
}
function floor(n: bigint, d: bigint) {
  return n / d - (n < 0n && n % d !== 0n ? 1n : 0n)
}

describe('sUSDe canonical six-capture paired history process', () => {
  it('retains six separate native authorities and original acquisition clocks', () => {
    const pin = susdePinnedJointHistoryEvidenceSet()
    expect(pin.rows.map((r) => r.index)).toEqual([
      ...Array.from({ length: 20 }, (_, i) => i),
      116,
      117,
      118,
      119,
    ])
    expect(pin.sources).toHaveLength(6)
    expect('captureFileSha256' in pin).toBe(false)
    expect(pin.availableAtUtc).toBe('2026-10-08T04:14:22.470Z')
    expect(pin.rows[0].availableAt).toBe('2026-10-08T03:39:54.362Z')
    expect(pin.rows[20].availableAt).toBe('2026-10-08T00:10:33.139Z')
    expect(
      pin.rows.every((row) => {
        const source = pin.sources.find((s) => s.id === row.provenance.inputId)!
        return (
          source.captureFileSha256 === row.provenance.originalCaptureFileSha256 &&
          source.nativePlanSha256 === row.provenance.originalNativePlanSha256 &&
          source.fileSha256 === row.provenance.originalFileSha256 &&
          source.indices[row.provenance.withinCaptureIndex] === row.index &&
          row.availableAt === source.availableAt &&
          row.acquisitionByOrigin.every(
            (a) => Date.parse(a.completedAt) <= Date.parse(row.availableAt),
          )
        )
      }),
    ).toBe(true)
    expect(Object.isFrozen(SUSDE_JOINT_HISTORY_EVIDENCE_SET_PIN.rows[0].provenance)).toBe(true)
    pin.rows[0].provenance.originalCaptureFileSha256 = '0'.repeat(64)
    expect(susdePinnedJointHistoryEvidenceSet().rows[0].provenance).not.toEqual(
      pin.rows[0].provenance,
    )
  })
  it('derives exactly 22 correlated daily donors and excludes the only 97-day gap', () => {
    const f = fixture(),
      v = build(f)!
    expect(v).not.toBeNull()
    const process = v.active.funding
    expect(v.metadata.donorCount).toBe(process.scenarios.length)
    expect(v.metadata.sample).toBe('paired_joint_net_donors')
    expect(process.scenarios).toHaveLength(22)
    expect(process.excludedIntervals).toEqual([{ fromIndex: 19, reason: 'historical_gap' }])
    expect(f.history.gaps).toMatchObject([{ fromIndex: 19, toIndex: 116, elapsedSeconds: 8380800 }])
    const eligiblePairs = f.history.rows.slice(1).flatMap((r, i) => {
      const p = f.history.rows[i]
      return r.index === p.index + 1 ? [[p, r]] : []
    })
    for (const [i, scenario] of process.scenarios.entries()) {
      const [a, b] = eligiblePairs[i]
      expect(scenario.donor.durationSeconds).toBe(86400)
      expect(scenario.donor.provenanceRefs).toEqual(
        [a, b].map((r) => r.provenance.originalCaptureFileSha256 + ':' + r.index),
      )
      expect(scenario.donor.availableAtUtc).toEqual([a.availableAt, b.availableAt])
      expect(scenario.donor.jointDeltaRaw).toEqual({
        vaultCashRaw: String(BigInt(b.vaultUsdeRaw) - BigInt(a.vaultUsdeRaw)),
        siloCashRaw: String(BigInt(b.siloUsdeRaw) - BigInt(a.siloUsdeRaw)),
      })
      const end = scenario.points.at(-1)!,
        elapsed = 86460000n
      for (const key of ['vaultCashRaw', 'siloCashRaw'] as const) {
        const extrapolated =
          BigInt(f.current[key]) +
          floor(BigInt(scenario.donor.jointDeltaRaw[key]) * elapsed, 86400000n)
        expect(end.valuesByChannel[key]).toBe(String(extrapolated < 0n ? 0n : extrapolated))
      }
    }
    // The 3→4 transition is paired across two native captures, not dropped or independently shuffled.
    expect(process.scenarios[3].donor.provenanceRefs[0].split(':')[0]).not.toBe(
      process.scenarios[3].donor.provenanceRefs[1].split(':')[0],
    )
    expect(v.pending.funding!.scenarios.map((s) => s.donor)).toEqual(
      process.scenarios.map((s) => s.donor),
    )
  })
  it('fails closed without full current approval, and neither builder accepts the other pin', () => {
    expect(buildSusdeHolderTimeProcessV2(fixture())).toBeNull()
    expect(buildSusdeHolderTimeProcessV2(fixture(), () => false)).toBeNull()
    const f = fixture(),
      approved = clone(f.current)
    f.current.evidence = { ...(f.current.evidence as object), selfSealed: true }
    expect(
      buildSusdeHolderTimeProcessV2(f, (c) => JSON.stringify(c) === JSON.stringify(approved)),
    ).toBeNull()
    expect(buildSusdeHolderTimeProcess(f as never, () => true)).toBeNull()
    const oldPin = fixture()
    oldPin.history = susdePinnedJointHistory() as never
    expect(build(oldPin)).toBeNull()
    f.current.evidence = null
    expect(build(f)).toBeNull()
  })
  it('rejects resealed history, provenance, runtime and acquisition-clock tampering', () => {
    const mutations: ((f: SusdeHolderTimeProcessV2Input) => void)[] = [
      (f) => {
        f.history.rows[0].vaultUsdeRaw = '1'
      },
      (f) => {
        f.history.rows[0].index = 1
      },
      (f) => {
        f.history.rows[0].sourceAt = f.history.rows[1].sourceAt
      },
      (f) => {
        f.history.rows[0].provenance.originalCaptureFileSha256 = '0'.repeat(64)
      },
      (f) => {
        f.history.rows[0].provenance.withinCaptureIndex = 1
      },
      (f) => {
        f.history.rows[0].availableAt = f.history.rows[0].sourceAt
      },
      (f) => {
        f.history.rows[0].acquisitionByOrigin[0].completedAt = f.history.rows[0].sourceAt
      },
      (f) => {
        f.history.sources[0].nativePlanSha256 = '0'.repeat(64)
      },
      (f) => {
        f.history.sources[0].startedAt = f.history.rows[0].sourceAt
      },
      (f) => {
        f.history.availableAtUtc = f.current.source.blockTime
      },
      (f) => {
        f.history.runtimeIdentities.vault = '0'.repeat(64)
      },
      (f) => {
        f.current.runtimeIdentities.silo = '0'.repeat(64)
      },
      (f) => {
        f.current.source.finalized = false as never
      },
    ]
    for (const mutate of mutations) {
      const f = fixture()
      mutate(f)
      expect(build(f)).toBeNull()
      // A caller-controlled replacement seal never qualifies a changed history.
      f.history.composition.bodySha256 = createHash('sha256')
        .update(JSON.stringify(f.history.rows))
        .digest('hex')
      expect(build(f)).toBeNull()
    }
  })
  it('denies issues before composition or acquisition and prevents selected-output clock movement', () => {
    for (const issue of ['2026-10-08T04:14:22.469Z', '2026-10-08T03:39:50.000Z']) {
      const f = fixture()
      f.issueAtUtc = issue
      f.current.source.blockTime = new Date(Date.parse(issue) - 60000).toISOString()
      f.current.readAtUtc = new Date(Date.parse(issue) - 30000).toISOString()
      expect(build(f)).toBeNull()
    }
    const f = fixture(),
      approved = clone(f.current),
      v = build(f)!
    const accept = (c: typeof f.current) => JSON.stringify(c) === JSON.stringify(approved)
    expect(selectedSusdeHolderTimeProcessV2(v, f, Date.parse(f.issueAtUtc), accept)).toEqual(v)
    expect(selectedSusdeHolderTimeProcessV2(v, f, Date.parse(f.issueAtUtc))).toBeNull()
    const moved = clone(v)
    moved.issueAtUtc = '2026-10-08T04:17:00.000Z'
    expect(selectedSusdeHolderTimeProcessV2(moved, f, Date.parse(f.issueAtUtc), accept)).toBeNull()
    expect(
      selectedSusdeHolderTimeProcessV2(
        v,
        f,
        Date.parse(f.current.source.blockTime) + 1800001,
        accept,
      ),
    ).toBeNull()
  })
  it('preserves full Ea, separate Q, whole M and exact queue eligibility without execution authority', () => {
    const f = fixture(),
      v = build(f)!
    expect(v.active.fullActiveEntitlementRaw).toBe(String(100n * UNIT))
    expect(v.originalRequestedRaw).toBe(String(10n * UNIT))
    expect(v.pending.effectiveWholePayoutRaw).toBe(String(50n * UNIT))
    expect(v.pending.funding!.scenarios[0].points[0].capacityRaw).toBe('0')
    expect(v.pending.funding!.requestedRaw).toBe(String(50n * UNIT))
    expect(v.pending.eligibleAtTarget).toBe(false)
    expect([
      v.forecastValidated,
      v.prospectiveValidated,
      v.executable,
      v.fullHolderAbility,
      v.metadata.calibratedProbability,
      v.metadata.maxWithdrawProvesCallability,
    ]).toEqual(Array(6).fill(false))
    expect(v.metadata.maxGrossFlowRaw).toBeNull()
    const initiated = build(initiate())!.newCooldown!
    expect(initiated.effectiveWholePayoutRaw).toBe(String(60n * UNIT))
    expect(initiated.postInitiation.pendingAssetsRaw).toBe(String(60n * UNIT))
    expect(initiated.eligibleAtUtc).toBe('2026-10-09T04:15:00.000Z')
    expect(initiated.postInitiation.activeEntitlementRaw).toBeNull()
    f.current.maxWithdrawRaw = '0'
    expect(build(f)).toBeNull()
    const direct = fixture()
    direct.current.cooldownDurationSeconds = '0'
    expect(build(direct)!.pending.eligibleAtUtc).toBe(direct.current.source.blockTime)
    expect(build(direct)!.active.stage).toBe('direct_withdrawal_funding')
    const invalid = initiate()
    invalid.current.successfulExactQInitiation!.source.blockHash = '0x' + 'f'.repeat(64)
    expect(build(invalid)).toBeNull()
  })
})
