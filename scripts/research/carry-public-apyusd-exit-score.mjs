// Future receipt-initiation simulations. No eth_call creates a transferable receipt.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readEnv } from '../lib/venue-reads.mjs'
import { configuredPublicRpcUrls } from './carry-public-direct-exit-issue.mjs'
import {
  ASSET,
  HORIZONS,
  OUT_ROOT,
  ROUTE,
  VAULT,
  appendChain,
  assay,
  attestIdentity,
  canonical,
  independentPairs,
  readChain,
  readHeader,
  seal,
  utc,
} from './carry-public-apyusd-exit-common.mjs'
import { OUT as ISSUE_OUT, verifyApyUsdIssues } from './carry-public-apyusd-exit-issue.mjs'

export const STUDY = 'carry_public_apyusd_exit_score_v1'
export const OUT = resolve(OUT_ROOT, 'carry-public-apyusd-exit-scores')

export function validateApyUsdScore(row, issues) {
  const issue = issues[row?.issueSequence - 1]
  const plan = issue?.targets.find((entry) => entry.horizonHours === row?.horizonHours)
  if (
    !issue ||
    !plan ||
    row.study !== STUDY ||
    row.issueSha256 !== issue.sha256 ||
    row.routeKey !== ROUTE ||
    row.destination !== VAULT ||
    row.originalAsset !== ASSET ||
    row.holder !== issue.holder ||
    row.targetAtUtc !== plan.targetAtUtc ||
    row.captureDeadlineUtc !== plan.captureDeadlineUtc ||
    !Array.isArray(row.cases) ||
    row.cases.length !== issue.cases.length ||
    row.finalPayout !== 'unmeasured_no_onchain_owned_receipt' ||
    utc(row.scoredAtUtc) < utc(plan.targetAtUtc)
  )
    throw Error('apyusd_score_binding_invalid')
  if (row.status === 'measured') {
    if (
      utc(row.scoredAtUtc) > utc(plan.captureDeadlineUtc) ||
      !row.target ||
      row.target.timestamp * 1000 < utc(plan.targetAtUtc) ||
      row.target.timestamp * 1000 > utc(plan.captureDeadlineUtc) ||
      BigInt(row.target.number) <= BigInt(issue.baseline.number) ||
      row.target.originA === row.target.originB ||
      row.deadlineWitness !== null
    )
      throw Error('apyusd_score_target_invalid')
  } else if (
    row.status !== 'capture_window_missed' ||
    row.target !== null ||
    !row.deadlineWitness ||
    row.deadlineWitness.primary.timestamp * 1000 <= utc(plan.captureDeadlineUtc) ||
    row.deadlineWitness.secondary.timestamp * 1000 <= utc(plan.captureDeadlineUtc)
  )
    throw Error('apyusd_score_censor_invalid')
  for (const [index, item] of row.cases.entries()) {
    const original = issue.cases[index]
    if (item.label !== original.label || item.assetsRaw !== original.assetsRaw)
      throw Error('apyusd_score_q_invalid')
    if (original.assetsRaw === null) {
      if (item.status !== 'omitted' || item.outcome !== null)
        throw Error('apyusd_score_omitted_invalid')
    } else if (row.status === 'capture_window_missed') {
      if (item.status !== 'unavailable' || item.outcome !== 'censored_capture_window_missed')
        throw Error('apyusd_score_censor_case_invalid')
    } else if (
      item.status !== 'measured' ||
      !['initiation_success', 'evm_revert'].includes(item.outcome) ||
      canonical(item.primary) !== canonical(item.secondary) ||
      item.primary?.status !== item.outcome ||
      item.payout !== 'not_delivered_by_initiation'
    )
      throw Error('apyusd_score_case_invalid')
  }
  return row
}

export async function verifyApyUsdScores(out = OUT, loadIssues = verifyApyUsdIssues) {
  const issues = await loadIssues(ISSUE_OUT)
  const rows = await readChain(out)
  const keys = new Set()
  for (const row of rows) {
    validateApyUsdScore(row, issues)
    const key = `${row.issueSequence}:${row.horizonHours}`
    if (keys.has(key)) throw Error('apyusd_score_duplicate')
    keys.add(key)
  }
  return rows
}

async function firstTarget(primary, secondary, issue, plan) {
  const head = await readHeader(primary)
  const otherHead = await readHeader(secondary)
  if (
    head.timestamp * 1000 < utc(plan.targetAtUtc) ||
    otherHead.timestamp * 1000 < utc(plan.targetAtUtc)
  )
    return { status: 'not_finalized' }
  let lo = BigInt(issue.baseline.number) + 1n
  let hi =
    BigInt(head.number) < BigInt(otherHead.number) ? BigInt(head.number) : BigInt(otherHead.number)
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const block = await readHeader(primary, `0x${mid.toString(16)}`)
    if (block.timestamp * 1000 < utc(plan.targetAtUtc)) lo = mid + 1n
    else hi = mid
  }
  const target = await readHeader(primary, `0x${lo.toString(16)}`)
  const witness = await readHeader(secondary, `0x${lo.toString(16)}`)
  const prior = await readHeader(primary, `0x${(lo - 1n).toString(16)}`)
  const witnessPrior = await readHeader(secondary, `0x${(lo - 1n).toString(16)}`)
  if (
    canonical(target) !== canonical(witness) ||
    canonical(prior) !== canonical(witnessPrior) ||
    prior.timestamp * 1000 >= utc(plan.targetAtUtc) ||
    target.timestamp * 1000 < utc(plan.targetAtUtc) ||
    BigInt(head.number) < lo ||
    BigInt(otherHead.number) < lo
  )
    throw Error('apyusd_target_disagreement')
  return { status: 'target', target, head, otherHead, prior }
}

export async function scoreApyUsd({
  urls = configuredPublicRpcUrls(readEnv()),
  now = () => new Date(),
  pairs = independentPairs(urls),
  loadIssues = verifyApyUsdIssues,
  loadScores = verifyApyUsdScores,
  selectTarget = firstTarget,
  attest = attestIdentity,
  append = appendChain,
} = {}) {
  const issues = await loadIssues()
  const scores = await loadScores()
  const seen = new Set(scores.map((item) => `${item.issueSequence}:${item.horizonHours}`))
  let due = 0,
    attempted = 0,
    scored = 0,
    retries = 0
  for (const issue of issues)
    for (const plan of issue.targets) {
      if (
        utc(plan.targetAtUtc) > now().getTime() ||
        seen.has(`${issue.sequence}:${plan.horizonHours}`)
      )
        continue
      due++
      if (attempted >= 6) continue
      attempted++
      let success = false
      for (const [primary, secondary] of pairs) {
        try {
          const choice = await selectTarget(primary, secondary, issue, plan)
          if (choice.status === 'not_finalized') continue
          const scoredAtUtc = now().toISOString()
          const onTime = utc(scoredAtUtc) <= utc(plan.captureDeadlineUtc)
          if (onTime && choice.target.timestamp * 1000 > utc(plan.captureDeadlineUtc))
            throw Error('apyusd_target_after_deadline')
          if (
            !onTime &&
            (choice.head.timestamp * 1000 <= utc(plan.captureDeadlineUtc) ||
              choice.otherHead.timestamp * 1000 <= utc(plan.captureDeadlineUtc))
          )
            continue
          let target = null,
            deadlineWitness = null
          let cases
          if (onTime) {
            const identities = await Promise.all([
              attest(primary, choice.target.hash),
              attest(secondary, choice.target.hash),
            ])
            if (canonical(identities[0]) !== canonical(identities[1]))
              throw Error('apyusd_target_identity_disagreement')
            target = {
              ...choice.target,
              parent: choice.prior,
              identity: identities[0],
              originA: primary.provider,
              originB: secondary.provider,
            }
            cases = []
            for (const item of issue.cases) {
              if (item.assetsRaw === null) {
                cases.push({ label: item.label, assetsRaw: null, status: 'omitted', outcome: null })
                continue
              }
              const [a, b] = await Promise.all([
                assay(primary, issue.holder, item.assetsRaw, target.hash),
                assay(secondary, issue.holder, item.assetsRaw, target.hash),
              ])
              if (canonical(a) !== canonical(b)) throw Error('apyusd_score_origin_disagreement')
              cases.push({
                label: item.label,
                assetsRaw: item.assetsRaw,
                status: 'measured',
                outcome: a.status,
                primary: a,
                secondary: b,
                payout: 'not_delivered_by_initiation',
              })
            }
          } else {
            deadlineWitness = { primary: choice.head, secondary: choice.otherHead }
            cases = issue.cases.map((item) =>
              item.assetsRaw === null
                ? { label: item.label, assetsRaw: null, status: 'omitted', outcome: null }
                : {
                    label: item.label,
                    assetsRaw: item.assetsRaw,
                    status: 'unavailable',
                    outcome: 'censored_capture_window_missed',
                  },
            )
          }
          const prior = await loadScores()
          const row = seal({
            study: STUDY,
            sequence: prior.length + 1,
            previousSha256: prior.at(-1)?.sha256 ?? null,
            issueSequence: issue.sequence,
            issueSha256: issue.sha256,
            routeKey: ROUTE,
            destination: VAULT,
            originalAsset: ASSET,
            holder: issue.holder,
            horizonHours: plan.horizonHours,
            targetAtUtc: plan.targetAtUtc,
            captureDeadlineUtc: plan.captureDeadlineUtc,
            scoredAtUtc,
            status: onTime ? 'measured' : 'capture_window_missed',
            target,
            deadlineWitness,
            cases,
            finalPayout: 'unmeasured_no_onchain_owned_receipt',
          })
          validateApyUsdScore(row, issues)
          await append(row, OUT, (out) => verifyApyUsdScores(out, loadIssues))
          scored++
          success = true
          break
        } catch {
          retries++
        }
      }
      if (!success && now().getTime() > utc(plan.captureDeadlineUtc)) retries++
    }
  return { due, attempted, scored, retries }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--verify')
      console.log(JSON.stringify({ scores: (await verifyApyUsdScores()).length }))
    else if (process.argv[2] === '--score') {
      const result = await scoreApyUsd()
      console.log(JSON.stringify(result))
      if (result.attempted && result.scored === 0 && result.retries) process.exitCode = 1
    } else throw Error('apyusd_score_usage')
  } catch {
    process.stderr.write('public_apyusd_score_failed\n')
    process.exitCode = 1
  }
}
