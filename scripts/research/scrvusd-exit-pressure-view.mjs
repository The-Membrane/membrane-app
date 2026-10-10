// Read-only, as-of research view. An observed headroom decline is not a
// prediction that a holder can withdraw at a later block.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import {
  OUT as HOLDER_OUT,
  readPlan,
  validateIssue,
  verify as verifyHolder,
} from './scrvusd-fixed-holder-exit.mjs'
import { OUT as SEED_OUT } from './scrvusd-index-holder-seed.mjs'
import {
  OUT as SELECTION_OUT,
  verify as verifySelection,
} from './scrvusd-holder-selection-link.mjs'
import { computeTrend, STUDY as TREND_STUDY } from './scrvusd-holder-exit-trend.mjs'
import { readEvaluation, SCHEMA as EVALUATION_SCHEMA } from './scrvusd-exit-duration-evaluation.mjs'
import { buildExitReadiness } from './scrvusd-exit-readiness.mjs'

export const SCHEMA = 'scrvusd-exit-pressure-view-v1'
const validUtc = (value) =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(value).toISOString() === value
const sameBlock = (row, current) =>
  row.anchorBlock?.number === current.block && row.anchorBlock?.hash === current.blockHash

export function computeTrendAt({ asOfUtc, plan, selection, issues, checkpoints }) {
  if (!validUtc(asOfUtc)) throw new Error('Invalid as-of UTC')
  if (selection.status !== 'verified') throw new Error('Holder selection certificate unavailable')
  const cutoff = Date.parse(asOfUtc)
  const base = {
    study: TREND_STUDY,
    holder: plan.holder,
    rawCrvUsd: plan.rawCrvUsd,
    planSha256: plan.sha256,
  }
  if (Date.parse(plan.createdUtc) > cutoff || Date.parse(selection.capturedUtc) > cutoff)
    return { ...base, status: 'unavailable', reason: 'selection_not_yet_available' }
  return computeTrend({
    plan,
    issues: issues.filter(
      (issue) =>
        Date.parse(issue.captureEndUtc) <= cutoff &&
        issue.checkpoint.block.timestamp * 1000 <= cutoff,
    ),
    checkpoints: checkpoints.filter(
      (row) =>
        Date.parse(row.checkpoint.captureEndUtc) <= cutoff &&
        row.checkpoint.block.timestamp * 1000 <= cutoff,
    ),
    now: new Date(asOfUtc),
  })
}

function readVerifiedTrendAt({ asOfUtc, options = {} }) {
  const {
    out = HOLDER_OUT,
    quoteOut = QUOTE_OUT,
    seedOut = SEED_OUT,
    selectionOut = SELECTION_OUT,
    identity = sourceIdentity(),
  } = options
  // Verify the full saved corpus against the actual read time before applying
  // the historical cutoff. A later valid row must not poison an earlier replay.
  const verifiedNow = new Date()
  const selection = verifySelection({
    out: selectionOut,
    sourceOptions: { planOut: out, seedOut, quoteOut, identity },
    nowMs: verifiedNow.getTime(),
  })
  if (selection.status !== 'verified') throw new Error('Holder selection certificate unavailable')
  const audited = verifyHolder({ out, quoteOut, identity, now: () => verifiedNow })
  const plan = readPlan({ out, identity })
  if (!plan) throw new Error('Holder plan unavailable')
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  const dir = join(out, 'issues')
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  if (files.length !== audited.count) throw new Error('Holder ledger changed during pressure read')
  const issues = files.map((file) => {
    const bytes = readFileSync(join(dir, file), 'utf8')
    const issue = JSON.parse(bytes)
    validateIssue(issue, { plan, checkpoints, nowUtc: verifiedNow.toISOString() })
    if (
      bytes !== `${JSON.stringify(issue)}\n` ||
      file !==
        `${String(issue.checkpoint.block.number).padStart(12, '0')}-${issue.checkpoint.block.hash.slice(2)}.json`
    )
      throw new Error('Holder issue bytes or filename changed during pressure read')
    return issue
  })
  return computeTrendAt({ asOfUtc, plan, selection, issues, checkpoints })
}

function issueTimeFlow(evaluation, trend, asOfUtc) {
  if (!trend.current || !trend.holder || !trend.rawCrvUsd)
    return { status: 'unavailable', reason: 'no_comparable_current_probe' }
  const matching = evaluation.rows.filter(
    (row) =>
      sameBlock(row, trend.current) &&
      row.holder?.toLowerCase() === trend.holder.toLowerCase() &&
      row.qAssetsRaw === trend.rawCrvUsd &&
      row.route === 'direct_erc4626_withdraw_crvusd_from_scrvusd',
  )
  if (!matching.length) return { status: 'unavailable', reason: 'no_matching_prospective_issue' }
  if (
    !validUtc(trend.current.blockUtc) ||
    !validUtc(trend.current.captureEndUtc) ||
    matching.some(
      (row) =>
        !validUtc(row.issuedAtUtc) ||
        Date.parse(row.issuedAtUtc) < Date.parse(trend.current.blockUtc) ||
        Date.parse(row.issuedAtUtc) < Date.parse(trend.current.captureEndUtc) ||
        Date.parse(row.issuedAtUtc) > Date.parse(asOfUtc),
    )
  )
    return { status: 'unavailable', reason: 'issue_outside_verified_as_of_window' }
  const withFlow = matching.filter(
    (row) => row.historicalFlowStatus === 'as_of_context' && row.historicalFlowContext,
  )
  if (!withFlow.length) return { status: 'unavailable', reason: 'issue_has_no_flow_context' }
  const contexts = new Map(withFlow.map((row) => [JSON.stringify(row.historicalFlowContext), row]))
  if (contexts.size !== 1 || withFlow.length !== matching.length)
    return { status: 'unavailable', reason: 'inconsistent_issue_flow_context' }
  const row = withFlow[0]
  const flow = row.historicalFlowContext
  if (
    !validUtc(flow.evidenceCutoffUtc) ||
    Date.parse(flow.evidenceCutoffUtc) > Date.parse(row.issuedAtUtc)
  )
    return { status: 'unavailable', reason: 'issue_flow_cutoff_mismatch' }
  return {
    status: 'issue_time_context',
    issuedAtUtc: row.issuedAtUtc,
    evidenceCutoffUtc: flow.evidenceCutoffUtc,
    source: 'verified_prospective_issue_historical_suffix',
    completeToFirstLive: flow.completeToFirstLive === true,
    coverage: flow.coverage ?? null,
    maximumObservedCompleteWindowGrossWithdrawal: flow.maximumObservedCompleteWindow ?? null,
    maximumObservedCompleteWindowSignedNetDepletion:
      flow.maximumObservedCompleteWindowNetDepletion ?? null,
    meaning: 'historical_vault_event_stress_context_only',
  }
}

// Pure composition for verified reader results. Production uses readExitPressureView.
export function buildExitPressureView({ asOfUtc, trend, evaluation }) {
  if (
    !validUtc(asOfUtc) ||
    trend?.study !== TREND_STUDY ||
    evaluation?.schema !== EVALUATION_SCHEMA ||
    evaluation.asOfUtc !== asOfUtc ||
    !Array.isArray(evaluation.rows)
  )
    throw new Error('Invalid exit pressure inputs')
  const readiness = buildExitReadiness(evaluation)
  const comparableShrink = trend.status === 'measured_pair' && trend.direction === 'shrinking'
  const alertCandidate = comparableShrink
    ? {
        status: 'observed_shrinking_candidate',
        basis: 'two_adjacent_comparable_fixed_holder_probes',
        previous: trend.previous,
        current: trend.current,
        signedHeadroomChangeAssetsRaw: trend.signedHeadroomChangeAssetsRaw,
        currentHeadroomAssetsRaw: trend.currentHeadroomAssetsRaw,
        userAlertReady: false,
      }
    : {
        status: 'unavailable',
        reason:
          trend.status === 'measured_pair'
            ? 'no_observed_shrink'
            : (trend.reason ?? 'no_comparable_measured_pair'),
        userAlertReady: false,
      }
  return {
    schema: SCHEMA,
    asOfUtc,
    holder: trend.holder ?? null,
    qAssetsRaw: trend.rawCrvUsd ?? null,
    trend,
    observedShrinkingAlertCandidate: alertCandidate,
    issueTimeFlow: issueTimeFlow(evaluation, trend, asOfUtc),
    prospectiveOutcomeReadiness: readiness,
    forecast: { probability: null, likelyDurationSeconds: null, status: 'unavailable' },
    caveat:
      'Headroom is sampled at two blocks. Gross and signed net flow maxima are separate historical windows; neither is current holder-executable capacity, future exit ability, or remaining duration.',
  }
}

export function readExitPressureView({
  asOfUtc = new Date().toISOString(),
  trendOptions = {},
  evaluationOptions = {},
} = {}) {
  if (!validUtc(asOfUtc) || Date.parse(asOfUtc) > Date.now())
    throw new Error('Invalid or future as-of UTC')
  const trend = readVerifiedTrendAt({ asOfUtc, options: trendOptions })
  const evaluation = readEvaluation({ ...evaluationOptions, asOfUtc })
  return buildExitPressureView({ asOfUtc, trend, evaluation })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [asOfUtc = new Date().toISOString(), ...extra] = process.argv.slice(2)
    if (extra.length) throw new Error('Usage: [asOfUtc]')
    console.log(JSON.stringify(readExitPressureView({ asOfUtc })))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
