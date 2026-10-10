// Prospective sampled first-loss duration for the sealed scrvUSD holder-size cohort.
// Research artifacts only: these are dependent observations, not exit alerts.
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
  sourceIdentity,
} from './curve-prospective-quote.mjs'
import { OUT as PLAN_OUT, readPlan } from './scrvusd-cohort-plan.mjs'
import {
  OUT as OBSERVE_OUT,
  MAX_AGE_MS,
  validateIssue as validateObservation,
  validateSequence,
  verify as verifyObservation,
} from './scrvusd-cohort-observe.mjs'
import { OUT as SEED_OUT } from './scrvusd-cohort-seed.mjs'

export const STUDY = 'scrvusd-cohort-executable-duration-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-cohort-duration')
const RESERVE_BYTES = 1_073_741_824
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const unsigned = ({ sha256: _sha256, ...body }) => body
const utc = (seconds) => new Date(seconds * 1000).toISOString()
const pair = (member) => ({ holder: member.holder, rawCrvUsd: member.rawCrvUsd })
const roster = (plan) =>
  plan.strata.flatMap((stratum) =>
    stratum.holders.map((holder) => ({ holder, rawCrvUsd: stratum.rawCrvUsd })),
  )
const quoteRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.checkpoint.sha256,
  physicalSha256: row.physicalSha256,
  block: row.checkpoint.block,
})
const observationRef = (row) => ({
  filename: row.filename,
  logicalSha256: row.issue.sha256,
  physicalSha256: row.physicalSha256,
})
const filenameFor = (row) =>
  `${String(row.checkpoint.block.number).padStart(12, '0')}-${row.checkpoint.block.hash.slice(2)}.json`
const scoreFilename = (issueFilename, throughBlock) =>
  `${issueFilename}.through-${String(throughBlock).padStart(12, '0')}.json`
const eligible = (quote, plan) =>
  quote.checkpoint.block.number > plan.checkpoint.block.number &&
  quote.checkpoint.block.timestamp * 1000 > Date.parse(plan.createdUtc)

function assertSources({ plan, checkpoints, observations }) {
  if (!plan?.sha256 || !plan.physicalSha256) throw new Error('Cohort plan seal unavailable')
  for (let i = 1; i < checkpoints.length; i++) {
    if (
      checkpoints[i - 1].checkpoint.block.number >= checkpoints[i].checkpoint.block.number ||
      checkpoints[i - 1].checkpoint.block.timestamp >= checkpoints[i].checkpoint.block.timestamp
    )
      throw new Error('Quote chronology invalid')
  }
  const byBlock = new Map(checkpoints.map((row) => [row.checkpoint.block.number, row]))
  const seen = new Set()
  for (const row of observations) {
    const block = row.issue.checkpoint.block
    if (
      seen.has(block.number) ||
      byBlock.get(block.number)?.checkpoint.block.hash !== block.hash ||
      row.issue.planSha256 !== plan.sha256 ||
      row.issue.planPhysicalSha256 !== plan.physicalSha256 ||
      row.issue.results.length !== roster(plan).length
    )
      throw new Error('Cohort observation provenance invalid')
    seen.add(block.number)
  }
  validateSequence(
    observations.map((row) => row.issue),
    checkpoints,
    plan,
  )
}

function cleanSuccess(member) {
  return (
    member?.status === 'success' &&
    member.holderCode === '0x' &&
    member.balanceSharesRaw !== null &&
    member.maxWithdrawAssetsRaw !== null &&
    member.previewSharesRaw !== null &&
    member.sharesBurnedRaw !== null &&
    BigInt(member.maxWithdrawAssetsRaw) >= BigInt(member.rawCrvUsd) &&
    BigInt(member.balanceSharesRaw) >= BigInt(member.previewSharesRaw) &&
    BigInt(member.balanceSharesRaw) >= BigInt(member.sharesBurnedRaw)
  )
}

function terminal(previous, current) {
  if (!current) return { kind: 'censor', reason: 'missing_cohort_observation' }
  if (current.status === 'provider_error') return { kind: 'censor', reason: 'provider_ambiguity' }
  if (current.status === 'source_drift') return { kind: 'censor', reason: 'vault_source_drift' }
  if (current.status === 'holder_code_change')
    return { kind: 'censor', reason: 'holder_code_change' }
  if (
    current.balanceSharesRaw === null ||
    current.previewSharesRaw === null ||
    previous.balanceSharesRaw === null
  )
    return { kind: 'censor', reason: 'holder_diagnostics_unavailable' }
  if (
    BigInt(current.balanceSharesRaw) < BigInt(previous.balanceSharesRaw) ||
    BigInt(current.balanceSharesRaw) < BigInt(current.previewSharesRaw)
  )
    return { kind: 'censor', reason: 'share_attrition_or_insufficient_shares' }
  if (current.status === 'revert' && current.holderCode === '0x')
    return { kind: 'loss', reason: 'clean_simulated_revert' }
  if (cleanSuccess(current)) return { kind: 'alive', reason: null }
  return { kind: 'censor', reason: 'inconsistent_member_diagnostics' }
}

function schedule({ plan, checkpoints, observations, throughBlock, issuedAtUtc }) {
  assertSources({ plan, checkpoints, observations })
  const issuedMs = Date.parse(issuedAtUtc)
  if (!Number.isSafeInteger(issuedMs)) throw new Error('Invalid issue clock')
  const quotes = checkpoints.filter(
    (row) =>
      eligible(row, plan) &&
      row.checkpoint.block.number <= throughBlock &&
      Date.parse(row.checkpoint.captureEndUtc) <= issuedMs,
  )
  if (!quotes.some((row) => row.checkpoint.block.number === throughBlock))
    throw new Error('Duration anchor unavailable as of issue')
  const quoteBlocks = new Set(quotes.map((row) => row.checkpoint.block.number))
  const available = observations.filter(
    (row) =>
      quoteBlocks.has(row.issue.checkpoint.block.number) &&
      Date.parse(row.issue.captureEndUtc) <= issuedMs,
  )
  const byBlock = new Map(available.map((row) => [row.issue.checkpoint.block.number, row]))
  return quotes.map((quote) => ({
    block: quote.checkpoint.block,
    quote: quoteRef(quote),
    observation: byBlock.has(quote.checkpoint.block.number)
      ? observationRef(byBlock.get(quote.checkpoint.block.number))
      : null,
    members: byBlock.get(quote.checkpoint.block.number)?.issue.results ?? null,
  }))
}

export function asOfRiskSet(sources) {
  const { plan } = sources
  const samples = schedule(sources)
  const members = roster(plan).map((entry, index) => {
    const episodes = []
    let active = null
    let previous = null
    let previousBlock = null
    for (const sample of samples) {
      const current = sample.members?.[index] ?? null
      if (!active) {
        if (cleanSuccess(current))
          active = {
            startBlock: sample.block.number,
            startUtc: utc(sample.block.timestamp),
            startObservation: sample.observation,
            sampleBlocks: [sample.block.number],
          }
      } else {
        active.sampleBlocks.push(sample.block.number)
        const transition = terminal(previous, current)
        const startTime = samples.find((row) => row.block.number === active.startBlock).block
          .timestamp
        if (transition.kind === 'loss') {
          episodes.push({
            ...active,
            outcome: 'first_loss_interval',
            intervalStartBlock: previousBlock.number,
            intervalEndBlock: sample.block.number,
            lowerSeconds: previousBlock.timestamp - startTime,
            upperSeconds: sample.block.timestamp - startTime,
          })
          active = null
        } else if (transition.kind === 'censor') {
          episodes.push({
            ...active,
            outcome: 'censored',
            censorReason:
              transition.reason === 'missing_cohort_observation' &&
              Date.parse(sources.issuedAtUtc) <= sample.block.timestamp * 1000 + MAX_AGE_MS
                ? 'pending_cohort_observation'
                : transition.reason,
            lastCleanSuccessBlock: previousBlock.number,
            observedLowerSeconds: previousBlock.timestamp - startTime,
            censorAtBlock: sample.block.number,
          })
          active = cleanSuccess(current)
            ? {
                startBlock: sample.block.number,
                startUtc: utc(sample.block.timestamp),
                startObservation: sample.observation,
                sampleBlocks: [sample.block.number],
              }
            : null
        }
      }
      previous = current
      previousBlock = sample.block
    }
    if (active) {
      const last = samples.at(-1).block
      const startTime = samples.find((row) => row.block.number === active.startBlock).block
        .timestamp
      episodes.push({
        ...active,
        outcome: 'ongoing_right_censor',
        lastCleanSuccessBlock: last.number,
        observedLowerSeconds: last.timestamp - startTime,
      })
    }
    return {
      ...entry,
      statusAtAnchor: samples.at(-1).members?.[index]?.status ?? 'missing',
      cleanSuccessAtAnchor: cleanSuccess(samples.at(-1).members?.[index]),
      episodes,
    }
  })
  const counts = {
    firstLossIntervals: members.reduce(
      (n, member) => n + member.episodes.filter((e) => e.outcome === 'first_loss_interval').length,
      0,
    ),
    ongoingRightCensors: members.reduce(
      (n, member) => n + member.episodes.filter((e) => e.outcome === 'ongoing_right_censor').length,
      0,
    ),
    ambiguousCensors: members.reduce(
      (n, member) => n + member.episodes.filter((e) => e.outcome === 'censored').length,
      0,
    ),
  }
  return {
    status: 'uncalibrated',
    reason: counts.firstLossIntervals === 0 ? 'no_observed_first_losses' : 'dependent_sample_only',
    forecast: { status: 'unavailable', reason: 'no_independent_calibration' },
    vaultCount: 1,
    pairCount: members.length,
    distinctHolderCount: new Set(members.map((member) => member.holder)).size,
    observationSchedule: samples.map(({ block, quote, observation }) => ({
      block: block.number,
      blockUtc: utc(block.timestamp),
      quote,
      observation,
    })),
    counts,
    members,
    caveat:
      'All holder-size pairs share one vault and some holders overlap. Sampled block-time episodes are neither independent trials, a population probability, remaining-life forecast, nor a continuous exit guarantee.',
  }
}

// Caller-selected horizon since an episode's first observed success, not from now.
export function riskSetBoundsAtHorizon(riskSet, horizonSeconds) {
  if (!Number.isSafeInteger(horizonSeconds) || horizonSeconds < 0)
    throw new Error('Invalid horizon seconds')
  const episodes = riskSet.members.flatMap((member) => member.episodes)
  if (!episodes.length) return { status: 'unavailable', reason: 'no_exposure_episodes' }
  let definitelyAlive = 0
  let definitelyFailed = 0
  let ambiguous = 0
  for (const episode of episodes) {
    if (episode.outcome === 'first_loss_interval') {
      if (horizonSeconds <= episode.lowerSeconds) definitelyAlive++
      else if (horizonSeconds >= episode.upperSeconds) definitelyFailed++
      else ambiguous++
    } else if (horizonSeconds <= episode.observedLowerSeconds) definitelyAlive++
    else ambiguous++
  }
  return {
    status: 'research_only_uncalibrated',
    horizonSeconds,
    horizonOrigin: 'episode_start',
    dependentEpisodeCount: episodes.length,
    definitelyAlive,
    definitelyFailed,
    ambiguous,
    empiricalPersistenceLowerBound: definitelyAlive / episodes.length,
    empiricalPersistenceUpperBound: (definitelyAlive + ambiguous) / episodes.length,
    caveat:
      'Descriptive bounds over dependent sampled episodes only; no probability or forecast of remaining exit time.',
  }
}

export function buildIssue({ plan, checkpoints, observations, atBlock, issuedAtUtc }) {
  assertSources({ plan, checkpoints, observations })
  const issuedMs = Date.parse(issuedAtUtc)
  const quote = checkpoints.find((row) => row.checkpoint.block.number === atBlock)
  const observation = observations.find((row) => row.issue.checkpoint.block.number === atBlock)
  const availableQuotes = checkpoints.filter(
    (row) => eligible(row, plan) && Date.parse(row.checkpoint.captureEndUtc) <= issuedMs,
  )
  const availableObservations = observations.filter(
    (row) =>
      eligible(
        checkpoints.find((q) => q.checkpoint.block.number === row.issue.checkpoint.block.number),
        plan,
      ) && Date.parse(row.issue.captureEndUtc) <= issuedMs,
  )
  if (
    !Number.isSafeInteger(issuedMs) ||
    !quote ||
    !observation ||
    !eligible(quote, plan) ||
    Date.parse(observation.issue.captureEndUtc) > issuedMs ||
    issuedMs - observation.issue.checkpoint.block.timestamp * 1000 > MAX_AGE_MS ||
    availableQuotes.some((row) => row.checkpoint.block.number > atBlock) ||
    availableObservations.some((row) => row.issue.checkpoint.block.number > atBlock)
  )
    throw new Error('Ineligible or late cohort duration issue')
  const asOf = {
    plan,
    checkpoints: availableQuotes,
    observations: availableObservations,
    throughBlock: atBlock,
    issuedAtUtc,
  }
  return seal({
    study: STUDY,
    kind: 'prospective-cohort-first-loss-risk-set',
    issuedAtUtc,
    planSha256: plan.sha256,
    planPhysicalSha256: plan.physicalSha256,
    block: quote.checkpoint.block,
    quote: quoteRef(quote),
    cohortObservation: observationRef(observation),
    priorSource: {
      quotes: availableQuotes.filter((row) => row.checkpoint.block.number < atBlock).map(quoteRef),
      cohortObservations: availableObservations
        .filter((row) => row.issue.checkpoint.block.number < atBlock)
        .map(observationRef),
    },
    riskSet: asOfRiskSet(asOf),
    caveats: [
      'Each issue has the complete fixed holder-size roster; overlapping pairs and one vault are dependent.',
      'Only source captured by issue time enters its risk set; local issue time is an operator attestation.',
      'No calibrated duration, population probability, or continuous withdrawability claim.',
    ],
  })
}

export function scoreIssue({ issue, plan, checkpoints, observations, throughBlock, scoredAtUtc }) {
  assertSources({ plan, checkpoints, observations })
  const scoredMs = Date.parse(scoredAtUtc)
  if (!Number.isSafeInteger(scoredMs) || scoredMs < Date.parse(issue.issuedAtUtc))
    throw new Error('Invalid score clock')
  const availableQuotes = checkpoints.filter(
    (row) => eligible(row, plan) && Date.parse(row.checkpoint.captureEndUtc) <= scoredMs,
  )
  const quoteBlocks = new Set(availableQuotes.map((row) => row.checkpoint.block.number))
  const availableObservations = observations.filter(
    (row) =>
      quoteBlocks.has(row.issue.checkpoint.block.number) &&
      Date.parse(row.issue.captureEndUtc) <= scoredMs,
  )
  const anchorIndex = availableQuotes.findIndex(
    (row) => row.checkpoint.block.number === issue.block.number,
  )
  const endIndex = availableQuotes.findIndex((row) => row.checkpoint.block.number === throughBlock)
  if (
    issue.planSha256 !== plan.sha256 ||
    issue.planPhysicalSha256 !== plan.physicalSha256 ||
    anchorIndex < 0 ||
    endIndex < anchorIndex ||
    availableQuotes[anchorIndex].checkpoint.block.hash !== issue.block.hash
  )
    throw new Error('Score boundary does not bind issue')
  const samples = availableQuotes.slice(anchorIndex, endIndex + 1)
  const byBlock = new Map(
    availableObservations.map((row) => [row.issue.checkpoint.block.number, row]),
  )
  const anchor = byBlock.get(issue.block.number)
  if (!anchor || observationRef(anchor).logicalSha256 !== issue.cohortObservation.logicalSha256)
    throw new Error('Score anchor observation unavailable')
  const members = roster(plan).map((entry, index) => {
    const original = anchor.issue.results[index]
    if (!cleanSuccess(original))
      return { ...entry, observed: { status: 'unexposed_at_issue', anchorStatus: original.status } }
    let previous = original
    let previousBlock = issue.block
    let firstLoss = null
    let censor = null
    for (const quote of samples.slice(1)) {
      const row = byBlock.get(quote.checkpoint.block.number)
      const current = row?.issue.results[index] ?? null
      const transition = terminal(previous, current)
      if (transition.kind === 'loss') {
        firstLoss = {
          intervalStartBlock: previousBlock.number,
          intervalEndBlock: quote.checkpoint.block.number,
          lowerSeconds: previousBlock.timestamp - issue.block.timestamp,
          upperSeconds: quote.checkpoint.block.timestamp - issue.block.timestamp,
        }
        break
      }
      if (transition.kind === 'censor') {
        if (!row && scoredMs <= quote.checkpoint.block.timestamp * 1000 + MAX_AGE_MS)
          throw new Error('Missing cohort checkpoint not yet closed')
        censor = {
          reason: transition.reason,
          block: quote.checkpoint.block.number,
          lastCleanSuccessBlock: previousBlock.number,
          observedLowerSeconds: previousBlock.timestamp - issue.block.timestamp,
        }
        break
      }
      previous = current
      previousBlock = quote.checkpoint.block
    }
    return {
      ...entry,
      observed: firstLoss
        ? { status: 'first_loss_observed', firstLoss }
        : censor
          ? { status: 'right_censored', censor }
          : {
              status: 'right_censored',
              reason: 'still_successful_at_sampled_blocks',
              throughBlock,
              observedSeconds: samples.at(-1).checkpoint.block.timestamp - issue.block.timestamp,
            },
    }
  })
  return seal({
    study: `${STUDY}-score-v1`,
    issueSha256: issue.sha256,
    scoredAtUtc,
    through: quoteRef(availableQuotes[endIndex]),
    futureSource: {
      quotes: samples.slice(1).map(quoteRef),
      cohortObservations: availableObservations
        .filter(
          (row) =>
            row.issue.checkpoint.block.number > issue.block.number &&
            row.issue.checkpoint.block.number <= throughBlock,
        )
        .map(observationRef),
    },
    members,
    caveat:
      'First losses are interval sampled; ambiguous paths are censored. Overlapping holder-size pairs share one vault, so these are not independent forecast outcomes.',
  })
}

function immutableWrite(path, artifact, stat = statfsSync) {
  const bytes = `${JSON.stringify(artifact)}\n`
  let ancestor = dirname(path)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - Buffer.byteLength(bytes) < RESERVE_BYTES)
    throw new Error('Cohort duration disk reserve reached')
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
  if (
    value.sha256 !== sha(JSON.stringify(unsigned(value))) ||
    !bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`))
  )
    throw new Error('Cohort duration artifact physical or logical seal mismatch')
  return value
}

export function readSources({
  planOut = PLAN_OUT,
  observeOut = OBSERVE_OUT,
  quoteOut = QUOTE_OUT,
  seedOut = SEED_OUT,
  identity = sourceIdentity(),
  now = () => new Date(),
} = {}) {
  const plan = readPlan({
    out: planOut,
    sourceOptions: { quoteOut, seedOut, identity },
    nowMs: now().getTime(),
  })
  if (!plan) return null
  const planBytes = readFileSync(join(planOut, 'plan.json'))
  const pinnedPlan = { ...plan, physicalSha256: sha(planBytes) }
  const observed = verifyObservation({
    out: observeOut,
    planOut,
    quoteOut,
    identity,
    nowMs: now().getTime(),
  })
  if (observed.status !== 'verified') throw new Error('Cohort observer unavailable')
  const checkpoints = readValidatedCheckpoints({ out: quoteOut, identity })
  const seed = JSON.parse(readFileSync(join(seedOut, plan.seed.filename)))
  const dir = join(observeOut, 'issues')
  const names = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []
  if (names.length !== observed.count)
    throw new Error('Cohort observer changed during duration read')
  const observations = names.map((filename) => {
    const bytes = readFileSync(join(dir, filename))
    const issue = JSON.parse(bytes)
    validateObservation(issue, {
      plan: pinnedPlan,
      checkpointRows: checkpoints,
      seedVaultCodeHash: seed.vaultCodeHash,
      nowMs: now().getTime(),
    })
    if (
      filename !==
        `${String(issue.checkpoint.block.number).padStart(12, '0')}-${issue.checkpoint.block.hash.slice(2)}.json` ||
      !bytes.equals(Buffer.from(`${JSON.stringify(issue)}\n`))
    )
      throw new Error('Cohort observer physical mismatch')
    return { filename, issue, physicalSha256: sha(bytes) }
  })
  assertSources({ plan: pinnedPlan, checkpoints, observations })
  return { plan: pinnedPlan, checkpoints, observations }
}

export function verify({ out = OUT, sources = readSources(), now = () => new Date() } = {}) {
  if (!sources) return { status: 'unavailable', reason: 'no_plan', issues: 0, scores: 0 }
  const issueDir = join(out, 'issues')
  const scoreDir = join(out, 'scores')
  const issues = existsSync(issueDir)
    ? readdirSync(issueDir)
        .filter((x) => x.endsWith('.json'))
        .sort()
    : []
  const scores = existsSync(scoreDir)
    ? readdirSync(scoreDir)
        .filter((x) => x.endsWith('.json'))
        .sort()
    : []
  const byIssue = new Map()
  for (const filename of issues) {
    const saved = readSealed(join(issueDir, filename))
    const quote = sources.checkpoints.find(
      (row) => row.checkpoint.block.number === saved.block?.number,
    )
    if (!quote || filename !== filenameFor(quote) || byIssue.has(filename))
      throw new Error('Cohort duration issue filename or duplicate')
    const expected = buildIssue({
      ...sources,
      atBlock: saved.block.number,
      issuedAtUtc: saved.issuedAtUtc,
    })
    if (
      JSON.stringify(saved) !== JSON.stringify(expected) ||
      Date.parse(saved.issuedAtUtc) > now().getTime()
    )
      throw new Error('Cohort duration issue as-of replay mismatch')
    byIssue.set(filename, saved)
  }
  for (const filename of scores) {
    const saved = readSealed(join(scoreDir, filename))
    const match = /^(.+\.json)\.through-([0-9]{12})\.json$/.exec(filename)
    const issue = byIssue.get(match?.[1])
    if (!issue || filename !== scoreFilename(match[1], saved.through?.block?.number))
      throw new Error('Cohort duration score filename or missing issue')
    const expected = scoreIssue({
      issue,
      ...sources,
      throughBlock: saved.through.block.number,
      scoredAtUtc: saved.scoredAtUtc,
    })
    if (
      JSON.stringify(saved) !== JSON.stringify(expected) ||
      Date.parse(saved.scoredAtUtc) > now().getTime()
    )
      throw new Error('Cohort duration score as-of replay mismatch')
  }
  return {
    status: 'verified',
    issues: issues.length,
    scores: scores.length,
    pairCount: roster(sources.plan).length,
  }
}

export function issueLatest({
  out = OUT,
  sources = readSources(),
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  if (!sources) return { status: 'unavailable', reason: 'no_plan' }
  verify({ out, sources, now })
  if (!sources.observations.length)
    return { status: 'unavailable', reason: 'no_cohort_observation' }
  const next = sources.observations.find((row) => {
    const quote = sources.checkpoints.find(
      (item) => item.checkpoint.block.number === row.issue.checkpoint.block.number,
    )
    return !existsSync(join(out, 'issues', filenameFor(quote)))
  })
  if (!next) return { status: 'unchanged', reason: 'all_observations_issued' }
  const quote = sources.checkpoints.find(
    (row) => row.checkpoint.block.number === next.issue.checkpoint.block.number,
  )
  const path = join(out, 'issues', filenameFor(quote))
  const issuedAtUtc = now().toISOString()
  if (
    Date.parse(issuedAtUtc) - quote.checkpoint.block.timestamp * 1000 > MAX_AGE_MS ||
    sources.checkpoints.some(
      (row) =>
        row.checkpoint.block.number > quote.checkpoint.block.number &&
        Date.parse(row.checkpoint.captureEndUtc) <= Date.parse(issuedAtUtc),
    )
  )
    return {
      status: 'unavailable',
      reason: 'oldest_unissued_observation_window_missed',
      block: quote.checkpoint.block.number,
    }
  const issue = buildIssue({
    ...sources,
    atBlock: quote.checkpoint.block.number,
    issuedAtUtc,
  })
  immutableWrite(path, issue, stat)
  return { status: 'issued', path, firstLossIntervals: issue.riskSet.counts.firstLossIntervals }
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
  if (!latest) return { status: 'unavailable', reason: 'no_quote_checkpoint' }
  const issueDir = join(out, 'issues')
  const names = existsSync(issueDir)
    ? readdirSync(issueDir)
        .filter((x) => x.endsWith('.json'))
        .sort()
    : []
  let scored = 0
  for (const filename of names) {
    const issue = readSealed(join(issueDir, filename))
    if (latest.checkpoint.block.number <= issue.block.number) continue
    const path = join(out, 'scores', scoreFilename(filename, latest.checkpoint.block.number))
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
    console.log(
      JSON.stringify(
        mode === '--run' ? issueLatest() : mode === '--score' ? scoreLatest() : verify(),
      ),
    )
  } catch {
    console.error('[scrvusd-cohort-duration] unavailable')
    process.exitCode = 1
  }
}
