import type { Address } from 'viem'
import type { HolderExitAssessment } from './holderExitAssessment'
import { projectApyUsdNet, validApyUsdFeeCurve } from './apyUsdFeeOutlook'

export const MAX_CURRENT_MECHANICAL_SOURCE_AGE_MS = 30 * 60_000
const MAX_CURRENT_EXIT_BLOCK_AGE_MS = MAX_CURRENT_MECHANICAL_SOURCE_AGE_MS

export type HolderExitMechanicalRequest = {
  routeKey: string
  destinationAddress: Address
  owner: Address
  assetAddress: Address
  assetsRaw: string
  nowMs: number
  horizonSeconds: number
}
export type MechanicalEligibility =
  | 'conditional_by_target'
  | 'after_target'
  | 'window_expired_by_target'
  | 'restriction_release_unknown'
  | 'unattested'
export type HolderExitMechanicalProng = {
  id: string
  scope: 'requested_q' | 'independent_entitlement'
  assetAddress: Address | null
  amountRaw: string | null
  earliestAt: string | null
  windowEndInclusiveAt: string | null
  atTarget: MechanicalEligibility
  basis:
    | 'current_simulation'
    | 'checked_block_initiation'
    | 'existing_entitlement'
    | 'current_restriction'
    | 'unattested'
  feeRaw: string | null
  feeMinimumAt: string | null
  feeMinimumNetRaw: string | null
  conditionalOnNoNewInitiation: boolean
}
export type HolderExitMechanicalOutlook = {
  status: 'conditional' | 'abstain'
  mechanismFamily:
    | 'atomic'
    | 'cooldown_window'
    | 'cooldown_claim'
    | 'receipt_fee'
    | 'queue_conversion'
    | 'intermediate_conversion'
    | 'staged'
    | 'unregistered'
  reason: 'binding_invalid' | 'source_invalid' | 'source_stale' | 'unsupported' | null
  subject: Pick<
    HolderExitMechanicalRequest,
    'routeKey' | 'destinationAddress' | 'owner' | 'assetAddress' | 'assetsRaw'
  >
  source: HolderExitAssessment['source']
  targetAt: string | null
  sourceValidUntil: string | null
  conditionalOnUnchangedParameters: true
  currentFinalAssetAmountRaw: string | null
  prongs: HolderExitMechanicalProng[]
  requestedQ: {
    stageEarliestAt: string | null
    fullRouteEarliestAt: string | null
    windowEndInclusiveAt: string | null
    atTarget: MechanicalEligibility
    finalAssetAmountRaw: string | null
  }
  pendingReset: boolean
  /** Conditional mechanics have no probability or learned duration attached. */
  prospectiveValidated: false
}
/** Required mechanics cannot disappear when optional reader fields are absent.
 * Supplemental staged adapters additionally require an attested complete path.
 */
export const HOLDER_EXIT_REQUIRED_MECHANICAL_FIELDS = {
  direct: ['stages', 'finalPayout'],
  tracked: ['stages', 'finalPayout'],
  morpho: ['stages', 'finalPayout'],
  sgho: ['stages', 'finalPayout'],
  susds: ['stages', 'finalPayout'],
  usd3: ['stages', 'finalPayout'],
  umbrella_gho: ['condition', 'stages', 'finalPayout'],
  susde: ['cooldownCondition', 'stages', 'finalPayout'],
  apy: ['apyUsdCondition', 'stages', 'finalPayout'],
  staked_usdat: ['stakedUsdatCondition', 'stages', 'finalPayout'],
  pyusd_staking: ['pyusdStakingCondition', 'pyusdYieldQueueCondition', 'stages', 'finalPayout'],
  twyne_pt: ['twyneCondition', 'stages', 'finalPayout'],
  fluid_usdt: ['stages', 'finalPayout'],
  atomic: ['stages', 'finalPayout'],
  staged: ['stages', 'finalPayout'],
} as const

const UINT256 = (1n << 256n) - 1n
const address = /^0x[0-9a-fA-F]{40}$/
const same = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const validAddress = (value: unknown): value is Address =>
  typeof value === 'string' && address.test(value)
const raw = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= UINT256
const positive = (value: unknown) => raw(value) && BigInt(value) > 0n
const canonical = (ms: number): string | null => {
  if (!Number.isSafeInteger(ms)) return null
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const unix = (seconds: number | null) =>
  seconds !== null && Number.isSafeInteger(seconds) && seconds >= 0
    ? canonical(seconds * 1000)
    : null
const stamp = (value: unknown) => (typeof value === 'string' ? canonical(Date.parse(value)) : null)
function eligibility(
  earliest: string | null,
  end: string | null,
  target: number,
): MechanicalEligibility {
  if (earliest === null) return 'unattested'
  // Unix windows remain open throughout the last inclusive second.
  if (end !== null && target >= Date.parse(end) + 1000) return 'window_expired_by_target'
  return target < Date.parse(earliest) ? 'after_target' : 'conditional_by_target'
}

/** Pure, exact-subject projection of attested mechanics, conditional on unchanged state.
 * New initiation times refer to the checked block, never an invented later transaction.
 * Independent receipts/tickets and intermediate assets cannot satisfy the original Q.
 * The caller supplies a subject from the shared static resolver or verified server registry.
 */
export function projectResolvedHolderExitMechanicalOutlook(
  assessment: HolderExitAssessment,
  request: HolderExitMechanicalRequest,
  subject: { kind: string; payoutAsset: Address } | null,
): HolderExitMechanicalOutlook {
  const targetMs =
    typeof request.nowMs === 'number' && typeof request.horizonSeconds === 'number'
      ? request.nowMs + request.horizonSeconds * 1000
      : Number.NaN
  const result: HolderExitMechanicalOutlook = {
    status: 'abstain',
    reason: null,
    mechanismFamily:
      subject?.kind === 'atomic' || subject?.kind === 'staged' ? subject.kind : 'unregistered',
    subject: {
      routeKey: request.routeKey,
      destinationAddress: request.destinationAddress,
      owner: request.owner,
      assetAddress: request.assetAddress,
      assetsRaw: request.assetsRaw,
    },
    source: { ...assessment.source },
    targetAt: canonical(targetMs),
    sourceValidUntil: null,
    conditionalOnUnchangedParameters: true,
    currentFinalAssetAmountRaw: null,
    prongs: [],
    requestedQ: {
      stageEarliestAt: null,
      fullRouteEarliestAt: null,
      windowEndInclusiveAt: null,
      atTarget: 'unattested',
      finalAssetAmountRaw: null,
    },
    pendingReset: false,
    prospectiveValidated: false,
  }
  if (
    !subject ||
    typeof request.routeKey !== 'string' ||
    !validAddress(request.destinationAddress) ||
    !validAddress(request.owner) ||
    !validAddress(request.assetAddress) ||
    !validAddress(assessment.destinationAddress) ||
    !validAddress(assessment.owner) ||
    !validAddress(assessment.request.assetAddress) ||
    !validAddress(assessment.finalPayout.assetAddress) ||
    !['unassessed', 'simulated', 'mined_observed'].includes(assessment.finalPayout.status) ||
    !positive(assessment.request.assetsRaw) ||
    (assessment.finalPayout.amountRaw !== null && !raw(assessment.finalPayout.amountRaw)) ||
    assessment.stages.some(
      (stage) =>
        typeof stage.relatedToRequest !== 'boolean' ||
        !['simulated', 'reverted', 'unassessed'].includes(stage.status) ||
        (stage.amountRaw !== null && !raw(stage.amountRaw)) ||
        (stage.assetAddress !== null && !validAddress(stage.assetAddress)),
    ) ||
    !positive(request.assetsRaw) ||
    assessment.routeKey !== request.routeKey ||
    !same(assessment.destinationAddress, request.destinationAddress) ||
    !same(assessment.owner, request.owner) ||
    assessment.request.assetsRaw !== request.assetsRaw ||
    !same(assessment.request.assetAddress, request.assetAddress) ||
    !same(subject.payoutAsset, request.assetAddress) ||
    !same(assessment.finalPayout.assetAddress, request.assetAddress) ||
    !Number.isSafeInteger(request.nowMs) ||
    !Number.isSafeInteger(request.horizonSeconds) ||
    request.horizonSeconds <= 0 ||
    result.targetAt === null
  ) {
    result.reason = 'binding_invalid'
    return result
  }
  if (result.mechanismFamily === 'unregistered') {
    result.mechanismFamily =
      subject.kind === 'atomic' || subject.kind === 'staged'
        ? subject.kind
        : subject.kind === 'umbrella_gho'
          ? 'cooldown_window'
          : subject.kind === 'susde'
            ? 'cooldown_claim'
            : subject.kind === 'apy'
              ? 'receipt_fee'
              : subject.kind === 'staked_usdat'
                ? 'queue_conversion'
                : ['pyusd_staking', 'twyne_pt', 'fluid_usdt'].includes(subject.kind)
                  ? 'intermediate_conversion'
                  : subject.kind === 'tracked' &&
                      request.routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]'
                    ? 'staged'
                    : 'atomic'
  }
  const blockMs =
    typeof assessment.source.blockTime === 'string'
      ? Date.parse(assessment.source.blockTime)
      : Number.NaN
  if (
    !canonical(blockMs) ||
    assessment.source.chainId !== 1 ||
    typeof assessment.source.blockHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(assessment.source.blockHash) ||
    !Number.isSafeInteger(assessment.source.blockNumber) ||
    assessment.source.blockNumber < 0 ||
    !['single_provider', 'two_provider'].includes(assessment.source.originValidation) ||
    blockMs > request.nowMs
  ) {
    result.reason = 'source_invalid'
    return result
  }
  result.source.blockTime = canonical(blockMs)!
  result.sourceValidUntil = canonical(blockMs + MAX_CURRENT_EXIT_BLOCK_AGE_MS)
  if (request.nowMs - blockMs > MAX_CURRENT_EXIT_BLOCK_AGE_MS) {
    result.reason = 'source_stale'
    return result
  }
  if (assessment.status === 'unsupported') {
    result.reason = 'unsupported'
    return result
  }
  result.status = 'conditional'
  const add = (id: string, fields: Partial<HolderExitMechanicalProng>) => {
    const prong: HolderExitMechanicalProng = {
      id,
      scope: 'requested_q',
      assetAddress: null,
      amountRaw: null,
      earliestAt: null,
      windowEndInclusiveAt: null,
      atTarget: 'unattested',
      basis: 'unattested',
      feeRaw: null,
      feeMinimumAt: null,
      feeMinimumNetRaw: null,
      conditionalOnNoNewInitiation: false,
      ...fields,
    }
    prong.atTarget = ['restriction_release_unknown', 'window_expired_by_target'].includes(
      prong.atTarget,
    )
      ? prong.atTarget
      : eligibility(prong.earliestAt, prong.windowEndInclusiveAt, targetMs)
    result.prongs.push(prong)
    return prong
  }
  const checkedAt = canonical(blockMs)!
  for (const stage of assessment.stages) {
    add(stage.name, {
      scope: stage.relatedToRequest ? 'requested_q' : 'independent_entitlement',
      assetAddress: stage.assetAddress,
      amountRaw: raw(stage.amountRaw) ? stage.amountRaw : null,
      earliestAt: stage.status === 'simulated' ? checkedAt : null,
      basis: stage.status === 'simulated' ? 'current_simulation' : 'unattested',
    })
  }
  const condition = assessment.condition
  if (condition && subject.kind === 'umbrella_gho') {
    if (
      !Number.isSafeInteger(condition.currentCooldownSeconds) ||
      condition.currentCooldownSeconds < 0 ||
      !Number.isSafeInteger(condition.currentUnstakeWindowSeconds) ||
      condition.currentUnstakeWindowSeconds < 0
    ) {
      add('cooldown_parameters', { basis: 'unattested' })
    }
    const timed = condition.gate === 'waiting' || condition.gate === 'window_open'
    const start = unix(condition.cooldownEnd)
    const end = unix(condition.windowEndInclusive)
    add('cooldown_window', {
      assetAddress: request.assetAddress,
      earliestAt: start && end && Date.parse(end) >= Date.parse(start) ? start : null,
      windowEndInclusiveAt: end,
      atTarget:
        condition.gate === 'window_expired'
          ? 'window_expired_by_target'
          : timed
            ? 'unattested'
            : 'restriction_release_unknown',
      basis: timed ? 'existing_entitlement' : 'current_restriction',
    })
  }
  if (subject.kind === 'umbrella_gho' && !condition) {
    add('cooldown_window', { basis: 'unattested' })
  }
  const cooldown = assessment.cooldownCondition
  if (cooldown && subject.kind === 'susde') {
    result.pendingReset = cooldown.newRequestWouldResetPending === true
    if (
      !Number.isSafeInteger(cooldown.durationSeconds) ||
      cooldown.durationSeconds < 0 ||
      typeof cooldown.newRequestWouldResetPending !== 'boolean'
    ) {
      add('cooldown_parameters', { basis: 'unattested' })
    }
    if (cooldown.exitMode === 'direct_withdrawal') {
      add('direct_withdrawal_authority', {
        earliestAt:
          cooldown.durationSeconds === 0 && cooldown.directWithdrawalStatus === 'success'
            ? checkedAt
            : null,
        basis: 'existing_entitlement',
      })
    }
    add('exit_mode', {
      earliestAt: ['cooldown', 'direct_withdrawal'].includes(cooldown.exitMode) ? checkedAt : null,
      basis: 'existing_entitlement',
    })
    if (cooldown.exitMode === 'cooldown') {
      add('new_q_cooldown_claim', {
        assetAddress: request.assetAddress,
        earliestAt:
          cooldown.initiationStatus === 'success'
            ? stamp(cooldown.ifInitiatedAtCheckedBlockEarliestAt)
            : null,
        basis: 'checked_block_initiation',
      })
      add('existing_pending_claim', {
        scope: 'independent_entitlement',
        assetAddress: request.assetAddress,
        conditionalOnNoNewInitiation: cooldown.newRequestWouldResetPending,
        amountRaw: raw(cooldown.pendingAssetsRaw) ? cooldown.pendingAssetsRaw : null,
        earliestAt:
          positive(cooldown.pendingAssetsRaw) && cooldown.pendingClaimStatus !== 'evm_revert'
            ? stamp(cooldown.pendingClaimEarliestAt)
            : null,
        basis: 'existing_entitlement',
      })
    }
  }
  if (subject.kind === 'susde' && !cooldown) {
    add('cooldown_mode_and_claim', { basis: 'unattested' })
  }
  const apy = assessment.apyUsdCondition
  if (apy && subject.kind === 'apy') {
    if (
      apy.currentMinimumClaimDelaySeconds === null ||
      !Number.isSafeInteger(apy.currentMinimumClaimDelaySeconds) ||
      apy.currentMinimumClaimDelaySeconds < 0
    ) {
      add('receipt_fee_parameters', { basis: 'unattested' })
    }
    const initiation = assessment.stages.some(
      (stage) =>
        stage.name === 'receipt_initiation' &&
        stage.relatedToRequest &&
        stage.status === 'simulated',
    )
    const rawEarliest = unix(apy.ifInitiatedAtCheckedBlockClaimableAt)
    const earliest = rawEarliest && Date.parse(rawEarliest) >= blockMs ? rawEarliest : null
    const rawMinimumAt = unix(apy.ifInitiatedAtCheckedBlockMinimumFeeAt)
    const minimumAt =
      rawMinimumAt && earliest && Date.parse(rawMinimumAt) >= Date.parse(earliest)
        ? rawMinimumAt
        : null
    const earliestNet = raw(apy.ifInitiatedAtCheckedBlockEarliestNetRaw)
      ? apy.ifInitiatedAtCheckedBlockEarliestNetRaw
      : null
    const minimumNet =
      raw(apy.ifInitiatedAtCheckedBlockMinimumFeeNetRaw) &&
      BigInt(apy.ifInitiatedAtCheckedBlockMinimumFeeNetRaw) <= BigInt(request.assetsRaw)
        ? apy.ifInitiatedAtCheckedBlockMinimumFeeNetRaw
        : null
    // Preserve native endpoints and the original horizon when the current curve is unattested.
    const originalTarget = blockMs + assessment.request.horizonHours * 3600_000
    const legacyNet =
      earliest && targetMs === Date.parse(earliest)
        ? earliestNet
        : minimumAt && targetMs >= Date.parse(minimumAt)
          ? minimumNet
          : targetMs === originalTarget && raw(apy.ifInitiatedAtCheckedBlockHorizonNetRaw)
            ? apy.ifInitiatedAtCheckedBlockHorizonNetRaw
            : null
    const curve = apy.currentFeeCurve
    const coherentCurve =
      curve !== null &&
      curve !== undefined &&
      validApyUsdFeeCurve(curve) &&
      Number.isSafeInteger(blockMs / 1000) &&
      apy.currentMinimumClaimDelaySeconds === curve.minDurationSeconds &&
      earliest !== null &&
      Date.parse(earliest) === blockMs + curve.minDurationSeconds * 1000 &&
      minimumAt !== null &&
      Date.parse(minimumAt) === blockMs + curve.maxDurationSeconds * 1000
    // block.timestamp resolves whole seconds; keep the original source and target clocks.
    const projected =
      coherentCurve && initiation && targetMs >= Date.parse(earliest!)
        ? projectApyUsdNet(request.assetsRaw, Math.floor(targetMs / 1000) - blockMs / 1000, curve!)
        : null
    const net = coherentCurve ? (projected?.netRaw ?? null) : legacyNet
    const validNet =
      earliest &&
      targetMs >= Date.parse(earliest) &&
      net !== null &&
      BigInt(net) <= BigInt(request.assetsRaw)
        ? net
        : null
    add('new_q_receipt_claim', {
      assetAddress: request.assetAddress,
      earliestAt: initiation ? earliest : null,
      basis: 'checked_block_initiation',
      amountRaw: initiation ? validNet : null,
      feeRaw:
        initiation && validNet !== null
          ? (BigInt(request.assetsRaw) - BigInt(validNet)).toString()
          : null,
      feeMinimumAt: minimumAt,
      feeMinimumNetRaw: minimumNet,
    })
  }
  if (subject.kind === 'apy' && !apy) {
    add('new_q_receipt_claim', { basis: 'unattested' })
  }
  if (assessment.stakedUsdatCondition && subject.kind === 'staked_usdat') {
    const ticket = assessment.stakedUsdatCondition
    add('existing_ticket_eligibility', {
      scope: 'independent_entitlement',
      earliestAt:
        ticket.existingTicketOwnership === 'holder' &&
        ticket.existingTicketClaimStatus === 'success'
          ? checkedAt
          : null,
      basis: 'existing_entitlement',
    })
    // No queue delay or fee schedule exists in the finalized assessment.

    add('ticket_conversion_execution', { scope: 'independent_entitlement', basis: 'unattested' })
  }
  if (subject.kind === 'staked_usdat') add('new_q_queue_completion', { basis: 'unattested' })
  if (
    subject.kind === 'pyusd_staking' &&
    (assessment.pyusdStakingCondition?.stakingPaused ||
      assessment.pyusdStakingCondition?.holderFrozen)
  ) {
    add('staking_restriction', {
      atTarget: 'restriction_release_unknown',
      basis: 'current_restriction',
    })
  }
  if (subject.kind === 'twyne_pt' && assessment.twyneCondition?.status === 'restricted') {
    add('collateral_restriction', {
      atTarget: 'restriction_release_unknown',
      basis: 'current_restriction',
    })
  }
  if (assessment.pyusdYieldQueueCondition && subject.kind === 'pyusd_staking') {
    add('yield_queue_completion', {
      atTarget: 'restriction_release_unknown',
      basis: 'current_restriction',
    })
  }
  if (
    subject.kind === 'pyusd_staking' &&
    (!assessment.pyusdStakingCondition ||
      assessment.pyusdStakingCondition.reason !== 'prime_to_wylds_callable' ||
      !positive(assessment.pyusdStakingCondition.requestedPrimeSharesRaw) ||
      !positive(assessment.pyusdStakingCondition.simulatedWyldsRaw))
  ) {
    add('staking_authority', { basis: 'unattested' })
  }
  if (
    subject.kind === 'twyne_pt' &&
    (!assessment.twyneCondition ||
      assessment.twyneCondition.status !== 'observed' ||
      !validAddress(assessment.twyneCondition.collateralVault) ||
      !positive(assessment.twyneCondition.requestedPtRaw) ||
      !positive(assessment.twyneCondition.simulatedReturnedPtRaw))
  ) {
    add('collateral_authority_and_pt_return', { basis: 'unattested' })
  }
  if (subject.kind === 'pyusd_staking' && !assessment.pyusdYieldQueueCondition) {
    add('yield_queue_completion', { basis: 'unattested' })
  }
  if (subject.kind === 'staged') add('supplemental_required_path', { basis: 'unattested' })
  const final = assessment.finalPayout
  const finalExact =
    (final.status === 'simulated' || final.status === 'mined_observed') &&
    raw(final.amountRaw) &&
    BigInt(final.amountRaw) >= BigInt(request.assetsRaw)
  add('final_asset_delivery', {
    assetAddress: request.assetAddress,
    earliestAt: finalExact ? checkedAt : null,
    basis: finalExact ? 'current_simulation' : 'unattested',
  })
  const required = result.prongs.filter((prong) => prong.scope === 'requested_q')
  const known = required.flatMap((prong) =>
    prong.earliestAt === null ? [] : [Date.parse(prong.earliestAt)],
  )
  const windows = required.flatMap((prong) =>
    prong.windowEndInclusiveAt === null ? [] : [Date.parse(prong.windowEndInclusiveAt)],
  )
  result.requestedQ.stageEarliestAt = known.length ? canonical(Math.max(...known)) : null
  result.requestedQ.windowEndInclusiveAt = windows.length ? canonical(Math.min(...windows)) : null
  if ((final.status === 'simulated' || final.status === 'mined_observed') && raw(final.amountRaw)) {
    result.currentFinalAssetAmountRaw = final.amountRaw
  }
  const complete =
    (final.status === 'simulated' || final.status === 'mined_observed') &&
    raw(final.amountRaw) &&
    BigInt(final.amountRaw) >= BigInt(request.assetsRaw) &&
    required.length > 0 &&
    required.every(
      (prong) => prong.earliestAt !== null && prong.atTarget !== 'restriction_release_unknown',
    )
  if (complete) {
    result.requestedQ.fullRouteEarliestAt = result.requestedQ.stageEarliestAt
    result.requestedQ.atTarget = eligibility(
      result.requestedQ.fullRouteEarliestAt,
      result.requestedQ.windowEndInclusiveAt,
      targetMs,
    )
  } else if (required.some((prong) => prong.atTarget === 'restriction_release_unknown')) {
    result.requestedQ.atTarget = 'restriction_release_unknown'
  } else if (required.some((prong) => prong.atTarget === 'window_expired_by_target')) {
    result.requestedQ.atTarget = 'window_expired_by_target'
  } else if (required.some((prong) => prong.atTarget === 'after_target')) {
    result.requestedQ.atTarget = 'after_target'
  }
  return result
}
