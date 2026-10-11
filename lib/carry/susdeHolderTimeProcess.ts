import {
  buildConditionalTimeProcess,
  type ConditionalTimeProcessInput,
} from '../venueForecast/conditionalTimeProcess'
import {
  freezeSusde,
  susdePinnedJointHistory,
  type SusdeJointHistory,
} from './susdeJointHistoryPins'
import {
  susdePinnedJointHistoryEvidenceSet,
  type SusdeJointHistoryEvidenceSet,
} from './susdeJointHistoryEvidenceSet'

export type SusdeCurrentSource = {
  chainId: 1
  blockNumber: string
  blockHash: string
  blockTime: string
  finalized: true
}
export type SusdeHolderCurrentEvidence = {
  owner: string
  source: SusdeCurrentSource
  readAtUtc: string
  captureReceiptSha256: string
  addresses: SusdeJointHistory['addresses']
  runtimeIdentities: SusdeJointHistory['runtimeIdentities']
  assetDecimals: 18
  activeSharesRaw: string
  /** Independent full active entitlement; excludes already queued assets. */
  activeEntitlementRaw: string
  activeEntitlementMethod: 'preview_redeem_full_active_position'
  /** This getter reports Ea irrespective of cooldown/restriction gates. */
  maxWithdrawRaw: string
  pendingAssetsRaw: string
  storedCooldownEndUnix: string
  cooldownDurationSeconds: string
  vaultCashRaw: string
  siloCashRaw: string
  /** Complete externally approved receipts, including owner/source/runtime/getter evidence. */
  evidence: unknown
  successfulExactQInitiation?: {
    requestedRaw: string
    owner: string
    source: SusdeCurrentSource
    receiptSha256: string
  }
}
export type SusdeHolderTimeProcessInput = {
  history: SusdeJointHistory
  current: SusdeHolderCurrentEvidence
  requestedRaw: string
  issueAtUtc: string
  horizonHours: number
  analysisMode: 'issue_time_conditional' | 'retrospective_analysis'
}
export type SusdeHolderTimeProcessV2Input = Omit<SusdeHolderTimeProcessInput, 'history'> & {
  history: SusdeJointHistoryEvidenceSet
}
/** Authority lives outside the model: approve COMPLETE current evidence, never a self seal. */
export type AcceptSusdeCurrentEvidence = (current: SusdeHolderCurrentEvidence) => boolean
const MAX = (1n << 256n) - 1n
const raw = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const utc = (v: unknown): v is string =>
  typeof v === 'string' &&
  Number.isSafeInteger(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-f]{40}$/.test(v)
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
function exact(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => exact(v, b[i]))
    )
  if ((a !== null && typeof a === 'object') || (b !== null && typeof b === 'object')) {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
    const x = a as Record<string, unknown>,
      y = b as Record<string, unknown>
    return (
      Object.keys(x).length === Object.keys(y).length &&
      Object.keys(x).every((k) => Object.hasOwn(y, k) && exact(x[k], y[k]))
    )
  }
  return Object.is(a, b)
}
function checked(n: bigint) {
  if (n < 0n || n > MAX) throw Error('native_overflow')
  return n
}
function timestamp(seconds: bigint) {
  const ms = checked(seconds * 1000n)
  if (ms > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('timestamp_overflow')
  return new Date(Number(ms)).toISOString()
}
/** Three conditional FUNDING paths. Queue eligibility is a separate exact clock, never a sampled episode. */
export function buildSusdeHolderTimeProcess(
  supplied: SusdeHolderTimeProcessInput,
  acceptCurrentEvidence: AcceptSusdeCurrentEvidence = () => false,
) {
  return buildPinnedSusdeHolderTimeProcess(supplied, acceptCurrentEvidence, 'v1')
}
/** A separate canonical dispatch; neither version accepts caller-defined historical authority. */
export function buildSusdeHolderTimeProcessV2(
  supplied: SusdeHolderTimeProcessV2Input,
  acceptCurrentEvidence: AcceptSusdeCurrentEvidence = () => false,
) {
  return buildPinnedSusdeHolderTimeProcess(supplied, acceptCurrentEvidence, 'v2')
}
function buildPinnedSusdeHolderTimeProcess<
  I extends SusdeHolderTimeProcessInput | SusdeHolderTimeProcessV2Input,
>(supplied: I, acceptCurrentEvidence: AcceptSusdeCurrentEvidence, version: 'v1' | 'v2') {
  try {
    const input = structuredClone(supplied),
      pin = version === 'v1' ? susdePinnedJointHistory() : susdePinnedJointHistoryEvidenceSet(),
      c = input.current
    const source = Date.parse(c.source.blockTime),
      issue = Date.parse(input.issueAtUtc)
    if (
      !exact(input.history, pin) ||
      !utc(input.issueAtUtc) ||
      !utc(c.source.blockTime) ||
      !utc(c.readAtUtc) ||
      source % 1000 !== 0 ||
      !Number.isSafeInteger(issue) ||
      source > Date.parse(c.readAtUtc) ||
      Date.parse(c.readAtUtc) > issue ||
      issue - source > 1800000 ||
      issue < source ||
      Date.parse(pin.availableAtUtc) > issue ||
      pin.rows.some((r) => Date.parse(r.sourceAt) >= source) ||
      !['issue_time_conditional', 'retrospective_analysis'].includes(input.analysisMode) ||
      !Number.isFinite(input.horizonHours) ||
      input.horizonHours <= 0 ||
      input.horizonHours > 8760 ||
      !address(c.owner) ||
      c.source.chainId !== 1 ||
      c.source.finalized !== true ||
      !raw(c.source.blockNumber) ||
      c.source.blockNumber === '0' ||
      !/^0x[a-f0-9]{64}$/.test(c.source.blockHash) ||
      !sha(c.captureReceiptSha256) ||
      !exact(c.addresses, pin.addresses) ||
      !exact(c.runtimeIdentities, pin.runtimeIdentities) ||
      c.assetDecimals !== 18 ||
      c.activeEntitlementMethod !== 'preview_redeem_full_active_position' ||
      ![
        input.requestedRaw,
        c.activeSharesRaw,
        c.activeEntitlementRaw,
        c.maxWithdrawRaw,
        c.pendingAssetsRaw,
        c.storedCooldownEndUnix,
        c.cooldownDurationSeconds,
        c.vaultCashRaw,
        c.siloCashRaw,
      ].every(raw) ||
      c.maxWithdrawRaw !== c.activeEntitlementRaw ||
      (c.activeSharesRaw === '0' && c.activeEntitlementRaw !== '0') ||
      BigInt(c.cooldownDurationSeconds) > (1n << 24n) - 1n ||
      BigInt(c.pendingAssetsRaw) > (1n << 152n) - 1n ||
      BigInt(c.storedCooldownEndUnix) > (1n << 104n) - 1n ||
      c.evidence === null ||
      c.evidence === undefined ||
      typeof acceptCurrentEvidence !== 'function' ||
      acceptCurrentEvidence(freezeSusde(structuredClone(c))) !== true
    )
      return null

    const Q = BigInt(input.requestedRaw),
      E = BigInt(c.activeEntitlementRaw),
      M = BigInt(c.pendingAssetsRaw)
    if (Q === 0n) return null
    const duration = BigInt(c.cooldownDurationSeconds)
    const eligibleAtUtc =
      duration === 0n ? c.source.blockTime : timestamp(BigInt(c.storedCooldownEndUnix))
    const channels = ['vaultCashRaw', 'siloCashRaw'].map((key) => ({
      key,
      assetAddress: pin.addresses.asset,
      decimals: 18,
      unit: 'usde_wad',
      negativeHandling: 'clamp_zero' as const,
    }))
    const regime = 'susde_pinned_vault_asset_silo_runtime_v1'
    const kernel = (
      vault: string,
      silo: string,
      requested: string,
      rule: string,
      measure: (state: Record<string, string>) => {
        availableRaw: string
        entitlementRaw: string | null
      },
    ) => {
      const k: ConditionalTimeProcessInput = {
        channels,
        outputAsset: { assetAddress: pin.addresses.asset, decimals: 18 },
        measurementRule: rule,
        observations: pin.rows.map((r) => ({
          sourceAtUtc: r.sourceAt,
          availableAtUtc: r.availableAt,
          regime,
          channels: structuredClone(channels),
          valuesByChannel: { vaultCashRaw: r.vaultUsdeRaw, siloCashRaw: r.siloUsdeRaw },
          provenanceRef:
            ('provenance' in r
              ? r.provenance.originalCaptureFileSha256
              : 'captureFileSha256' in pin
                ? pin.captureFileSha256
                : '') +
            ':' +
            r.index,
        })),
        current: {
          sourceAtUtc: c.source.blockTime,
          readAtUtc: c.readAtUtc,
          regime,
          valuesByChannel: { vaultCashRaw: vault, siloCashRaw: silo },
          provenanceRef: c.captureReceiptSha256,
        },
        issueAtUtc: input.issueAtUtc,
        requestedRaw: requested,
        horizonHours: input.horizonHours,
        maxHistoricalGapSeconds: 86400,
      }
      return buildConditionalTimeProcess(k, (candidate) => exact(candidate, k), measure)
    }
    const atomic = (whole: bigint) => (state: Record<string, string>) => ({
      availableRaw: BigInt(state.siloCashRaw) >= whole ? String(whole) : '0',
      entitlementRaw: String(whole),
    })
    const activeProcess = kernel(
      c.vaultCashRaw,
      c.siloCashRaw,
      String(Q),
      'active_funding_min_vault_full_Ea',
      (state) => ({ availableRaw: state.vaultCashRaw, entitlementRaw: String(E) }),
    )
    const pendingProcess =
      M > 0n
        ? kernel(
            c.vaultCashRaw,
            c.siloCashRaw,
            String(M),
            'whole_pending_atomic_silo_funding',
            atomic(M),
          )
        : null
    if (!activeProcess || (M > 0n && !pendingProcess)) return null
    // Protect the literal subset's topology and exact paired NET donor output, including cross-capture days.
    if (version === 'v2') {
      const history = pin as SusdeJointHistoryEvidenceSet
      const donors = history.rows.slice(1).flatMap((r, i) => {
        const p = history.rows[i]
        const elapsed = (Date.parse(r.sourceAt) - Date.parse(p.sourceAt)) / 1000
        if (r.index - p.index !== elapsed / 86400) throw Error('history_index_clock_mismatch')
        if (elapsed > 86400) return []
        if (elapsed !== 86400) throw Error('history_not_daily')
        return [
          {
            startAtUtc: p.sourceAt,
            endAtUtc: r.sourceAt,
            durationSeconds: elapsed,
            availableAtUtc: [p.availableAt, r.availableAt],
            provenanceRefs: [p, r].map(
              (row) => row.provenance.originalCaptureFileSha256 + ':' + row.index,
            ),
            jointDeltaRaw: {
              vaultCashRaw: String(BigInt(r.vaultUsdeRaw) - BigInt(p.vaultUsdeRaw)),
              siloCashRaw: String(BigInt(r.siloUsdeRaw) - BigInt(p.siloUsdeRaw)),
            },
          },
        ]
      })
      if (
        donors.length !== history.dailyDonorCount ||
        activeProcess.scenarios.length !== donors.length ||
        activeProcess.scenarios.some(
          (s, i) =>
            !exact(
              Object.fromEntries(
                Object.keys(donors[i]).map((key) => [key, s.donor[key as keyof typeof s.donor]]),
              ),
              donors[i],
            ),
        )
      )
        return null
    }
    let newCooldown = null
    const initiation = c.successfulExactQInitiation
    if (
      initiation &&
      duration > 0n &&
      Q <= E &&
      Q <= BigInt(c.vaultCashRaw) &&
      c.activeSharesRaw !== '0'
    ) {
      if (
        initiation.requestedRaw !== input.requestedRaw ||
        initiation.owner !== c.owner ||
        !exact(initiation.source, c.source) ||
        !sha(initiation.receiptSha256)
      )
        return null
      const whole = checked(M + Q),
        silo = checked(BigInt(c.siloCashRaw) + Q)
      if (whole > (1n << 152n) - 1n) return null
      const queueEnd = timestamp(checked(BigInt(source / 1000) + duration))
      const process = kernel(
        String(checked(BigInt(c.vaultCashRaw) - Q)),
        String(silo),
        String(whole),
        'new_exact_Q_cooldown_whole_queue_atomic_silo_funding',
        atomic(whole),
      )
      if (!process) return null
      newCooldown = {
        stage: 'synthetic_checked_block_cooldown_then_whole_unstake' as const,
        originalRequestedRaw: String(Q),
        effectiveWholePayoutRaw: String(whole),
        movementAppliedOnce: true as const,
        postInitiation: {
          vaultCashRaw: String(BigInt(c.vaultCashRaw) - Q),
          siloCashRaw: String(silo),
          activeEntitlementRaw: null,
          activeEntitlementUpperBoundRaw: String(E - Q),
          activeEntitlementQualification:
            'arithmetic_upper_bound_not_post_burn_measurement' as const,
          pendingAssetsRaw: String(whole),
          storedCooldownEndUtc: queueEnd,
        },
        eligibleAtUtc: queueEnd,
        eligibleAtIssue: issue >= Date.parse(queueEnd),
        eligibleAtTarget: Date.parse(process.targetAtUtc) >= Date.parse(queueEnd),
        funding: process,
      }
    }
    // Literal history/current held privately; callers cannot move the issue clock by selecting later.
    return freezeSusde({
      status: 'conditional_susde_holder_funding_time_process' as const,
      input,
      owner: c.owner,
      originalRequestedRaw: String(Q),
      issueAtUtc: input.issueAtUtc,
      targetAtUtc: activeProcess.targetAtUtc,
      sourceProofValidUntil: activeProcess.sourceProofValidUntil,
      analysisMode: input.analysisMode,
      active: {
        stage:
          duration > 0n
            ? ('cooldown_initiation_funding' as const)
            : ('direct_withdrawal_funding' as const),
        fullActiveEntitlementRaw: String(E),
        instantaneousFinalAssetExitAssessed: false as const,
        funding: activeProcess,
      },
      pending: {
        stage: 'existing_whole_pending_silo_funding' as const,
        status:
          M > 0n
            ? ('conditional_whole_pending_funding' as const)
            : ('not_applicable_no_pending_assets' as const),
        applicable: M > 0n,
        originalRequestedRaw: String(Q),
        effectiveWholePayoutRaw: String(M),
        eligibleAtUtc,
        eligibleAtIssue: M > 0n && issue >= Date.parse(eligibleAtUtc),
        eligibleAtTarget:
          M > 0n && Date.parse(activeProcess.targetAtUtc) >= Date.parse(eligibleAtUtc),
        funding: pendingProcess,
      },
      newCooldown,
      metadata: {
        donorCount: version === 'v1' ? 3 : activeProcess.scenarios.length,
        sample:
          version === 'v1'
            ? ('small_three_joint_net_donors' as const)
            : ('paired_joint_net_donors' as const),
        conditionalUnverified: true,
        pairedStocksPreserveCorrelation: true,
        sourceAgeIncludedOnce: true,
        sampledEpisodesAreFundingOnly: true,
        maxGrossFlowRaw: null,
        calibratedProbability: false,
        futureAdminRestrictionsGrossFlowHolderActions: 'unassessed' as const,
        maxWithdrawProvesCallability: false,
        pendingExcludedFromActiveEntitlement: true,
      },
      forecastValidated: false as const,
      prospectiveValidated: false as const,
      executable: false as const,
      fullHolderAbility: false as const,
    })
  } catch {
    return null
  }
}
export function selectedSusdeHolderTimeProcess(
  value: unknown,
  expected: SusdeHolderTimeProcessInput,
  asOfMs: number,
  acceptCurrentEvidence: AcceptSusdeCurrentEvidence = () => false,
) {
  try {
    const e = structuredClone(expected),
      v = structuredClone(value)
    if (
      !Number.isSafeInteger(asOfMs) ||
      asOfMs < Date.parse(e.issueAtUtc) ||
      asOfMs - Date.parse(e.current.source.blockTime) > 1800000
    )
      return null
    const rebuilt = buildSusdeHolderTimeProcess(e, acceptCurrentEvidence)
    return rebuilt && exact(v, rebuilt) && asOfMs < Date.parse(rebuilt.targetAtUtc) ? rebuilt : null
  } catch {
    return null
  }
}
export function selectedSusdeHolderTimeProcessV2(
  value: unknown,
  expected: SusdeHolderTimeProcessV2Input,
  asOfMs: number,
  acceptCurrentEvidence: AcceptSusdeCurrentEvidence = () => false,
) {
  try {
    const e = structuredClone(expected),
      v = structuredClone(value)
    if (
      !Number.isSafeInteger(asOfMs) ||
      asOfMs < Date.parse(e.issueAtUtc) ||
      asOfMs - Date.parse(e.current.source.blockTime) > 1800000
    )
      return null
    const rebuilt = buildSusdeHolderTimeProcessV2(e, acceptCurrentEvidence)
    return rebuilt && exact(v, rebuilt) && asOfMs < Date.parse(rebuilt.targetAtUtc) ? rebuilt : null
  } catch {
    return null
  }
}
