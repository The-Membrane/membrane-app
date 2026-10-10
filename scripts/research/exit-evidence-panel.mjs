// Offline, source-time-bounded evidence table. No probability, runway, or alert.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { joinIssue } from './scrvusd-cohort-flow-outcome-study.mjs'
import { OUT as DURATION_OUT, verify as verifyDuration } from './scrvusd-cohort-duration.mjs'
import {
  OUT as CONTEXT_OUT,
  readSealed as readContext,
  verify as verifyContext,
} from './scrvusd-cohort-flow-context.mjs'
import { sourceIdentity } from './curve-vault-flow-ledger.mjs'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const validUtc = (value) =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(value).toISOString() === value
const observedBy = (value, cutoff) => validUtc(value) && Date.parse(value) <= cutoff
const nameFor = (block) => `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`

function readSealed(path) {
  const bytes = readFileSync(path)
  const saved = JSON.parse(bytes)
  const { sha256, ...unsigned } = saved
  if (
    !bytes.equals(Buffer.from(`${JSON.stringify(saved)}\n`)) ||
    sha256 !== sha(JSON.stringify(unsigned))
  )
    throw new Error('Exit panel source physical or logical seal mismatch')
  return { saved, physicalSha256: sha(bytes) }
}

function ref(filename, source) {
  return { filename, logicalSha256: source.saved.sha256, physicalSha256: source.physicalSha256 }
}

export function horizonClass(member, horizonSeconds) {
  if (!member.cleanSuccessAtAnchor) return 'unexposed_at_issue'
  const samples = member.sampledSuccessSeconds
  if (samples.includes(horizonSeconds)) return 'sampled_success_at_horizon'
  const observed = member.observed
  if (!observed) return 'pending_followup'
  const last = samples.at(-1)
  if (observed.status === 'first_loss_observed') {
    if (horizonSeconds >= observed.firstLoss.upperSeconds) return 'first_revert_observed_by_horizon'
    if (horizonSeconds < last) return 'unobserved_between_samples'
    return 'first_loss_interval_straddles_horizon'
  }
  if (observed.status === 'right_censored') {
    if (horizonSeconds < last) return 'unobserved_between_samples'
    return observed.censor ? 'ambiguous_right_censor' : 'right_censored_before_horizon'
  }
  if (observed.status === 'unexposed_at_issue') return 'unexposed_at_issue'
  throw new Error('Unknown cohort outcome status')
}

function episodeClusters(issues, maximumHorizonSeconds) {
  const intervals = issues
    .map((issue) => ({
      from: issue.anchor.timestamp,
      to: Math.max(
        issue.anchor.timestamp + maximumHorizonSeconds,
        issue.latestScore.through?.timestamp ?? issue.anchor.timestamp,
      ),
    }))
    .sort((a, b) => a.from - b.from)
  let count = 0
  let end = -Infinity
  for (const interval of intervals) {
    if (interval.from > end) count++
    end = Math.max(end, interval.to)
  }
  return count
}

// This join is scrvUSD-specific: future vault adapters need their own verified
// source-time joins, clock semantics, and route semantics before sharing a panel.
export function scrvusdPanelFromIssues({ issues, asOfUtc, horizons = [], venue }) {
  if (!validUtc(asOfUtc)) throw new Error('Invalid as-of UTC')
  if (!Array.isArray(horizons) || horizons.some((h) => !Number.isSafeInteger(h) || h < 0))
    throw new Error('Invalid horizon seconds')
  if (!venue?.chainId || !venue?.vault || !venue?.asset || !venue?.route)
    throw new Error('Missing venue identity')
  const cutoff = Date.parse(asOfUtc)
  if (
    issues.some(
      (issue) =>
        !Number.isSafeInteger(issue.anchor?.timestamp) ||
        issue.anchor.timestamp * 1000 > cutoff ||
        !observedBy(issue.anchorIssuedAtUtc, cutoff) ||
        issue.anchor.timestamp * 1000 > Date.parse(issue.anchorIssuedAtUtc) ||
        !observedBy(issue.flowContextRecordedAtUtc, cutoff) ||
        !observedBy(
          issue.historicalSuffix?.evidenceCutoffUtc,
          Date.parse(issue.anchorIssuedAtUtc),
        ) ||
        (issue.sameBlockFlow?.status === 'available' &&
          !observedBy(issue.sameBlockFlow.issuedAtUtc, Date.parse(issue.anchorIssuedAtUtc))) ||
        (issue.latestScore.status !== 'pending_followup' &&
          (!observedBy(issue.latestScore.scoredAtUtc, cutoff) ||
            !Number.isSafeInteger(issue.latestScore.through?.timestamp) ||
            issue.latestScore.through.timestamp * 1000 > cutoff ||
            issue.members.some((member) => {
              const elapsed = issue.latestScore.through.timestamp - issue.anchor.timestamp
              return (
                member.sampledSuccessSeconds.some(
                  (seconds) => !Number.isSafeInteger(seconds) || seconds < 0 || seconds > elapsed,
                ) ||
                (member.observed?.status === 'first_loss_observed' &&
                  member.observed.firstLoss.upperSeconds > elapsed) ||
                (member.observed?.status === 'right_censored' &&
                  member.observed.observedSeconds > elapsed)
              )
            }))) ||
        (issue.latestScore.status === 'pending_followup' &&
          issue.members.some(
            (member) =>
              member.observed !== null ||
              (member.cleanSuccessAtAnchor
                ? member.sampledSuccessSeconds.length !== 1 || member.sampledSuccessSeconds[0] !== 0
                : member.sampledSuccessSeconds.length !== 0),
          )),
    )
  )
    throw new Error('Issue includes evidence unavailable at as-of cutoff')
  const rows = issues.flatMap((issue) =>
    issue.members.map((member) => ({
      venue,
      anchor: { block: issue.anchor, issueTimeUtc: issue.anchorIssuedAtUtc },
      holder: member.holder,
      rawAssetAmount: member.rawCrvUsd,
      route: venue.route,
      baseline: { cleanSameHolderWithdrawalAtAnchor: member.cleanSuccessAtAnchor },
      future: {
        observation: member.observed ?? { status: 'pending_followup' },
        lastSampledSuccessSeconds: member.sampledSuccessSeconds.at(-1) ?? null,
        lastSampledSuccessBlock: member.lastSampledSuccessBlock ?? null,
        lastSampledSuccessUtc: member.sampledSuccessSeconds.length
          ? new Date(
              (issue.anchor.timestamp + member.sampledSuccessSeconds.at(-1)) * 1000,
            ).toISOString()
          : null,
        sampledSuccessSeconds: member.sampledSuccessSeconds,
        outcomeSourceCutoffUtc: issue.latestScore.scoredAtUtc ?? null,
        outcomeThroughBlock: issue.latestScore.through ?? null,
        horizons: horizons.map((seconds) => ({ seconds, class: horizonClass(member, seconds) })),
      },
      sourceRefs: {
        durationIssue: issue.durationIssue,
        flowContextIssue: issue.flowContextIssue,
        latestScore: issue.latestScore,
      },
      historicalFlowContext: {
        label: 'observed_successful_vault_events_not_exit_capacity',
        evidenceCutoffUtc: issue.historicalSuffix.evidenceCutoffUtc,
        coverage: issue.historicalSuffix.coverage,
        completeToFirstLive: issue.historicalSuffix.completeToFirstLive,
        coverageRelationship: issue.historicalSuffix.completeToFirstLive
          ? 'connected_to_first_live_block'
          : 'unbridged_historical_suffix',
        grossWithdrawalMaxima: issue.historicalSuffix.maximumObservedCompleteWindow,
        signedNetDepletionMaxima: issue.historicalSuffix.maximumObservedCompleteWindowNetDepletion,
        sameBlockTrailingGrossNet:
          issue.sameBlockFlow.status === 'available'
            ? issue.sameBlockFlow.flowFeatures.trailingCompleteWindow
            : { status: 'unavailable', reason: issue.sameBlockFlow.reason },
        sameBlockFlowFeatureRef:
          issue.sameBlockFlow.status === 'available'
            ? {
                filename: issue.sameBlockFlow.filename,
                logicalSha256: issue.sameBlockFlow.logicalSha256,
                physicalSha256: issue.sameBlockFlow.physicalSha256,
              }
            : null,
      },
    })),
  )
  const maxHorizon = Math.max(0, ...horizons)
  return {
    schema: 'scrvusd-exit-evidence-panel-v1',
    asOfUtc,
    status: rows.length ? 'descriptive_uncalibrated' : 'unavailable',
    horizonOrigin: 'frozen_anchor_block_time',
    horizonsSeconds: horizons,
    dependence: {
      dependentPairCount: rows.length,
      anchorCount: issues.length,
      distinctHolderCount: new Set(rows.map((row) => row.holder)).size,
      vaultCount: new Set(rows.map((row) => `${row.venue.chainId}:${row.venue.vault}`)).size,
      overlappingAnchorWindowClusterCount: episodeClusters(issues, maxHorizon),
      clusterRule: 'same_vault_overlapping_anchor_to_max_horizon_or_last_sample',
      independentEpisodeCount: null,
    },
    forecast: { status: 'unavailable', reason: 'no_independent_calibration' },
    caveat:
      'Only sampled same-holder exits are observed. First-loss bounds and censors do not imply continuous availability, probability, or future runway. Historical gross withdrawals and signed net depletion are separate context, never executable capacity.',
    rows,
  }
}

export function scrvusdPanel({
  asOfUtc,
  horizons = [],
  durationOut = DURATION_OUT,
  contextOut = CONTEXT_OUT,
} = {}) {
  if (!validUtc(asOfUtc)) throw new Error('Invalid as-of UTC')
  const cutoff = Date.parse(asOfUtc)
  verifyDuration({ out: durationOut })
  verifyContext({ out: contextOut })
  const source = sourceIdentity()
  const issueDir = join(durationOut, 'issues')
  const scoreDir = join(durationOut, 'scores')
  const names = existsSync(issueDir)
    ? readdirSync(issueDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const scoreNames = existsSync(scoreDir)
    ? readdirSync(scoreDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const issues = []
  for (const filename of names) {
    const duration = readSealed(join(issueDir, filename))
    if (filename !== nameFor(duration.saved.block))
      throw new Error('Invalid duration issue filename')
    if (!validUtc(duration.saved.issuedAtUtc)) throw new Error('Invalid duration issue time')
    if (!observedBy(duration.saved.issuedAtUtc, cutoff)) continue
    const contextPath = join(contextOut, filename)
    if (!existsSync(contextPath)) continue
    const context = readContext(contextPath)
    if (!validUtc(context.issuedAtUtc)) throw new Error('Invalid context issue time')
    if (!observedBy(context.issuedAtUtc, cutoff)) continue
    if (context.historicalSuffix.sourceIdentitySha256 !== source.identitySha256)
      throw new Error('Vault flow identity mismatch')
    const contextBytes = readFileSync(contextPath)
    const scores = scoreNames
      .filter((name) => name.startsWith(`${filename}.through-`))
      .map((name) => {
        const saved = readSealed(join(scoreDir, name))
        if (
          name !==
          `${filename}.through-${String(saved.saved.through.block.number).padStart(12, '0')}.json`
        )
          throw new Error('Invalid cohort score filename')
        if (!validUtc(saved.saved.scoredAtUtc)) throw new Error('Invalid cohort score time')
        return { name, saved }
      })
      .filter(({ saved }) => observedBy(saved.saved.scoredAtUtc, cutoff))
      .map(({ name, saved }) => ({ score: saved.saved, scoreRef: ref(name, saved) }))
    const joined = joinIssue({
      duration: duration.saved,
      durationRef: ref(filename, duration),
      context,
      contextRef: { filename, logicalSha256: context.sha256, physicalSha256: sha(contextBytes) },
      scores,
    })
    const latestScore = scores
      .toSorted((a, b) => a.score.through.block.number - b.score.through.block.number)
      .at(-1)?.score
    joined.members = joined.members.map((member) => {
      const lastSeconds = member.sampledSuccessSeconds.at(-1)
      const lastBlock =
        lastSeconds === 0
          ? joined.anchor
          : latestScore?.futureSource.quotes.find(
              (row) => row.block.timestamp - joined.anchor.timestamp === lastSeconds,
            )?.block
      if (member.cleanSuccessAtAnchor && !lastBlock)
        throw new Error('Missing last sampled success block')
      return { ...member, lastSampledSuccessBlock: lastBlock ?? null }
    })
    issues.push(joined)
  }
  return scrvusdPanelFromIssues({
    issues,
    asOfUtc,
    horizons,
    venue: {
      chainId: source.chainId,
      vault: source.vault,
      asset: source.asset,
      assetDecimals: source.assetDecimals,
      route: 'direct_erc4626_withdraw',
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [asOfUtc, ...horizonArgs] = process.argv.slice(2)
    console.log(JSON.stringify(scrvusdPanel({ asOfUtc, horizons: horizonArgs.map(Number) })))
  } catch (error) {
    console.error(`[exit-evidence-panel] ${error.message}`)
    process.exitCode = 1
  }
}
