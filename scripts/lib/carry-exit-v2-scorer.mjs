// Deterministic control rows for the draft carry_exit_v2 ledger. This module
// cannot classify holder exits, provider errors, or missing outcomes. Measured
// rows require route-specific raw RPC replay and a stronger evidence schema.
import { exactUtcMicros } from './carry-exit-v2-block-auditor.mjs'

const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const UINT = /^(0|[1-9][0-9]*)$/
const HORIZONS = [1, 4, 24, 48, 168]
const PREDECESSOR = new Map([
  [1, 0],
  [4, 1],
  [24, 4],
  [48, 24],
  [168, 48],
])
const INELIGIBLE = new Set(['ineligible', 'inconclusive', 'unavailable'])
const ELIGIBLE = new Set(['success', 'covered_revert'])
const PRIOR_STATUSES = new Set([
  'success',
  'covered_revert',
  'holder_attrition',
  'inconclusive',
  'missing',
  'not_eligible',
  'episode_censored',
])
const EMPTY_MEASUREMENT = Object.freeze({
  targetBlock: null,
  targetHash: null,
  targetParentBlock: null,
  targetParentHash: null,
  parentHeaderHash: null,
  targetParentBlockAt: null,
  targetBlockAt: null,
  targetObservedAt: null,
  capturedAt: null,
  canonicalityEvidenceDoc: null,
  coverageKind: null,
  holderCoverageRaw: null,
  requiredCoverageRaw: null,
  actualConsumedRaw: null,
  simulationStatus: null,
  callEvidenceDoc: null,
  entitlementMethod: null,
  entitlementEvidenceDoc: null,
  inconclusiveReason: null,
  missingReason: null,
  missingReceiptId: null,
})

export class ExitV2ScorePreparationError extends Error {
  constructor(code) {
    super(code)
    this.name = 'ExitV2ScorePreparationError'
    this.code = code
  }
}

function fail(code) {
  throw new ExitV2ScorePreparationError(code)
}

function positiveInteger(value) {
  return UINT.test(String(value ?? '')) && BigInt(value) > 0n
}

function sameId(left, right) {
  return positiveInteger(left) && positiveInteger(right) && String(left) === String(right)
}

function validNullableSource(row) {
  const hasBlock = row.targetBlock != null
  if (hasBlock !== (row.targetHash != null) || hasBlock !== (row.targetBlockAt != null))
    return false
  const controlOrMissing = ['not_eligible', 'episode_censored', 'missing'].includes(row.status)
  if (controlOrMissing === hasBlock) return false
  return !hasBlock || (positiveInteger(row.targetBlock) && HASH.test(row.targetHash))
}

/**
 * Given frozen DB rows and the full ordered predecessor chain, prepare only
 * `not_eligible` or `episode_censored`. A required measurement returns its bound
 * predecessor/core fields but never a guessed status.
 */
export function prepareCarryExitV2Control({ batch, caseRow, plan, priorScores = [] }) {
  if (
    !sameId(caseRow?.batchId, batch?.id) ||
    !sameId(plan?.caseId, caseRow?.id) ||
    !positiveInteger(batch.baselineBlock) ||
    !positiveInteger(caseRow.assetsRaw) ||
    !ADDRESS.test(batch.destination ?? '') ||
    !ADDRESS.test(batch.asset ?? '') ||
    !ADDRESS.test(batch.holder ?? '') ||
    !HASH.test(batch.baselineHash ?? '') ||
    typeof batch.routeKey !== 'string' ||
    !batch.routeKey ||
    !(INELIGIBLE.has(caseRow.baselineStatus) || ELIGIBLE.has(caseRow.baselineStatus))
  )
    fail('invalid_frozen_subject')
  const horizon = Number(plan.horizonH)
  const index = HORIZONS.indexOf(horizon)
  if (
    index < 0 ||
    Number(plan.predecessorH) !== PREDECESSOR.get(horizon) ||
    plan.conditionalRecovery !== false ||
    exactUtcMicros(plan.targetAt) !==
      exactUtcMicros(batch.issuedAt) + BigInt(horizon) * 3_600_000_000n ||
    exactUtcMicros(plan.deadlineAt) !== exactUtcMicros(plan.targetAt) + 7_200_000_000n ||
    exactUtcMicros(batch.baselineBlockAt) > exactUtcMicros(batch.issuedAt)
  )
    fail('invalid_frozen_plan')
  if (!Array.isArray(priorScores) || priorScores.length !== index) fail('prior_scores_incomplete')
  for (let i = 0; i < index; i++) {
    const row = priorScores[i]
    if (
      !sameId(row?.caseId, caseRow.id) ||
      !positiveInteger(row.id) ||
      Number(row.horizonH) !== HORIZONS[i] ||
      !PRIOR_STATUSES.has(row.status) ||
      (INELIGIBLE.has(caseRow.baselineStatus) && row.status !== 'not_eligible') ||
      (ELIGIBLE.has(caseRow.baselineStatus) && row.status === 'not_eligible') ||
      (priorScores.slice(0, i).some((prior) => prior.status === 'holder_attrition') &&
        row.status !== 'episode_censored') ||
      (row.status === 'episode_censored' &&
        !priorScores.slice(0, i).some((prior) => prior.status === 'holder_attrition')) ||
      !validNullableSource(row)
    )
      fail('prior_scores_invalid')
  }
  const predecessor =
    index === 0
      ? {
          predecessorScoreId: null,
          predecessorStatus: caseRow.baselineStatus,
          predecessorBlock: String(batch.baselineBlock),
          predecessorHash: batch.baselineHash,
          predecessorBlockAt: batch.baselineBlockAt,
        }
      : {
          predecessorScoreId: String(priorScores[index - 1].id),
          predecessorStatus: priorScores[index - 1].status,
          predecessorBlock:
            priorScores[index - 1].targetBlock == null
              ? null
              : String(priorScores[index - 1].targetBlock),
          predecessorHash: priorScores[index - 1].targetHash ?? null,
          predecessorBlockAt: priorScores[index - 1].targetBlockAt ?? null,
        }
  const core = {
    caseId: String(caseRow.id),
    horizonH: horizon,
    targetAt: plan.targetAt,
    deadlineAt: plan.deadlineAt,
    predecessorH: Number(plan.predecessorH),
    ...predecessor,
  }
  let status = null
  if (priorScores.some((row) => row.status === 'holder_attrition')) status = 'episode_censored'
  else if (INELIGIBLE.has(caseRow.baselineStatus)) status = 'not_eligible'
  return status
    ? { kind: 'control', row: { ...core, status, ...EMPTY_MEASUREMENT } }
    : { kind: 'measurement_required', core }
}
