// Spark USDT-only entry point for the native holder-exit campaign. The shared
// public direct ledgers are fully verified before filtering this exact route.
import { pathToFileURL } from 'node:url'

import { readEnv } from './lib/venue-reads.mjs'
import {
  DIRECT_MARKETS,
  configuredPublicRpcUrls,
  publicRpcClients,
  verifyPublicDirectIssues,
} from './research/carry-public-direct-exit-issue.mjs'
import {
  scorePublicDirectExit,
  verifyPublicDirectScores,
} from './research/carry-public-direct-exit-score.mjs'
import {
  pendingPublicDirectScorePlans,
  runPublicDirectScoreSweep,
} from './record-carry-public-direct-exit-scores.mjs'
export { publicDirectIssueScorable as sparkPublicDirectIssueScorable } from './record-carry-public-direct-exit-scores.mjs'

const SPARK_MARKET = 'sparkLendUsdt'
const SPARK_ROUTE_KEY = 'USDT → supply on Spark'
const SPARK_DESTINATION = '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f'
const SPARK_ASSET = '0xdac17f958d2ee523a2206206994597c13d831ec7'

export function selectSparkPublicDirectEvidence(issues, scores) {
  const route = DIRECT_MARKETS[SPARK_MARKET]
  if (
    route?.kind !== 'spark' ||
    route.routeKey !== SPARK_ROUTE_KEY ||
    route.destination !== SPARK_DESTINATION ||
    route.asset !== SPARK_ASSET
  )
    throw Error('spark_public_route_changed')
  const selectedIssues = issues.filter((issue) => {
    if (issue.marketKey !== SPARK_MARKET) return false
    if (
      issue.routeKey !== SPARK_ROUTE_KEY ||
      issue.destination !== SPARK_DESTINATION ||
      issue.originalAsset !== SPARK_ASSET
    )
      throw Error('spark_public_issue_identity_invalid')
    return true
  })
  const sequences = new Set(selectedIssues.map((issue) => issue.sequence))
  const selectedScores = scores.filter((score) => {
    if (!sequences.has(score.issueSequence)) return false
    if (score.marketKey !== SPARK_MARKET || score.routeKey !== SPARK_ROUTE_KEY)
      throw Error('spark_public_score_identity_invalid')
    return true
  })
  return { issues: selectedIssues, scores: selectedScores }
}

export async function runSparkPublicDirectScoreSweep({
  issues,
  scores,
  urls,
  now,
  score = scorePublicDirectExit,
  clientsFor = publicRpcClients,
}) {
  return runPublicDirectScoreSweep({
    ...selectSparkPublicDirectEvidence(issues, scores),
    urls,
    now,
    score,
    clientsFor,
  })
}

async function cli() {
  const mode = process.argv[2]
  if (mode !== '--plan' && mode !== '--sweep') throw Error('spark_public_score_usage')
  const evidence = selectSparkPublicDirectEvidence(
    await verifyPublicDirectIssues(),
    await verifyPublicDirectScores(),
  )
  if (mode === '--plan') {
    const due = pendingPublicDirectScorePlans(
      evidence.issues,
      evidence.scores,
      new Date().toISOString(),
    )
    process.stdout.write(
      `${JSON.stringify({ status: 'spark_public_score_plan', issues: evidence.issues.length, live: due.filter((row) => row.active).length, expired: due.filter((row) => !row.active).length })}\n`,
    )
    return
  }
  const summary = await runSparkPublicDirectScoreSweep({
    ...evidence,
    urls: configuredPublicRpcUrls(readEnv()),
  })
  process.stdout.write(`${JSON.stringify({ status: 'spark_public_score_sweep', ...summary })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(() => {
    // Errors may contain credential-bearing URLs or sampled public holders.
    process.stderr.write('spark_public_score_sweep_failed\n')
    process.exitCode = 1
  })
}
