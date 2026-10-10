// Sampled, fixed-holder sUSDS direct-withdraw persistence. Research only; no alerts.
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OUT as CHECKPOINT_OUT,
  RESERVE_BYTES,
  readValidatedCheckpoints,
  sourceIdentity,
} from './susds-finalized-checkpoint.mjs'
import {
  MAX_AGE_SECONDS,
  OUT as EXIT_OUT,
  validateIssue as validateExitIssue,
  verify as verifyExits,
} from './susds-fixed-holder-exit.mjs'
import { OUT as PLAN_OUT, readPlan } from './susds-holder-plan.mjs'

export const STUDY = 'susds-fixed-holder-duration-v1'
export const OUT = resolve('data/research/venue-signals/susds-holder-duration')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (value) => ({ ...value, sha256: sha(JSON.stringify(value)) })
const unsigned = ({ sha256: _sha256, ...rest }) => rest
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const nameFor = (block) => `${String(block.number).padStart(12, '0')}-${block.hash.slice(2)}.json`
const checkpointRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.checkpoint.sha256,
  physicalSha256: row.physicalSha256,
})
const exitRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.issue.sha256,
  physicalSha256: row.physicalSha256,
})

function assertOrdered(checkpoints, exitRows) {
  const known = new Map()
  for (const row of checkpoints) {
    const block = row.checkpoint.block
    if (known.has(block.number)) throw new Error('Duplicate checkpoint height')
    const preceding = checkpoints[known.size - 1]?.checkpoint.block
    if (preceding && (preceding.number >= block.number || preceding.timestamp >= block.timestamp))
      throw new Error('Checkpoint chronology is not increasing')
    known.set(block.number, block.hash)
  }
  const seen = new Set()
  for (const row of exitRows) {
    const block = row.issue.checkpoint.block
    if (seen.has(block.number) || known.get(block.number) !== block.hash)
      throw new Error('Exit issue does not bind one checkpoint')
    seen.add(block.number)
  }
}

function classification(row, plan) {
  if (!row) return { type: 'censor', reason: 'missing_exit_observation' }
  const issue = row.issue
  const result = issue.result
  if (issue.codeRelation !== 'same_as_plan_anchor')
    return { type: 'censor', reason: 'implementation_changed' }
  if (result.status === 'provider_ambiguous')
    return { type: 'censor', reason: 'provider_ambiguity' }
  if (result.balanceSharesRaw === null || result.previewSharesRaw === null)
    return { type: 'censor', reason: 'holder_diagnostics_unavailable' }
  if (BigInt(result.balanceSharesRaw) < BigInt(result.previewSharesRaw))
    return { type: 'censor', reason: 'insufficient_holder_shares' }
  if (result.status === 'success') return { type: 'success' }
  if (result.status === 'revert') return { type: 'revert' }
  throw new Error(`Unknown sUSDS exit result for ${plan.holder}`)
}

// All observed starts remain in the denominator, including active and ambiguous episodes.
// Checkpoint time is the origin; a loss is known only within two sampled block times.
export function asOfRiskSet({ plan, checkpoints, exitRows, throughBlock, issuedAtUtc }) {
  assertOrdered(checkpoints, exitRows)
  const issuedMs = Date.parse(issuedAtUtc)
  if (!Number.isSafeInteger(issuedMs)) throw new Error('Invalid duration issue clock')
  const available = checkpoints.filter(
    (row) =>
      row.checkpoint.block.number <= throughBlock &&
      Date.parse(row.checkpoint.captureEndUtc) <= issuedMs,
  )
  if (available.at(-1)?.checkpoint.block.number !== throughBlock)
    throw new Error('Duration anchor unavailable as of issue')
  const allowed = new Set(available.map((row) => row.checkpoint.block.number))
  const exits = new Map(
    exitRows
      .filter(
        (row) =>
          allowed.has(row.issue.checkpoint.block.number) &&
          Date.parse(row.issue.captureEndUtc) <= issuedMs,
      )
      .map((row) => [row.issue.checkpoint.block.number, row]),
  )
  const schedule = available
    .filter((row) => row.checkpoint.block.number > plan.checkpoint.block.number)
    .map((row) => {
      const block = row.checkpoint.block
      const exit = exits.get(block.number)
      const state = classification(exit, plan)
      return {
        block: block.number,
        blockUtc: iso(block.timestamp),
        checkpoint: checkpointRef(row),
        checkpointCaptureEndUtc: row.checkpoint.captureEndUtc,
        exitIssue: exit ? exitRef(exit) : null,
        exitCaptureEndUtc: exit?.issue.captureEndUtc ?? null,
        observedStatus: exit?.issue.result.status ?? 'missing',
        state,
      }
    })
  const blocks = new Map(
    available.map((row) => [row.checkpoint.block.number, row.checkpoint.block]),
  )
  const episodes = []
  let active = null
  let lastSuccess = null
  for (const sample of schedule) {
    const block = blocks.get(sample.block)
    if (!active) {
      if (sample.state.type === 'success') {
        active = {
          startBlock: sample.block,
          startUtc: sample.blockUtc,
          startExitIssue: sample.exitIssue,
          sampleBlocks: [sample.block],
        }
        lastSuccess = block
      }
      continue
    }
    active.sampleBlocks.push(sample.block)
    if (sample.state.type === 'success') {
      const prior = exits.get(lastSuccess.number)?.issue.result.balanceSharesRaw
      const current = exits.get(block.number)?.issue.result.balanceSharesRaw
      if (prior !== null && current !== null && BigInt(current) < BigInt(prior)) {
        episodes.push({
          ...active,
          outcome: 'censored',
          censorReason: 'share_attrition',
          lastCleanSuccessBlock: lastSuccess.number,
          observedLowerSeconds: lastSuccess.timestamp - blocks.get(active.startBlock).timestamp,
          censorAtBlock: block.number,
          censorAtUtc: sample.blockUtc,
        })
        active = {
          startBlock: sample.block,
          startUtc: sample.blockUtc,
          startExitIssue: sample.exitIssue,
          sampleBlocks: [sample.block],
        }
      }
      lastSuccess = block
    } else if (
      sample.state.type === 'revert' &&
      BigInt(exits.get(block.number).issue.result.balanceSharesRaw) <
        BigInt(exits.get(lastSuccess.number).issue.result.balanceSharesRaw)
    ) {
      episodes.push({
        ...active,
        outcome: 'censored',
        censorReason: 'share_attrition',
        lastCleanSuccessBlock: lastSuccess.number,
        observedLowerSeconds: lastSuccess.timestamp - blocks.get(active.startBlock).timestamp,
        censorAtBlock: block.number,
        censorAtUtc: sample.blockUtc,
      })
      active = null
      lastSuccess = null
    } else if (sample.state.type === 'revert') {
      const start = blocks.get(active.startBlock).timestamp
      episodes.push({
        ...active,
        outcome: 'first_loss_interval',
        intervalStartBlock: lastSuccess.number,
        intervalEndBlock: block.number,
        lowerSeconds: lastSuccess.timestamp - start,
        upperSeconds: block.timestamp - start,
      })
      active = null
      lastSuccess = null
    } else {
      episodes.push({
        ...active,
        outcome: 'censored',
        censorReason:
          sample.state.reason === 'missing_exit_observation' &&
          issuedMs <= (block.timestamp + MAX_AGE_SECONDS) * 1000
            ? 'pending_exit_observation'
            : sample.state.reason,
        lastCleanSuccessBlock: lastSuccess.number,
        observedLowerSeconds: lastSuccess.timestamp - blocks.get(active.startBlock).timestamp,
        censorAtBlock: block.number,
        censorAtUtc: sample.blockUtc,
      })
      active = null
      lastSuccess = null
    }
  }
  if (active)
    episodes.push({
      ...active,
      outcome: 'ongoing_right_censor',
      lastCleanSuccessBlock: lastSuccess.number,
      observedLowerSeconds: lastSuccess.timestamp - blocks.get(active.startBlock).timestamp,
    })
  return {
    status: 'uncalibrated',
    reason: 'one_selected_holder_no_independent_validation',
    vault: 'susds_direct_usds',
    holderCount: 1,
    vaultCount: 1,
    episodeCount: episodes.length,
    counts: {
      firstLossIntervals: episodes.filter((item) => item.outcome === 'first_loss_interval').length,
      ongoingRightCensors: episodes.filter((item) => item.outcome === 'ongoing_right_censor')
        .length,
      ambiguousCensors: episodes.filter((item) => item.outcome === 'censored').length,
    },
    observationSchedule: schedule,
    episodes,
    caveat:
      'Sampled direct-USDS withdraw episodes and censoring for one selected holder. No calibrated likelihood, continuous exit guarantee, cash headroom, or USDS-to-USDC route claim.',
  }
}

export function riskSetBoundsAtHorizon(riskSet, horizonSeconds) {
  if (!Number.isFinite(horizonSeconds) || horizonSeconds < 0)
    throw new Error('Invalid duration horizon')
  const episodes = riskSet.episodes
  if (!episodes?.length) return { status: 'unavailable', reason: 'no_exposure_episodes' }
  let definitelyAlive = 0
  let definitelyFailed = 0
  let ambiguous = 0
  for (const item of episodes) {
    if (item.outcome === 'first_loss_interval') {
      if (horizonSeconds <= item.lowerSeconds) definitelyAlive++
      else if (horizonSeconds >= item.upperSeconds) definitelyFailed++
      else ambiguous++
    } else if (horizonSeconds <= item.observedLowerSeconds) definitelyAlive++
    else ambiguous++
  }
  return {
    status: 'research_only_uncalibrated',
    horizonSeconds,
    horizonOrigin: 'episode_start',
    episodeCount: episodes.length,
    definitelyAlive,
    definitelyFailed,
    ambiguous,
    empiricalPersistenceLowerBound: definitelyAlive / episodes.length,
    empiricalPersistenceUpperBound: (definitelyAlive + ambiguous) / episodes.length,
    caveat:
      'Dependent sampled episodes since first success, not remaining time from the current anchor; neither a forecast probability nor an exit guarantee.',
  }
}

export function buildIssue({
  plan,
  planPhysicalSha256,
  checkpoints,
  exitRows,
  atBlock,
  issuedAtUtc,
}) {
  assertOrdered(checkpoints, exitRows)
  const anchor = checkpoints.find((row) => row.checkpoint.block.number === atBlock)
  const exit = exitRows.find((row) => row.issue.checkpoint.block.number === atBlock)
  const issuedMs = Date.parse(issuedAtUtc)
  if (
    plan?.status !== 'selected' ||
    !/^[0-9a-f]{64}$/.test(planPhysicalSha256) ||
    !anchor ||
    !exit ||
    classification(exit, plan).type !== 'success' ||
    exit.issue.plan.logicalSha256 !== plan.sha256 ||
    exit.issue.plan.physicalSha256 !== planPhysicalSha256 ||
    exit.issue.holder !== plan.holder ||
    exit.issue.rawUsds !== plan.rawUsds
  )
    throw new Error('Ineligible sUSDS duration anchor')
  const captureMs = Date.parse(exit.issue.captureEndUtc)
  if (
    !Number.isSafeInteger(issuedMs) ||
    issuedMs < captureMs ||
    issuedMs - captureMs > MAX_AGE_SECONDS * 1000 ||
    Date.parse(anchor.checkpoint.captureEndUtc) > issuedMs ||
    checkpoints.some(
      (row) =>
        row.checkpoint.block.number > atBlock &&
        Date.parse(row.checkpoint.captureEndUtc) <= issuedMs,
    )
  )
    throw new Error('Duration issue is late or later checkpoint already captured')
  const available = checkpoints.filter(
    (row) =>
      row.checkpoint.block.number <= atBlock &&
      Date.parse(row.checkpoint.captureEndUtc) <= issuedMs,
  )
  const allowed = new Set(available.map((row) => row.checkpoint.block.number))
  const availableExits = exitRows.filter(
    (row) =>
      allowed.has(row.issue.checkpoint.block.number) &&
      Date.parse(row.issue.captureEndUtc) <= issuedMs,
  )
  return seal({
    study: STUDY,
    kind: 'prospective-fixed-holder-first-loss-risk-set',
    issuedAtUtc,
    source: 'susds_direct_usds',
    plan: { logicalSha256: plan.sha256, physicalSha256: planPhysicalSha256 },
    holder: plan.holder,
    rawUsds: plan.rawUsds,
    block: anchor.checkpoint.block,
    checkpoint: checkpointRef(anchor),
    exitIssue: exitRef(exit),
    priorSource: {
      checkpoints: available
        .filter((row) => row.checkpoint.block.number < atBlock)
        .map(checkpointRef),
      exitIssues: availableExits
        .filter((row) => row.issue.checkpoint.block.number < atBlock)
        .map(exitRef),
    },
    baseline: asOfRiskSet({
      plan,
      checkpoints: available,
      exitRows: availableExits,
      throughBlock: atBlock,
      issuedAtUtc,
    }),
    caveats: [
      'One preselected holder and fixed direct USDS withdraw; simulation does not guarantee transaction execution.',
      'Local issue time is an operator attestation; only sources captured by that time are included.',
      'sUSDS maxWithdraw is share accounting, not peer-flow cash headroom; this stratum is not pooled with scrvUSD.',
    ],
  })
}

export function scoreIssue({ issue, plan, checkpoints, exitRows, throughBlock, scoredAtUtc }) {
  assertOrdered(checkpoints, exitRows)
  const scoredMs = Date.parse(scoredAtUtc)
  if (!Number.isSafeInteger(scoredMs) || scoredMs < Date.parse(issue.issuedAtUtc))
    throw new Error('Invalid duration score clock')
  const available = checkpoints.filter(
    (row) => Date.parse(row.checkpoint.captureEndUtc) <= scoredMs,
  )
  const anchorIndex = available.findIndex(
    (row) => row.checkpoint.block.number === issue.block.number,
  )
  const endIndex = available.findIndex((row) => row.checkpoint.block.number === throughBlock)
  if (
    anchorIndex < 0 ||
    endIndex < anchorIndex ||
    available[anchorIndex].checkpoint.block.hash !== issue.block.hash
  )
    throw new Error('Duration score boundary mismatch')
  const prefix = available.slice(anchorIndex, endIndex + 1)
  const allowed = new Set(prefix.map((row) => row.checkpoint.block.number))
  const futureExits = exitRows.filter(
    (row) =>
      allowed.has(row.issue.checkpoint.block.number) &&
      Date.parse(row.issue.captureEndUtc) <= scoredMs,
  )
  const byBlock = new Map(futureExits.map((row) => [row.issue.checkpoint.block.number, row]))
  if (classification(byBlock.get(issue.block.number), plan).type !== 'success')
    throw new Error('Duration score anchor is not executable')
  let lastSuccess = issue.block
  let firstLoss = null
  let recovery = null
  let censor = null
  for (const row of prefix.slice(1)) {
    const block = row.checkpoint.block
    const exit = byBlock.get(block.number)
    const state = classification(exit, plan)
    if (
      state.reason === 'missing_exit_observation' &&
      scoredMs <= (block.timestamp + MAX_AGE_SECONDS) * 1000
    )
      throw new Error('Missing exit sample is not yet closed')
    if (!firstLoss && !censor) {
      const previousShares = byBlock.get(lastSuccess.number)?.issue.result.balanceSharesRaw
      const currentShares = exit?.issue.result.balanceSharesRaw
      const attrition =
        (state.type === 'success' || state.type === 'revert') &&
        previousShares !== null &&
        currentShares !== null &&
        BigInt(currentShares) < BigInt(previousShares)
      if (state.type === 'censor' || attrition)
        censor = {
          reason: attrition ? 'share_attrition' : state.reason,
          block,
          lastCleanSuccessBlock: lastSuccess.number,
        }
      else if (state.type === 'revert')
        firstLoss = {
          intervalStartBlock: lastSuccess.number,
          intervalEndBlock: block.number,
          lowerSeconds: lastSuccess.timestamp - issue.block.timestamp,
          upperSeconds: block.timestamp - issue.block.timestamp,
        }
      else lastSuccess = block
    } else if (firstLoss && !recovery && state.type === 'success')
      recovery = { block: block.number, blockUtc: iso(block.timestamp) }
  }
  return seal({
    study: `${STUDY}-score-v1`,
    issueSha256: issue.sha256,
    scoredAtUtc,
    through: checkpointRef(available[endIndex]),
    futureSource: {
      checkpoints: prefix.slice(1).map(checkpointRef),
      exitIssues: futureExits
        .filter((row) => row.issue.checkpoint.block.number > issue.block.number)
        .map(exitRef),
    },
    observed: firstLoss
      ? {
          status: recovery ? 'first_loss_with_later_recovery' : 'first_loss_observed',
          firstLoss,
          recovery,
        }
      : censor
        ? { status: 'right_censored', censor }
        : {
            status: 'right_censored',
            reason: 'still_successful_at_sampled_blocks',
            throughBlock,
            observedSeconds: available[endIndex].checkpoint.block.timestamp - issue.block.timestamp,
          },
    caveat:
      'First loss is sampled and interval censored. Right censoring, success, or recovery is not a continuous exit guarantee or forecast probability.',
  })
}

function readSealed(path) {
  const bytes = readFileSync(path)
  const value = JSON.parse(bytes)
  if (
    value.sha256 !== sha(JSON.stringify(unsigned(value))) ||
    !bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))
  )
    throw new Error('Duration artifact seal or physical bytes mismatch')
  return value
}

function immutableWrite(path, artifact, stat = statfsSync) {
  const bytes = `${JSON.stringify(artifact)}\n`
  let ancestor = dirname(path)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('Duration disk reserve reached')
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

export function readSources({
  checkpointOut = CHECKPOINT_OUT,
  exitOut = EXIT_OUT,
  planOut = PLAN_OUT,
  seedOut,
  identity = sourceIdentity(),
  nowMs = Date.now(),
} = {}) {
  const sourceOptions = { checkpointOut, identity, ...(seedOut ? { seedOut } : {}) }
  const plan = readPlan({ out: planOut, sourceOptions, nowMs })
  if (!plan) return null
  const planBytes = readFileSync(join(planOut, 'plan.json'))
  if (!planBytes.equals(Buffer.from(`${JSON.stringify(plan)}\n`)))
    throw new Error('Duration plan physical bytes mismatch')
  const verified = verifyExits({ out: exitOut, planOut, checkpointOut, seedOut, nowMs })
  const checkpoints = readValidatedCheckpoints({ out: checkpointOut, identity })
  const dir = join(exitOut, 'issues')
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  if (files.length !== verified.count) throw new Error('Exit source changed during duration read')
  const exitSources = { plan, planBytes, checkpoints, identity }
  const exitRows = files.map((filename) => {
    const bytes = readFileSync(join(dir, filename))
    const issue = validateExitIssue(JSON.parse(bytes), { sources: exitSources, nowMs })
    if (
      filename !== nameFor(issue.checkpoint.block) ||
      !bytes.equals(Buffer.from(`${JSON.stringify(issue)}\n`))
    )
      throw new Error('Exit issue physical bytes or filename mismatch')
    return { filename, physicalSha256: sha(bytes), issue }
  })
  assertOrdered(checkpoints, exitRows)
  return { plan, planPhysicalSha256: sha(planBytes), checkpoints, exitRows }
}

export function verify({ out = OUT, sources = readSources(), now = () => new Date() } = {}) {
  const issuesDir = join(out, 'issues')
  const scoresDir = join(out, 'scores')
  const issues = existsSync(issuesDir)
    ? readdirSync(issuesDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const scores = existsSync(scoresDir)
    ? readdirSync(scoresDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  if (!sources) {
    if (issues.length || scores.length) throw new Error('Duration artifacts exist without plan')
    return { status: 'unavailable', reason: 'no_plan', issues: 0, scores: 0 }
  }
  const byName = new Map()
  for (const filename of issues) {
    const saved = readSealed(join(issuesDir, filename))
    if (
      filename !== nameFor(saved.block) ||
      byName.has(filename) ||
      Date.parse(saved.issuedAtUtc) > now().getTime()
    )
      throw new Error('Duration issue filename or time mismatch')
    const expected = buildIssue({
      ...sources,
      atBlock: saved.block.number,
      issuedAtUtc: saved.issuedAtUtc,
    })
    if (JSON.stringify(saved) !== JSON.stringify(expected))
      throw new Error('Duration issue as-of replay mismatch')
    byName.set(filename, saved)
  }
  for (const filename of scores) {
    const match = /^(\d{12}-[0-9a-f]{64}\.json)\.through-(\d{12})\.json$/.exec(filename)
    const issue = byName.get(match?.[1])
    const saved = readSealed(join(scoresDir, filename))
    if (
      !issue ||
      Number(match[2]) !== Number(saved.through.filename.slice(0, 12)) ||
      Date.parse(saved.scoredAtUtc) > now().getTime()
    )
      throw new Error('Duration score filename or time mismatch')
    const expected = scoreIssue({
      issue,
      ...sources,
      throughBlock: Number(match[2]),
      scoredAtUtc: saved.scoredAtUtc,
    })
    if (JSON.stringify(saved) !== JSON.stringify(expected))
      throw new Error('Duration score as-of replay mismatch')
  }
  return { status: 'verified', issues: issues.length, scores: scores.length }
}

export function issueLatest({
  out = OUT,
  sources = readSources(),
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  if (!sources) return { status: 'unavailable', reason: 'no_plan' }
  verify({ out, sources, now })
  const latest = sources.checkpoints.at(-1)
  if (!latest) return { status: 'unavailable', reason: 'no_checkpoint' }
  const exit = sources.exitRows.find(
    (row) => row.issue.checkpoint.block.number === latest.checkpoint.block.number,
  )
  if (classification(exit, sources.plan).type !== 'success')
    return { status: 'unavailable', reason: 'latest_direct_exit_not_clean_success' }
  const path = join(out, 'issues', nameFor(latest.checkpoint.block))
  if (existsSync(path)) return { status: 'unchanged', path }
  const issue = buildIssue({
    ...sources,
    atBlock: latest.checkpoint.block.number,
    issuedAtUtc: now().toISOString(),
  })
  immutableWrite(path, issue, stat)
  return { status: 'issued', path, baseline: issue.baseline.status }
}

export function scoreLatest({
  out = OUT,
  sources = readSources(),
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  if (!sources) return { status: 'unavailable', reason: 'no_plan' }
  verify({ out, sources, now })
  const latest = sources.checkpoints.at(-1)
  if (!latest) return { status: 'unavailable', reason: 'no_checkpoint' }
  const issueDir = join(out, 'issues')
  const files = existsSync(issueDir)
    ? readdirSync(issueDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  let scored = 0
  for (const name of files) {
    const issue = readSealed(join(issueDir, name))
    const path = join(
      out,
      'scores',
      `${name}.through-${String(latest.checkpoint.block.number).padStart(12, '0')}.json`,
    )
    if (existsSync(path)) continue
    const score = scoreIssue({
      issue,
      ...sources,
      throughBlock: latest.checkpoint.block.number,
      scoredAtUtc: now().toISOString(),
    })
    immutableWrite(path, score, stat)
    scored++
  }
  return { status: scored ? 'scored' : 'unchanged', scored }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2] ?? '--verify'
    if (!['--run', '--score', '--verify'].includes(mode) || process.argv.length > 3)
      throw new Error('Invalid mode')
    const result = mode === '--run' ? issueLatest() : mode === '--score' ? scoreLatest() : verify()
    console.log(JSON.stringify(result))
  } catch {
    console.error('sUSDS holder duration research failed')
    process.exitCode = 1
  }
}
