import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { susdePinnedJointHistory, SUSDE_JOINT_HISTORY_PIN } from '@/lib/carry/susdeJointHistoryPins'
import {
  buildSusdeHolderTimeProcess,
  selectedSusdeHolderTimeProcess,
  type SusdeHolderTimeProcessInput,
} from '@/lib/carry/susdeHolderTimeProcess'
const UNIT = 10n ** 18n
const MAX = (1n << 256n) - 1n
const clone = <T>(v: T) => structuredClone(v)
function fixture() {
  const pin = susdePinnedJointHistory()
  const input: SusdeHolderTimeProcessInput = {
    history: pin,
    requestedRaw: String(10n * UNIT),
    issueAtUtc: '2026-10-08T00:11:00.000Z',
    horizonHours: 24,
    analysisMode: 'issue_time_conditional',
    current: {
      owner: '0x' + 'a'.repeat(40),
      source: {
        chainId: 1,
        blockNumber: '26144000',
        blockHash: '0x' + 'b'.repeat(64),
        blockTime: '2026-10-08T00:10:00.000Z',
        finalized: true,
      },
      readAtUtc: '2026-10-08T00:10:45.000Z',
      captureReceiptSha256: 'c'.repeat(64),
      addresses: clone(pin.addresses),
      runtimeIdentities: clone(pin.runtimeIdentities),
      assetDecimals: 18,
      activeSharesRaw: String(100n * UNIT),
      activeEntitlementRaw: String(100n * UNIT),
      activeEntitlementMethod: 'preview_redeem_full_active_position',
      maxWithdrawRaw: String(100n * UNIT),
      pendingAssetsRaw: String(50n * UNIT),
      storedCooldownEndUnix: String(Date.parse('2026-10-10T00:00:00.000Z') / 1000),
      cooldownDurationSeconds: '86400',
      vaultCashRaw: pin.rows[3].vaultUsdeRaw,
      siloCashRaw: String(40n * UNIT),
      evidence: { testOnlyApprovedCompleteEvidence: true },
    },
  }
  return input
}
function build(input = fixture()) {
  const approved = clone(input.current)
  return buildSusdeHolderTimeProcess(
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
describe('sUSDe independently qualified joint HOLDER funding process', () => {
  it('pins the actual file bytes, body, detached capture and paired observations offline', () => {
    const pin = susdePinnedJointHistory(),
      bytes = readFileSync(pin.file),
      actual = JSON.parse(bytes.toString())
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.fileSha256)
    expect(actual.bodySha256).toBe(pin.bodySha256)
    const { bodySha256: _seal, ...body } = actual
    expect(createHash('sha256').update(JSON.stringify(body)).digest('hex')).toBe(pin.bodySha256)
    expect(
      createHash('sha256')
        .update(JSON.stringify(actual.capture) + '\n')
        .digest('hex'),
    ).toBe(pin.captureFileSha256)
    expect(actual.captureFileSha256).toBe(pin.captureFileSha256)
    expect(actual.capture.availableAt).toBe(pin.availableAtUtc)
    expect(
      actual.observation.rows.map((r: Record<string, unknown>) =>
        Object.fromEntries(Object.keys(pin.rows[0]).map((k) => [k, r[k]])),
      ),
    ).toEqual(pin.rows)
    expect(pin.rows.map((r) => r.index)).toEqual([116, 117, 118, 119])
    expect(Object.isFrozen(SUSDE_JOINT_HISTORY_PIN.rows[0])).toBe(true)
    pin.rows[0].vaultUsdeRaw = '0'
    expect(susdePinnedJointHistory().rows[0].vaultUsdeRaw).not.toBe('0')
  })
  it('fails closed without approval; metadata flags do not authenticate receipts', () => {
    expect(buildSusdeHolderTimeProcess(fixture())).toBeNull()
    expect(buildSusdeHolderTimeProcess(fixture(), () => false)).toBeNull()
    const f = fixture()
    f.current.evidence = null
    expect(build(f)).toBeNull()
  })
  it('keeps Ea independent of Q and M, and active funding is not final cooldown payout', () => {
    const v = build()!
    expect(v.active.fullActiveEntitlementRaw).toBe(String(100n * UNIT))
    expect(v.originalRequestedRaw).toBe(String(10n * UNIT))
    expect(v.pending.effectiveWholePayoutRaw).toBe(String(50n * UNIT))
    expect(v.active.funding.scenarios[0].points[0].capacityRaw).toBe(String(100n * UNIT))
    expect(v.active.stage).toBe('cooldown_initiation_funding')
    expect(v.active.instantaneousFinalAssetExitAssessed).toBe(false)
    expect(v.executable).toBe(false)
    expect(v.fullHolderAbility).toBe(false)
  })
  it('uses WHOLE M, never min(M,silo) or original Q, as the pending funding target', () => {
    const v = build()!,
      points = v.pending.funding!.scenarios[0].points
    expect(points[0].capacityRaw).toBe('0')
    expect(points[0].headroomRaw).toBe(String(-50n * UNIT))
    expect(points.at(-1)!.capacityRaw).toBe(String(50n * UNIT))
    expect(v.pending.funding!.requestedRaw).toBe(String(50n * UNIT))
    expect(v.pending.eligibleAtTarget).toBe(false)
    expect(v.pending.funding!.scenarios[0].sampledShortfalls.length).toBeGreaterThan(0)
  })
  it('marks an empty pending queue explicitly inapplicable, never paid', () => {
    const f = fixture()
    f.current.pendingAssetsRaw = '0'
    f.current.cooldownDurationSeconds = '0'
    const v = build(f)!
    expect(v.pending.status).toBe('not_applicable_no_pending_assets')
    expect(v.pending.applicable).toBe(false)
    expect(v.pending.funding).toBeNull()
    expect(v.pending.eligibleAtIssue).toBe(false)
  })
  it('rejects getter mismatch without interpreting it as restriction callability', () => {
    const f = fixture()
    f.current.maxWithdrawRaw = '0'
    expect(build(f)).toBeNull()
    const g = fixture()
    g.history.rows[0].siloUsdeRaw = '1'
    expect(build(g)).toBeNull()
  })
  it('zero active shares can retain an existing pending payout', () => {
    const f = fixture()
    f.current.activeSharesRaw = f.current.activeEntitlementRaw = f.current.maxWithdrawRaw = '0'
    const v = build(f)!
    expect(v.active.funding.scenarios[0].points[0].capacityRaw).toBe('0')
    expect(v.pending.effectiveWholePayoutRaw).toBe(String(50n * UNIT))
    f.current.activeEntitlementRaw = f.current.maxWithdrawRaw = '1'
    expect(build(f)).toBeNull()
  })
  it('nonzero duration changes preserve stored queue end; zero unlocks existing queue', () => {
    const f = fixture()
    f.current.cooldownDurationSeconds = '3600'
    expect(build(f)!.pending.eligibleAtUtc).toBe('2026-10-10T00:00:00.000Z')
    f.current.cooldownDurationSeconds = '0'
    const v = build(f)!
    expect(v.pending.eligibleAtUtc).toBe(f.current.source.blockTime)
    expect(v.pending.eligibleAtIssue).toBe(true)
    expect(v.active.stage).toBe('direct_withdrawal_funding')
  })
  it('has exactly three paired donors with true daily duration and source age once', () => {
    const f = fixture(),
      v = build(f)!,
      path = v.active.funding.scenarios[0]
    expect(v.active.funding.scenarios).toHaveLength(3)
    expect(path.donor.durationSeconds).toBe(86400)
    expect(v.targetAtUtc).toBe('2026-10-09T00:11:00.000Z')
    const first = f.history.rows[0],
      second = f.history.rows[1]
    const elapsed = 86460n * 1000n
    const target = path.points.at(-1)!
    expect(target.valuesByChannel.vaultCashRaw).toBe(
      String(
        BigInt(f.current.vaultCashRaw) +
          floor((BigInt(second.vaultUsdeRaw) - BigInt(first.vaultUsdeRaw)) * elapsed, 86400000n),
      ),
    )
    expect(target.valuesByChannel.siloCashRaw).toBe(
      String(
        BigInt(f.current.siloCashRaw) +
          floor((BigInt(second.siloUsdeRaw) - BigInt(first.siloUsdeRaw)) * elapsed, 86400000n),
      ),
    )
    expect(v.active.funding.scenarios[1].points.at(-1)!.clampedChannels).toContain('siloCashRaw')
    expect(v.metadata.maxGrossFlowRaw).toBeNull()
  })
  it('does not sum silo into active funding or subtract competing outflow again', () => {
    const f = fixture()
    f.current.vaultCashRaw = '1'
    f.current.siloCashRaw = String(1000n * UNIT)
    const v = build(f)!
    expect(v.active.funding.scenarios[0].points[0].capacityRaw).toBe('1')
    expect(v.active.funding.scenarios[0].points.at(-1)!.capacityRaw).toBe('0')
  })
  it('synthetic checked Q moves each stock exactly once and resets ENTIRE end even earlier', () => {
    const f = initiate(),
      v = build(f)!,
      n = v.newCooldown!
    expect(n.postInitiation).toEqual({
      vaultCashRaw: String(BigInt(f.current.vaultCashRaw) - 10n * UNIT),
      siloCashRaw: String(50n * UNIT),
      activeEntitlementRaw: null,
      activeEntitlementUpperBoundRaw: String(90n * UNIT),
      activeEntitlementQualification: 'arithmetic_upper_bound_not_post_burn_measurement',
      pendingAssetsRaw: String(60n * UNIT),
      storedCooldownEndUtc: '2026-10-09T00:10:00.000Z',
    })
    expect(n.eligibleAtUtc).toBe('2026-10-09T00:10:00.000Z')
    expect(n.funding.scenarios[0].points[0].headroomRaw).toBe(String(-60n * UNIT))
    expect(n.funding.scenarios[0].points.at(-1)!.capacityRaw).toBe(String(60n * UNIT))
    expect(n.eligibleAtTarget).toBe(true)
    expect(n.funding.scenarios[0].points.at(-1)!.valuesByChannel.siloCashRaw).toBe(
      String(
        BigInt(v.active.funding.scenarios[0].points.at(-1)!.valuesByChannel.siloCashRaw) +
          10n * UNIT,
      ),
    )
  })
  it('ERC4626 rounded share burn makes residual Ea differ from the arithmetic upper bound', () => {
    // Independent source formula with virtual asset/share offsets and ceil previewWithdraw.
    const A = 10n * UNIT,
      T = 3n * UNIT,
      S = 2n * UNIT,
      Q = 1n
    const initialEa = (S * (A + 1n)) / (T + 1n)
    const burnedShares = (Q * (T + 1n) + A) / (A + 1n)
    const residualShares = S - burnedShares
    const postEa = (residualShares * (A - Q + 1n)) / (T - burnedShares + 1n)
    expect(residualShares).toBeGreaterThanOrEqual(UNIT)
    expect(postEa).not.toBe(initialEa - Q)
    expect(postEa <= initialEa - Q).toBe(true)
    const f = fixture()
    f.requestedRaw = String(Q)
    f.current.activeSharesRaw = String(S)
    f.current.activeEntitlementRaw = f.current.maxWithdrawRaw = String(initialEa)
    f.current.vaultCashRaw = String(A)
    const n = build(initiate(f))!.newCooldown!
    expect(n.postInitiation.activeEntitlementRaw).toBeNull()
    expect(n.postInitiation.activeEntitlementUpperBoundRaw).toBe(String(initialEa - Q))
    expect(n.postInitiation.activeEntitlementQualification).toBe(
      'arithmetic_upper_bound_not_post_burn_measurement',
    )
    expect(n.effectiveWholePayoutRaw).toBe(String(BigInt(f.current.pendingAssetsRaw) + Q))
  })
  it('new queue settlement does not depend on future vault cash', () => {
    const f = initiate()
    f.current.vaultCashRaw = f.requestedRaw
    const n = build(f)!.newCooldown!
    expect(n.funding.scenarios[0].points.at(-1)!.valuesByChannel.vaultCashRaw).toBe('0')
    expect(n.funding.scenarios[0].points.at(-1)!.capacityRaw).toBe(n.effectiveWholePayoutRaw)
  })
  it('requires successful source-bound exact Q initiation and Q within independent Ea', () => {
    expect(build()!.newCooldown).toBeNull()
    const f = initiate()
    f.current.successfulExactQInitiation!.requestedRaw = '1'
    expect(build(f)).toBeNull()
    f.current.successfulExactQInitiation!.requestedRaw = f.requestedRaw
    f.current.activeEntitlementRaw = f.current.maxWithdrawRaw = '1'
    expect(build(f)!.newCooldown).toBeNull()
    f.current.cooldownDurationSeconds = '0'
    expect(build(f)!.newCooldown).toBeNull()
  })
  it.each(['vault', 'asset', 'silo'] as const)('rejects changed %s runtime or identity', (key) => {
    const f = fixture()
    f.current.runtimeIdentities[key] = '0'.repeat(64)
    expect(build(f)).toBeNull()
    const g = fixture()
    g.current.addresses[key] = '0x' + '0'.repeat(40)
    expect(build(g)).toBeNull()
  })
  it('rejects old issuance acquisition, stale source and donor end at current source', () => {
    const f = fixture()
    f.issueAtUtc = f.current.readAtUtc = '2026-10-08T00:10:32.000Z'
    expect(build(f)).toBeNull()
    f.issueAtUtc = '2026-10-08T00:41:00.000Z'
    expect(build(f)).toBeNull()
    const g = fixture()
    g.current.source.blockTime = g.history.rows[3].sourceAt
    g.current.readAtUtc = g.issueAtUtc = g.current.source.blockTime
    expect(build(g)).toBeNull()
  })
  it('retrospective analysis requires explicit later analysis issue and remains unvalidated', () => {
    const f = fixture()
    f.analysisMode = 'retrospective_analysis'
    const v = build(f)!
    expect(v.analysisMode).toBe('retrospective_analysis')
    expect(v.prospectiveValidated).toBe(false)
    expect(v.forecastValidated).toBe(false)
  })
  it('rejects synthetic native overflow and preserves sampled arithmetic censoring', () => {
    const f = initiate()
    f.current.siloCashRaw = String(MAX)
    expect(build(f)).toBeNull()
    const g = fixture()
    g.current.siloCashRaw = String(MAX)
    const v = build(g)!
    expect(v.active.funding.scenarios[0].status).toBe('censored_path')
    expect(v.active.funding.targetSummary).toBeNull()
  })
  it('freezes results; private copies and exact rebuilding reject forgery/moved issue', () => {
    const f = fixture(),
      approved = clone(f.current),
      accept = (c: unknown) => JSON.stringify(c) === JSON.stringify(approved)
    const v = buildSusdeHolderTimeProcess(f, accept)!
    expect(Object.isFrozen(v.input.current)).toBe(true)
    const at = Date.parse(f.issueAtUtc) + 1000
    expect(selectedSusdeHolderTimeProcess(v, f, at, accept)!.targetAtUtc).toBe(v.targetAtUtc)
    const forged = clone(v)
    forged.pending.effectiveWholePayoutRaw = '1'
    expect(selectedSusdeHolderTimeProcess(forged, f, at, accept)).toBeNull()
    const moved = clone(f)
    moved.issueAtUtc = new Date(at).toISOString()
    expect(selectedSusdeHolderTimeProcess(v, moved, at, accept)).toBeNull()
    f.current.pendingAssetsRaw = '1'
    expect(v.input.current.pendingAssetsRaw).toBe(String(50n * UNIT))
    expect(buildSusdeHolderTimeProcess(f, accept)).toBeNull()
  })
})
