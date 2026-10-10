// Offline verified due targets for bounded, stage-only holder score lanes.
// This selector never opens an RPC connection or publishes holder/amount details.
const LANES = new Set([
  'fluid_bridge_usdc_score',
  'fluid_bridge_usdt_score',
  'fluid_ftoken_score',
  'twyne_borrower_pt_score',
  'compound_holder_score',
  'usd3_holder_score',
  'stusds_holder_score',
  'susds_holder_score',
  'aave_usdc_holder_score',
  'aave_usde_holder_score',
  'spark_usdt_holder_score',
  'umbrella_gho_holder_score',
  'sgho_holder_score',
  'sgho_fixed_q_score',
  'sgho_fixed_q_issue',
  'hastra_prime_score',
])

const fail = (valid, code) => {
  if (!valid) throw Error(`holder_short_stage_${code}`)
}

const emptySummary = (lane) => ({
  lane,
  live: 0,
  expired: 0,
  nextLiveDeadlineMs: Infinity,
  nextLiveTargetMs: Infinity,
  nextExpiredDeadlineMs: Infinity,
})

const earlierLive = (deadlineMs, targetMs, row) =>
  deadlineMs < row.nextLiveDeadlineMs ||
  (deadlineMs === row.nextLiveDeadlineMs && targetMs < row.nextLiveTargetMs)

// Build one small, atomic summary. A malformed later target cannot leak earlier counts.
function summarizeSource(source, nowMs) {
  fail(
    LANES.has(source?.lane) && Array.isArray(source.issues) && Array.isArray(source.scores),
    'source_invalid',
  )
  const scored = new Set(source.scores.map((row) => `${row.issueSequence}:${row.horizonHours}`))
  const summary = emptySummary(source.lane)
  for (const issue of source.issues) {
    fail(
      Number.isSafeInteger(issue.sequence) && issue.sequence > 0 && Array.isArray(issue.targets),
      'issue_invalid',
    )
    for (const target of issue.targets) {
      const targetMs = Date.parse(target.targetAtUtc)
      const deadlineMs = Date.parse(
        target.deadlineAtUtc ?? target.deadlineUtc ?? target.captureDeadlineUtc,
      )
      fail(
        Number.isSafeInteger(target.horizonHours) &&
          target.horizonHours > 0 &&
          Number.isSafeInteger(targetMs) &&
          Number.isSafeInteger(deadlineMs) &&
          deadlineMs > targetMs,
        'target_invalid',
      )
      if (targetMs > nowMs || scored.has(`${issue.sequence}:${target.horizonHours}`)) continue
      if (nowMs <= deadlineMs) {
        summary.live++
        if (earlierLive(deadlineMs, targetMs, summary)) {
          summary.nextLiveDeadlineMs = deadlineMs
          summary.nextLiveTargetMs = targetMs
        }
      } else {
        summary.expired++
        summary.nextExpiredDeadlineMs = Math.min(summary.nextExpiredDeadlineMs, deadlineMs)
      }
    }
  }
  return summary.live + summary.expired > 0 ? summary : null
}

function mergeSummary(byLane, sourceSummary) {
  if (!sourceSummary) return
  const row = byLane.get(sourceSummary.lane) ?? emptySummary(sourceSummary.lane)
  row.live += sourceSummary.live
  row.expired += sourceSummary.expired
  if (earlierLive(sourceSummary.nextLiveDeadlineMs, sourceSummary.nextLiveTargetMs, row)) {
    row.nextLiveDeadlineMs = sourceSummary.nextLiveDeadlineMs
    row.nextLiveTargetMs = sourceSummary.nextLiveTargetMs
  }
  row.nextExpiredDeadlineMs = Math.min(
    row.nextExpiredDeadlineMs,
    sourceSummary.nextExpiredDeadlineMs,
  )
  byLane.set(row.lane, row)
}

function finishSelection(byLane) {
  const ordered = [...byLane.values()].sort(
    (a, b) =>
      Number(a.live === 0) - Number(b.live === 0) ||
      a.nextLiveDeadlineMs - b.nextLiveDeadlineMs ||
      a.nextExpiredDeadlineMs - b.nextExpiredDeadlineMs ||
      a.lane.localeCompare(b.lane),
  )
  const nextLive = ordered.find((row) => row.live > 0)
  const nextExpired = [...ordered]
    .filter((row) => row.expired > 0)
    .sort((a, b) => a.nextExpiredDeadlineMs - b.nextExpiredDeadlineMs)[0]
  return {
    nextLiveLane: nextLive?.lane ?? null,
    nextExpiredLane: nextExpired?.lane ?? null,
    nextLiveDeadlineMs: nextLive?.nextLiveDeadlineMs ?? null,
    byLane: ordered.map(
      ({ lane, live, expired, nextLiveDeadlineMs, nextLiveTargetMs, nextExpiredDeadlineMs }) => ({
        lane,
        live,
        expired,
        nextLiveDeadlineMs: Number.isFinite(nextLiveDeadlineMs) ? nextLiveDeadlineMs : null,
        nextLiveTargetMs: Number.isFinite(nextLiveTargetMs) ? nextLiveTargetMs : null,
        nextExpiredDeadlineMs: Number.isFinite(nextExpiredDeadlineMs)
          ? nextExpiredDeadlineMs
          : null,
      }),
    ),
  }
}

export function selectShortStageDue(sources, nowMs) {
  fail(Number.isSafeInteger(nowMs) && nowMs >= 0, 'time_invalid')
  fail(Array.isArray(sources) && sources.length <= 16, 'sources_invalid')
  const byLane = new Map()
  for (const source of sources) mergeSummary(byLane, summarizeSource(source, nowMs))
  return finishSelection(byLane)
}

/** Replays each existing local ledger verifier; no network or ledger writes. */
export async function readVerifiedShortStageDue(
  nowMs = Date.now(),
  {
    bridgeUsdc = async () => (await import('./carry-fluid-bridge-usdc-holder.mjs')).verifyLedgers(),
    bridgeUsdt = async () => (await import('./carry-fluid-bridge-usdt-holder.mjs')).verifyLedgers(),
    twyne = async () => (await import('./carry-twyne-borrower-pt.mjs')).verifyLedgers(),
    compound = async () => {
      const { verifyPublicDirectIssues } = await import('./carry-local-compound-holder-issue.mjs')
      const { verifyPublicDirectScores, hasSuppliedBaseline } =
        await import('./carry-local-compound-holder-score.mjs')
      const issues = await verifyPublicDirectIssues()
      const scores = await verifyPublicDirectScores()
      return { issues: issues.filter((issue) => issue.cases.some(hasSuppliedBaseline)), scores }
    },
    usd3 = async () => {
      const { verifyUsd3Issues } = await import('./carry-public-usd3-exit-issue.mjs')
      const { verifyUsd3Scores, usd3ScorableBaseline } =
        await import('./carry-public-usd3-exit-score.mjs')
      const issues = await verifyUsd3Issues()
      const scores = await verifyUsd3Scores()
      return { issues: issues.filter((issue) => issue.cases.some(usd3ScorableBaseline)), scores }
    },
    stusds = async () => {
      const { verifyStusdsIssues } = await import('./carry-public-stusds-exit-issue.mjs')
      const { verifyStusdsScores, stusdsScorableBaseline } =
        await import('./carry-public-stusds-exit-score.mjs')
      const issues = await verifyStusdsIssues()
      const scores = await verifyStusdsScores()
      return { issues: issues.filter((issue) => issue.cases.some(stusdsScorableBaseline)), scores }
    },
    susds = async () => {
      const { verifySusdsIssues } = await import('./carry-public-susds-exit-issue.mjs')
      const { verifySusdsScores } = await import('./carry-public-susds-exit-score.mjs')
      const issues = await verifySusdsIssues()
      const scores = await verifySusdsScores()
      return {
        issues: issues.filter((issue) =>
          issue.cases.some(
            (entry) =>
              entry.status === 'measured' && entry.measurement?.baselineStatus === 'success',
          ),
        ),
        scores,
      }
    },
    sparkUsdt,
    aaveDirect,
    publicDirect = async () => {
      const { verifyPublicDirectIssues } = await import('./carry-public-direct-exit-issue.mjs')
      const { verifyPublicDirectScores } = await import('./carry-public-direct-exit-score.mjs')
      return { issues: await verifyPublicDirectIssues(), scores: await verifyPublicDirectScores() }
    },
    umbrellaGho = async () => {
      const { verifyAll } = await import('./carry-local-umbrella-gho-holder.mjs')
      const evidence = await verifyAll()
      return {
        issues: evidence.issues.filter((issue) =>
          ['no_code', 'eip7702_delegated'].includes(issue.measurement?.holderCodeStatus),
        ),
        scores: evidence.scores,
      }
    },
    sgho = async () => {
      const { verifySghoIssues } = await import('./carry-public-sgho-exit-issue.mjs')
      const { verifySghoScores } = await import('./carry-public-sgho-exit-score.mjs')
      const issues = await verifySghoIssues()
      return {
        issues: issues.filter((issue) =>
          issue.cases.some(
            (entry) =>
              entry.status === 'measured' && entry.measurement?.baselineStatus === 'success',
          ),
        ),
        scores: await verifySghoScores(),
      }
    },
    sghoFixedQ = async () => {
      const { verifySghoFixedQIssues } = await import('./carry-public-sgho-fixed-q-v2-issue.mjs')
      const { verifySghoFixedQScores } = await import('./carry-public-sgho-fixed-q-v2-score.mjs')
      return { issues: await verifySghoFixedQIssues(), scores: await verifySghoFixedQScores() }
    },
    sghoFixedQParents = async () => {
      const { verifySghoIssues } = await import('./carry-public-sgho-exit-issue.mjs')
      const { verifySghoFixedQIssues, pendingSghoFixedQParentPlans } =
        await import('./carry-public-sgho-fixed-q-v2-issue.mjs')
      return pendingSghoFixedQParentPlans(
        await verifySghoIssues(),
        await verifySghoFixedQIssues(),
        new Date(nowMs).toISOString(),
      )
    },
    hastraPrime = async () => (await import('./pyusd-staking-prospective.mjs')).verifyEvidence(),
    ftokenRoute = async (routeIndex) => {
      const [{ verifyIssues, verifyScores }, { ROUTES }] = await Promise.all([
        import('./carry-fluid-ftoken-holder.mjs'),
        import('./carry-fluid-ftoken-payout.mjs'),
      ])
      fail(routeIndex >= 0 && routeIndex < ROUTES.length, 'fluid_route_invalid')
      const issues = verifyIssues(routeIndex)
      return { issues, scores: verifyScores(routeIndex, issues) }
    },
  } = {},
) {
  fail(Number.isSafeInteger(nowMs) && nowMs >= 0, 'time_invalid')
  const byLane = new Map()
  const verificationFailedLanes = new Set()
  // The shared direct ledgers are large; verify them once for Spark and both Aave markets.
  if (!sparkUsdt || !aaveDirect) {
    try {
      const evidence = await publicDirect()
      if (!aaveDirect) aaveDirect = async () => evidence
      if (!sparkUsdt) {
        const { selectSparkPublicDirectEvidence, sparkPublicDirectIssueScorable } =
          await import('../record-carry-public-spark-usdt-exit-scores.mjs')
        sparkUsdt = async () => {
          const selected = selectSparkPublicDirectEvidence(evidence.issues, evidence.scores)
          return {
            issues: selected.issues.filter(sparkPublicDirectIssueScorable),
            scores: selected.scores,
          }
        }
      }
    } catch (error) {
      if (!sparkUsdt)
        sparkUsdt = async () => {
          throw error
        }
      if (!aaveDirect)
        aaveDirect = async () => {
          throw error
        }
    }
  }
  const collect = async (lane, reader) => {
    try {
      // The verified ledger leaves scope before the next source is opened.
      mergeSummary(byLane, summarizeSource({ lane, ...(await reader()) }, nowMs))
    } catch {
      verificationFailedLanes.add(lane)
    }
  }
  await collect('fluid_bridge_usdc_score', bridgeUsdc)
  await collect('fluid_bridge_usdt_score', bridgeUsdt)
  await collect('twyne_borrower_pt_score', twyne)
  for (let routeIndex = 0; routeIndex < 3; routeIndex++)
    await collect('fluid_ftoken_score', () => ftokenRoute(routeIndex))
  await collect('compound_holder_score', compound)
  await collect('usd3_holder_score', usd3)
  await collect('stusds_holder_score', stusds)
  await collect('susds_holder_score', susds)
  await collect('spark_usdt_holder_score', sparkUsdt)
  try {
    const evidence = await aaveDirect()
    for (const [lane, marketKey] of [
      ['aave_usdc_holder_score', 'aaveV3Usdc'],
      ['aave_usde_holder_score', 'aaveV3Usde'],
    ]) {
      const issues = evidence.issues.filter(
        (issue) =>
          issue.marketKey === marketKey &&
          issue.cases.some(
            (entry) => entry.status === 'measured' && entry.measurement?.status === 'success',
          ),
      )
      const sequences = new Set(issues.map((issue) => issue.sequence))
      const scores = evidence.scores.filter(
        (score) => sequences.has(score.issueSequence) && score.marketKey === marketKey,
      )
      mergeSummary(byLane, summarizeSource({ lane, issues, scores }, nowMs))
    }
  } catch {
    verificationFailedLanes.add('aave_usdc_holder_score')
    verificationFailedLanes.add('aave_usde_holder_score')
  }
  await collect('umbrella_gho_holder_score', umbrellaGho)
  await collect('sgho_holder_score', sgho)
  await collect('sgho_fixed_q_score', sghoFixedQ)
  await collect('hastra_prime_score', hastraPrime)
  try {
    const plans = await sghoFixedQParents()
    fail(Array.isArray(plans) && plans.length <= 2_000, 'linked_issue_plans_invalid')
    const linked = emptySummary('sgho_fixed_q_issue')
    for (const plan of plans) {
      const targetMs = Date.parse(plan.parent?.baseline?.targetBlockAt)
      const deadlineMs = Date.parse(plan.issueDeadlineUtc)
      fail(
        Number.isSafeInteger(targetMs) &&
          Number.isSafeInteger(deadlineMs) &&
          targetMs <= nowMs &&
          deadlineMs >= nowMs,
        'linked_issue_plan_invalid',
      )
      if (deadlineMs === nowMs) continue
      linked.live++
      if (earlierLive(deadlineMs, targetMs, linked)) {
        linked.nextLiveDeadlineMs = deadlineMs
        linked.nextLiveTargetMs = targetMs
      }
    }
    if (linked.live > 0) mergeSummary(byLane, linked)
  } catch {
    verificationFailedLanes.add('sgho_fixed_q_issue')
  }
  return {
    ...finishSelection(byLane),
    verificationFailedLanes: [...verificationFailedLanes],
  }
}
