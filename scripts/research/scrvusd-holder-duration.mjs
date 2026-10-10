// Prospective, holder-executable first-loss duration research. No alerts or transactions.
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
  OUT as QUOTE_OUT,
  readValidatedCheckpoints,
  RESERVE_BYTES,
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

export const STUDY = 'scrvusd-holder-executable-duration-v1'
export const STUDY_V2 = 'scrvusd-holder-executable-duration-v2'
export const OUT = resolve('data/research/venue-signals/scrvusd-holder-duration')
export const MAX_ISSUE_LAG_SECONDS = 3600
export const MIN_COMPLETE_EPISODES = 10
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _sha256, ...payload }) => payload
const iso = (seconds) => new Date(seconds * 1000).toISOString()
const filenameFor = (row) =>
  `${String(row.checkpoint.block.number).padStart(12, '0')}-${row.checkpoint.block.hash.slice(2)}.json`
const quoteRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.checkpoint.sha256,
  physicalSha256: row.physicalSha256,
})

function cleanSuccess(row) {
  const result = row?.issue.result
  return (
    result?.status === 'success' &&
    result.maxWithdrawAssetsRaw !== null &&
    result.balanceSharesRaw !== null &&
    result.previewSharesRaw !== null &&
    BigInt(result.maxWithdrawAssetsRaw) >= BigInt(row.issue.rawCrvUsd) &&
    BigInt(result.balanceSharesRaw) >= BigInt(result.previewSharesRaw)
  )
}
const holderRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.issue.sha256,
  physicalSha256: row.physicalSha256,
})

function requireOrdered(checkpoints, holderRows) {
  for (let i = 1; i < checkpoints.length; i++) {
    if (
      checkpoints[i - 1].checkpoint.block.number >= checkpoints[i].checkpoint.block.number ||
      checkpoints[i - 1].checkpoint.block.timestamp >= checkpoints[i].checkpoint.block.timestamp
    )
      throw new Error('Quote chronology is not strictly increasing')
  }
  const known = new Map(checkpoints.map((row) => [row.checkpoint.block.number, row]))
  const seen = new Set()
  for (const row of holderRows) {
    const block = row.issue.checkpoint.block
    if (seen.has(block.number) || known.get(block.number)?.checkpoint.block.hash !== block.hash)
      throw new Error('Holder row does not bind exactly one quote')
    seen.add(block.number)
  }
}

function terminalReason(previous, current) {
  if (!current) return 'missing_holder_observation'
  const result = current.issue.result
  if (result.status === 'provider_error') return 'provider_ambiguity'
  const before = previous.issue.result.balanceSharesRaw
  const after = result.balanceSharesRaw
  const preview = result.previewSharesRaw
  if (before === null || after === null || preview === null) return 'holder_diagnostics_unavailable'
  if (BigInt(after) < BigInt(before) || BigInt(after) < BigInt(preview))
    return 'share_attrition_or_insufficient_shares'
  if (result.status === 'success' && !cleanSuccess(current))
    return 'inconsistent_success_diagnostics'
  return null
}

// One baseline episode ends at its first clean revert, ambiguity, share loss, or missed sample.
// A later success is a recovery/new episode; it cannot repair the earlier episode.
export function completedEpisodes({ checkpoints, holderRows, beforeBlock = Infinity }) {
  requireOrdered(checkpoints, holderRows)
  const byBlock = new Map(holderRows.map((row) => [row.issue.checkpoint.block.number, row]))
  const episodes = []
  let start = null
  let previous = null
  for (const quote of checkpoints) {
    const block = quote.checkpoint.block
    if (block.number >= beforeBlock) break
    const current = byBlock.get(block.number)
    if (!start) {
      if (cleanSuccess(current)) start = current
      previous = current ?? null
      continue
    }
    const reason = terminalReason(previous, current)
    if (reason) {
      start = cleanSuccess(current) ? current : null
    } else if (current.issue.result.status === 'revert') {
      episodes.push({
        startBlock: start.issue.checkpoint.block.number,
        endBlock: block.number,
        lowerSeconds:
          previous.issue.checkpoint.block.timestamp - start.issue.checkpoint.block.timestamp,
        upperSeconds: block.timestamp - start.issue.checkpoint.block.timestamp,
      })
      start = null
    } else if (current.issue.result.status !== 'success') {
      start = null
    }
    previous = current ?? null
  }
  return episodes
}

function baseline({ checkpoints, holderRows, beforeBlock }) {
  const episodes = completedEpisodes({ checkpoints, holderRows, beforeBlock })
  if (episodes.length < MIN_COMPLETE_EPISODES)
    return {
      status: 'unavailable',
      reason: 'insufficient_clean_prior_episodes',
      completeEpisodes: episodes.length,
      requiredEpisodes: MIN_COMPLETE_EPISODES,
    }
  const sorted = episodes.map((row) => row.upperSeconds).sort((a, b) => a - b)
  return {
    status: 'research_only',
    completeEpisodes: episodes.length,
    observedUpperSeconds: {
      min: sorted[0],
      median: sorted[Math.floor((sorted.length - 1) / 2)],
      max: sorted.at(-1),
    },
    caveat:
      'Historical sampled first-revert intervals for this one selected holder; not a calibrated probability, continuous survival estimate, or future exit guarantee.',
  }
}

// Every clean success begins or extends exposure. Keep all starts, including
// ongoing and censored ones; completed losses alone are a selected sample.
export function asOfRiskSet({ checkpoints, holderRows, throughBlock, issuedAtUtc }) {
  requireOrdered(checkpoints, holderRows)
  const issuedMs = Date.parse(issuedAtUtc)
  if (!Number.isFinite(issuedMs)) throw new Error('Invalid risk-set clock')
  const asOfQuotes = checkpoints.filter(
    (row) =>
      row.checkpoint.block.number <= throughBlock &&
      Date.parse(row.checkpoint.captureEndUtc) <= issuedMs,
  )
  const quoteByBlock = new Map(asOfQuotes.map((row) => [row.checkpoint.block.number, row]))
  if (!quoteByBlock.has(throughBlock)) throw new Error('Risk-set anchor unavailable as of issue')
  const byBlock = new Map(
    holderRows
      .filter(
        (row) =>
          quoteByBlock.has(row.issue.checkpoint.block.number) &&
          Date.parse(row.issue.captureEndUtc) <= issuedMs,
      )
      .map((row) => [row.issue.checkpoint.block.number, row]),
  )
  const schedule = asOfQuotes.map((quote) => {
    const block = quote.checkpoint.block
    const holder = byBlock.get(block.number)
    return {
      block: block.number,
      blockUtc: iso(block.timestamp),
      quote: quoteRef(quote),
      quoteCaptureEndUtc: quote.checkpoint.captureEndUtc,
      holderIssue: holder ? holderRef(holder) : null,
      holderCaptureEndUtc: holder?.issue.captureEndUtc ?? null,
      holderStatus: holder?.issue.result.status ?? 'missing',
    }
  })
  const episodes = []
  let active = null
  let previous = null
  for (const sample of schedule) {
    const current = byBlock.get(sample.block)
    const timestamp = quoteByBlock.get(sample.block).checkpoint.block.timestamp
    if (!active) {
      if (cleanSuccess(current)) {
        active = {
          startBlock: sample.block,
          startUtc: sample.blockUtc,
          startHolderIssue: sample.holderIssue,
          sampleBlocks: [sample.block],
        }
      }
      previous = current ?? null
      continue
    }
    active.sampleBlocks.push(sample.block)
    const reason = terminalReason(previous, current)
    if (reason) {
      const lastCleanBlock = previous.issue.checkpoint.block
      episodes.push({
        ...active,
        outcome: 'censored',
        censorReason:
          reason === 'missing_holder_observation' &&
          issuedMs <= (timestamp + MAX_ISSUE_LAG_SECONDS) * 1000
            ? 'pending_holder_observation'
            : reason,
        lastCleanSuccessBlock: lastCleanBlock.number,
        observedLowerSeconds:
          lastCleanBlock.timestamp - quoteByBlock.get(active.startBlock).checkpoint.block.timestamp,
        censorAtBlock: sample.block,
        censorAtUtc: sample.blockUtc,
      })
      active = cleanSuccess(current)
        ? {
            startBlock: sample.block,
            startUtc: sample.blockUtc,
            startHolderIssue: sample.holderIssue,
            sampleBlocks: [sample.block],
          }
        : null
    } else if (current.issue.result.status === 'revert') {
      const startTime = quoteByBlock.get(active.startBlock).checkpoint.block.timestamp
      episodes.push({
        ...active,
        outcome: 'first_loss_interval',
        intervalStartBlock: previous.issue.checkpoint.block.number,
        intervalEndBlock: sample.block,
        lowerSeconds: previous.issue.checkpoint.block.timestamp - startTime,
        upperSeconds: timestamp - startTime,
      })
      active = null
    }
    previous = current ?? null
  }
  if (active) {
    const last = quoteByBlock.get(throughBlock)
    const start = quoteByBlock.get(active.startBlock)
    episodes.push({
      ...active,
      outcome: 'ongoing_right_censor',
      lastCleanSuccessBlock: throughBlock,
      observedLowerSeconds: last.checkpoint.block.timestamp - start.checkpoint.block.timestamp,
    })
  }
  const counts = {
    firstLossIntervals: episodes.filter((row) => row.outcome === 'first_loss_interval').length,
    ongoingRightCensors: episodes.filter((row) => row.outcome === 'ongoing_right_censor').length,
    ambiguousCensors: episodes.filter((row) => row.outcome === 'censored').length,
  }
  return {
    status: 'uncalibrated',
    reason: 'single_holder_no_independent_validation',
    holderCount: 1,
    vaultCount: 1,
    episodeCount: episodes.length,
    counts,
    observationSchedule: schedule,
    episodes,
    caveat:
      'Sampled loss intervals and censoring are an as-of research risk set, not a likelihood, point duration, continuous exit guarantee, or calibrated forecast.',
  }
}

// Identification bounds for a caller-chosen horizon. These are fractions of
// dependent sampled episodes, never a calibrated persistence probability.
export function riskSetBoundsAtHorizon(riskSet, horizonSeconds) {
  if (!Number.isFinite(horizonSeconds) || horizonSeconds < 0)
    throw new Error('Invalid duration horizon')
  const episodes = riskSet.episodes
  if (!episodes?.length) return { status: 'unavailable', reason: 'no_exposure_episodes' }
  let definitelyAlive = 0
  let definitelyFailed = 0
  let ambiguous = 0
  for (const episode of episodes) {
    if (episode.outcome === 'first_loss_interval') {
      if (horizonSeconds <= episode.lowerSeconds) definitelyAlive++
      else if (horizonSeconds >= episode.upperSeconds) definitelyFailed++
      else ambiguous++
    } else if (episode.outcome === 'ongoing_right_censor' || episode.outcome === 'censored') {
      if (horizonSeconds <= episode.observedLowerSeconds) definitelyAlive++
      else ambiguous++
    } else throw new Error('Unknown risk-set episode outcome')
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
      'Bounds classify dependent sampled episodes since their first success, not remaining time from the current anchor; they are not a future holder probability, survival estimate, or guarantee.',
  }
}

export function buildIssue({
  plan,
  selectionSha256,
  checkpoints,
  holderRows,
  atBlock,
  issuedAtUtc,
  version = 2,
}) {
  requireOrdered(checkpoints, holderRows)
  const quote = checkpoints.find((row) => row.checkpoint.block.number === atBlock)
  const holder = holderRows.find((row) => row.issue.checkpoint.block.number === atBlock)
  if (
    !quote ||
    !holder ||
    !cleanSuccess(holder) ||
    holder.issue.planSha256 !== plan.sha256 ||
    holder.issue.holder !== plan.holder ||
    holder.issue.rawCrvUsd !== plan.rawCrvUsd ||
    !/^[0-9a-f]{64}$/.test(selectionSha256)
  )
    throw new Error('Ineligible holder-executable issue anchor')
  const issuedMs = Date.parse(issuedAtUtc)
  const captureMs = Date.parse(holder.issue.captureEndUtc)
  const availableQuotes = checkpoints.filter(
    (row) => Date.parse(row.checkpoint.captureEndUtc) <= issuedMs,
  )
  const availableBlocks = new Set(availableQuotes.map((row) => row.checkpoint.block.number))
  const availableHolders = holderRows.filter(
    (row) =>
      availableBlocks.has(row.issue.checkpoint.block.number) &&
      Date.parse(row.issue.captureEndUtc) <= issuedMs,
  )
  if (
    !Number.isFinite(issuedMs) ||
    Date.parse(quote.checkpoint.captureEndUtc) > issuedMs ||
    issuedMs < captureMs ||
    issuedMs - captureMs > MAX_ISSUE_LAG_SECONDS * 1000 ||
    availableQuotes.some(
      (row) =>
        row.checkpoint.block.number > atBlock && row.checkpoint.block.timestamp * 1000 <= issuedMs,
    )
  )
    throw new Error('Issue is late or after a future quote checkpoint')
  if (![1, 2].includes(version)) throw new Error('Unsupported holder duration issue version')
  const asOfQuotes = availableQuotes.filter((row) => row.checkpoint.block.number <= atBlock)
  const asOfHolders = availableHolders.filter((row) => row.issue.checkpoint.block.number <= atBlock)
  return seal({
    study: version === 1 ? STUDY : STUDY_V2,
    kind: 'prospective-holder-first-loss-baseline',
    issuedAtUtc,
    planSha256: plan.sha256,
    selectionSha256,
    holder: plan.holder,
    rawCrvUsd: plan.rawCrvUsd,
    block: quote.checkpoint.block,
    quote: quoteRef(quote),
    holderIssue: holderRef(holder),
    priorSource: {
      quotes: availableQuotes.filter((row) => row.checkpoint.block.number < atBlock).map(quoteRef),
      holderIssues: availableHolders
        .filter((row) => row.issue.checkpoint.block.number < atBlock)
        .map(holderRef),
    },
    baseline:
      version === 1
        ? baseline({
            checkpoints: availableQuotes,
            holderRows: availableHolders,
            beforeBlock: atBlock,
          })
        : asOfRiskSet({
            checkpoints: asOfQuotes,
            holderRows: asOfHolders,
            throughBlock: atBlock,
            issuedAtUtc,
          }),
    caveats: [
      'One selected holder and fixed withdrawal size; read-only pinned simulation is not a transaction guarantee.',
      'The issue uses only source observations before or at its anchor; local issuance time is an operator attestation.',
      'No nominal Curve quote is substituted for holder-executable exit ability.',
    ],
  })
}

export function scoreIssue({ issue, checkpoints, holderRows, throughBlock, scoredAtUtc }) {
  requireOrdered(checkpoints, holderRows)
  const scoredMs = Date.parse(scoredAtUtc)
  if (!Number.isFinite(scoredMs) || scoredMs < Date.parse(issue.issuedAtUtc))
    throw new Error('Invalid score clock')
  const availableQuotes = checkpoints.filter(
    (row) => Date.parse(row.checkpoint.captureEndUtc) <= scoredMs,
  )
  const availableBlocks = new Set(availableQuotes.map((row) => row.checkpoint.block.number))
  const availableHolders = holderRows.filter(
    (row) =>
      availableBlocks.has(row.issue.checkpoint.block.number) &&
      Date.parse(row.issue.captureEndUtc) <= scoredMs,
  )
  const anchor = availableQuotes.findIndex(
    (row) => row.checkpoint.block.number === issue.block.number,
  )
  const end = availableQuotes.findIndex((row) => row.checkpoint.block.number === throughBlock)
  if (
    anchor < 0 ||
    end < anchor ||
    availableQuotes[anchor].checkpoint.block.hash !== issue.block.hash
  )
    throw new Error('Score boundary does not bind issue')
  const prefix = availableQuotes.slice(anchor, end + 1)
  const byBlock = new Map(availableHolders.map((row) => [row.issue.checkpoint.block.number, row]))
  let previous = byBlock.get(issue.block.number)
  if (!previous || previous.issue.result.status !== 'success')
    throw new Error('Anchor is not a holder success')
  let firstLoss = null
  let recovery = null
  let censor = null
  for (const quote of prefix.slice(1)) {
    const current = byBlock.get(quote.checkpoint.block.number)
    if (!firstLoss && !censor) {
      const reason = terminalReason(previous, current)
      if (reason)
        censor = {
          reason,
          block: quote.checkpoint.block,
          lastCleanSuccessBlock: previous.issue.checkpoint.block.number,
        }
      else if (current.issue.result.status === 'revert') {
        firstLoss = {
          intervalStartBlock: previous.issue.checkpoint.block.number,
          intervalEndBlock: quote.checkpoint.block.number,
          lowerSeconds: previous.issue.checkpoint.block.timestamp - issue.block.timestamp,
          upperSeconds: quote.checkpoint.block.timestamp - issue.block.timestamp,
        }
      }
    } else if (firstLoss && !recovery && cleanSuccess(current)) {
      recovery = {
        block: quote.checkpoint.block.number,
        blockUtc: iso(quote.checkpoint.block.timestamp),
      }
    }
    previous = current ?? previous
  }
  const observed = firstLoss
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
          observedSeconds: availableQuotes[end].checkpoint.block.timestamp - issue.block.timestamp,
        }
  // An absent holder sample is only terminal after a valid pinned holder issue
  // can no longer be added under the source ledger's one-hour age bound.
  const unresolved = prefix
    .slice(1)
    .find(
      (row) =>
        !byBlock.has(row.checkpoint.block.number) &&
        scoredMs <= (row.checkpoint.block.timestamp + MAX_ISSUE_LAG_SECONDS) * 1000,
    )
  if (unresolved) throw new Error('Missing holder sample is not yet closed')
  return seal({
    study: `${issue.study}-score-v1`,
    issueSha256: issue.sha256,
    scoredAtUtc,
    through: quoteRef(availableQuotes[end]),
    futureSource: {
      quotes: prefix.slice(1).map(quoteRef),
      holderIssues: availableHolders
        .filter(
          (row) =>
            row.issue.checkpoint.block.number > issue.block.number &&
            row.issue.checkpoint.block.number <= throughBlock,
        )
        .map(holderRef),
    },
    observed,
    caveat:
      'Sampled first loss is interval-censored; a right-censor or recovery is not a continuous exit guarantee or causal attribution.',
  })
}

function guard(path, stat = statfsSync, extra = 0) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - extra < RESERVE_BYTES)
    throw new Error('Holder duration disk reserve reached')
}

function immutableWrite(path, artifact, stat = statfsSync) {
  const bytes = `${JSON.stringify(artifact)}\n`
  guard(dirname(path), stat, Buffer.byteLength(bytes))
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
    linkSync(temp, path)
  } finally {
    if (existsSync(temp)) unlinkSync(temp)
  }
}

function readSealed(path) {
  const bytes = readFileSync(path)
  const value = JSON.parse(bytes)
  if (value.sha256 !== sha(JSON.stringify(unsigned(value))))
    throw new Error('Holder duration artifact seal mismatch')
  return value
}

export function readSources({
  holderOut = HOLDER_OUT,
  quoteOut = QUOTE_OUT,
  seedOut = SEED_OUT,
  selectionOut = SELECTION_OUT,
  identity = sourceIdentity(),
  now = () => new Date(),
} = {}) {
  const selection = verifySelection({
    out: selectionOut,
    sourceOptions: { planOut: holderOut, seedOut, quoteOut, identity },
    nowMs: now().getTime(),
  })
  if (selection.status !== 'verified') throw new Error('Holder selection certificate unavailable')
  const plan = readPlan({ out: holderOut, identity })
  if (!plan) throw new Error('Holder plan unavailable')
  const holderVerified = verifyHolder({ out: holderOut, quoteOut, identity, now })
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  const dir = join(holderOut, 'issues')
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  if (files.length !== holderVerified.count)
    throw new Error('Holder source changed during duration read')
  const holderRows = files.map((filename) => {
    const bytes = readFileSync(join(dir, filename))
    const issue = JSON.parse(bytes)
    validateIssue(issue, { plan, checkpoints, nowUtc: now().toISOString() })
    if (filename !== filenameFor({ checkpoint: issue.checkpoint }))
      throw new Error('Holder filename mismatch')
    return { filename, issue, physicalSha256: sha(bytes) }
  })
  requireOrdered(checkpoints, holderRows)
  return { plan, selectionSha256: selection.sha256, checkpoints, holderRows }
}

export function verify({ out = OUT, sources = readSources(), now = () => new Date() } = {}) {
  const issueDir = join(out, 'issues')
  const scoreDir = join(out, 'scores')
  const issues = existsSync(issueDir)
    ? readdirSync(issueDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const scores = existsSync(scoreDir)
    ? readdirSync(scoreDir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  const byIssue = new Map()
  for (const filename of issues) {
    const saved = readSealed(join(issueDir, filename))
    if (
      filename !==
        `${String(saved.block?.number).padStart(12, '0')}-${saved.block?.hash?.slice(2)}.json` ||
      byIssue.has(saved.block.number)
    )
      throw new Error('Holder duration issue filename or duplicate')
    const expected = buildIssue({
      ...sources,
      atBlock: saved.block.number,
      issuedAtUtc: saved.issuedAtUtc,
      version: saved.study === STUDY ? 1 : saved.study === STUDY_V2 ? 2 : 0,
    })
    if (
      JSON.stringify(saved) !== JSON.stringify(expected) ||
      Date.parse(saved.issuedAtUtc) > now().getTime()
    )
      throw new Error('Holder duration issue as-of replay mismatch')
    byIssue.set(filename, saved)
  }
  for (const filename of scores) {
    const saved = readSealed(join(scoreDir, filename))
    const [issueName, blockText] = filename.split('.through-')
    const issue = byIssue.get(issueName)
    if (
      !issue ||
      filename !== `${issueName}.through-${String(saved.through?.filename).slice(0, 12)}.json` ||
      Number(blockText?.slice(0, 12)) !== Number(saved.through.filename.slice(0, 12))
    )
      throw new Error('Holder duration score filename or missing issue')
    const expected = scoreIssue({
      issue,
      ...sources,
      throughBlock: Number(saved.through.filename.slice(0, 12)),
      scoredAtUtc: saved.scoredAtUtc,
    })
    if (
      JSON.stringify(saved) !== JSON.stringify(expected) ||
      Date.parse(saved.scoredAtUtc) > now().getTime()
    )
      throw new Error('Holder duration score as-of replay mismatch')
  }
  return { issues: issues.length, scores: scores.length }
}

export function issueLatest({
  out = OUT,
  sources = readSources(),
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  verify({ out, sources, now })
  const latest = sources.checkpoints.at(-1)
  if (!latest) return { status: 'unavailable', reason: 'no_quote_checkpoint' }
  const holder = sources.holderRows.find(
    (row) => row.issue.checkpoint.block.number === latest.checkpoint.block.number,
  )
  if (holder?.issue.result.status !== 'success')
    return { status: 'unavailable', reason: 'latest_holder_exit_not_success' }
  const path = join(out, 'issues', filenameFor(latest))
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
  verify({ out, sources, now })
  const latest = sources.checkpoints.at(-1)
  if (!latest) return { status: 'unavailable', reason: 'no_quote_checkpoint' }
  const dir = join(out, 'issues')
  const issueFiles = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  let scored = 0
  for (const filename of issueFiles) {
    const issue = readSealed(join(dir, filename))
    const path = join(
      out,
      'scores',
      `${filename}.through-${String(latest.checkpoint.block.number).padStart(12, '0')}.json`,
    )
    if (existsSync(path)) continue
    const result = scoreIssue({
      issue,
      ...sources,
      throughBlock: latest.checkpoint.block.number,
      scoredAtUtc: now().toISOString(),
    })
    immutableWrite(path, result, stat)
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
    console.error('Holder duration research failed')
    process.exitCode = 1
  }
}
