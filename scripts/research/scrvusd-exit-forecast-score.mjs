// Immutable, prospective score of discrete fixed-holder exit observations.
// No RPC, alert, calibrated probability, or claim of continuous availability.
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
  OUT as ISSUE_OUT,
  OUTCOME_PROTOCOL_VERSION,
  outcomeProtocol,
  verify as verifyIssues,
} from './scrvusd-exit-forecast-issue.mjs'
import { readSources } from './scrvusd-holder-duration.mjs'
import { RESERVE_BYTES } from './scrvusd-fixed-holder-exit.mjs'
import {
  OUT as ATTESTATION_OUT,
  readVerifiedAtCheckpoint,
  validateAttestation,
} from './scrvusd-target-code-attestation.mjs'
import { sourceIdentity } from './curve-prospective-quote.mjs'

export const STUDY = 'scrvusd-now-origin-exit-forecast-score-v1'
export const OUT = resolve('data/research/venue-signals/scrvusd-exit-forecast-scores')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const seal = (payload) => ({ ...payload, sha256: sha(JSON.stringify(payload)) })
const unsigned = ({ sha256: _sha256, ...payload }) => payload
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const ref = (row, logical) => ({
  filename: row.filename,
  logicalSha256: logical.sha256,
  physicalSha256: row.physicalSha256,
})
const quoteRef = (row) => ref(row, row.checkpoint)
const holderRef = (row) => ref(row, row.issue)
const sameRef = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const snapshotRows = (rows, refs, makeRef, kind) => {
  if (!Array.isArray(refs) || new Set(refs.map((item) => item.filename)).size !== refs.length)
    throw new Error(`Invalid sealed ${kind} evidence snapshot`)
  const byName = new Map(rows.map((row) => [row.filename, row]))
  return refs.map((source) => {
    const row = byName.get(source.filename)
    if (!row || !sameRef(makeRef(row), source))
      throw new Error(`Sealed ${kind} evidence is unavailable or changed`)
    return row
  })
}
const blockOf = (row) => row.checkpoint.block
const sameBlock = (a, b) => a?.number === b?.number && a?.hash === b?.hash
const holderAt = (rows, block) =>
  rows.find((row) => sameBlock(row.issue.checkpoint.block, block)) ?? null
const cleanSuccess = (row) => {
  const result = row?.issue.result
  return (
    result?.status === 'success' &&
    result.maxWithdrawAssetsRaw !== null &&
    result.previewSharesRaw !== null &&
    result.balanceSharesRaw !== null &&
    BigInt(result.maxWithdrawAssetsRaw) >= BigInt(row.issue.rawCrvUsd) &&
    BigInt(result.balanceSharesRaw) >= BigInt(result.previewSharesRaw)
  )
}

function validateRows(issueRow, checkpoints, holderRows, issueStudy) {
  const issue = issueRow?.issue
  if (
    !issue ||
    issue.study !== issueStudy ||
    issue.sha256 !== sha(JSON.stringify(unsigned(issue))) ||
    issue.outcomeProtocol?.version !== OUTCOME_PROTOCOL_VERSION ||
    JSON.stringify(issue.outcomeProtocol) !==
      JSON.stringify(outcomeProtocol(issue.issuedAtUtc, issue.horizonSeconds)) ||
    !validTime(issue.issuedAtUtc) ||
    !/^[a-f0-9]{64}$/.test(issueRow.physicalSha256 ?? '') ||
    issue.currentExecutableAbility?.status !== 'sampled_success' ||
    issue.futureForecast?.status !== 'unavailable'
  )
    throw new Error('Invalid or altered NOW-origin issue')
  for (let i = 0; i < checkpoints.length; i++) {
    const row = checkpoints[i]
    if (
      !validTime(row.checkpoint.captureEndUtc) ||
      !Number.isSafeInteger(blockOf(row).timestamp) ||
      !/^[a-f0-9]{64}$/.test(row.physicalSha256 ?? '') ||
      (i > 0 &&
        (blockOf(checkpoints[i - 1]).number >= blockOf(row).number ||
          blockOf(checkpoints[i - 1]).timestamp >= blockOf(row).timestamp))
    )
      throw new Error('Invalid verified quote chronology')
  }
  for (const row of holderRows) {
    if (
      !validTime(row.issue.captureEndUtc) ||
      !/^[a-f0-9]{64}$/.test(row.physicalSha256 ?? '') ||
      !checkpoints.some((quote) => sameBlock(blockOf(quote), row.issue.checkpoint.block))
    )
      throw new Error('Holder source is not bound to a verified quote')
  }
  const anchor = checkpoints.find((row) => sameBlock(blockOf(row), issue.anchorBlock))
  const anchorHolder = holderAt(holderRows, issue.anchorBlock)
  if (
    !anchor ||
    !anchorHolder ||
    JSON.stringify(quoteRef(anchor)) !== JSON.stringify(issue.source.quoteCheckpoint) ||
    JSON.stringify(holderRef(anchorHolder)) !== JSON.stringify(issue.source.holderProbe) ||
    !cleanSuccess(anchorHolder) ||
    anchorHolder.issue.holder !== issue.holder ||
    anchorHolder.issue.rawCrvUsd !== issue.qAssetsRaw
  )
    throw new Error('Issue anchor source changed')
}

function sample(quote, holder) {
  const block = blockOf(quote)
  return {
    block,
    sampledAtUtc: new Date(block.timestamp * 1000).toISOString(),
    quote: quoteRef(quote),
    holderProbe: holder ? holderRef(holder) : null,
    holderCaptureEndUtc: holder?.issue.captureEndUtc ?? null,
    status:
      holder?.issue.result.status === 'provider_error'
        ? 'provider_ambiguity'
        : (holder?.issue.result.status ?? 'missing'),
    maxWithdrawAssetsRaw: holder?.issue.result.maxWithdrawAssetsRaw ?? null,
    balanceSharesRaw: holder?.issue.result.balanceSharesRaw ?? null,
    previewSharesRaw: holder?.issue.result.previewSharesRaw ?? null,
  }
}

function codeIdentity(issue, samples, attestationByBlock, invalidBlocks) {
  const rule = issue.outcomeProtocol.comparability.codeIdentityRule
  const boundAnchor = issue.source.targetCodeAttestation ?? null
  const anchorRow = attestationByBlock.get(issue.anchorBlock.number) ?? null
  if (boundAnchor && !anchorRow) throw new Error('Issue-bound anchor attestation is unavailable')
  if (
    boundAnchor &&
    JSON.stringify(ref(anchorRow, anchorRow.issue)) !== JSON.stringify(boundAnchor)
  )
    throw new Error('Issue-bound anchor attestation changed')
  const anchor = boundAnchor ? ref(anchorRow, anchorRow.issue) : null
  const sampled = samples.map((item) => {
    const row = attestationByBlock.get(item.block.number) ?? null
    return {
      quote: item.quote,
      attestation: row ? ref(row, row.issue) : null,
      captureEndUtc: row?.issue.captureEndUtc ?? null,
      evidenceStatus: row
        ? 'verified'
        : invalidBlocks.has(item.block.number)
          ? 'invalid'
          : 'missing_or_late',
    }
  })
  let status = 'unknown'
  let reason = null
  if (!samples.length) reason = 'missing_target_quote'
  else if (!anchor) reason = 'unattested_issue_anchor'
  else {
    const baseline = anchorRow.issue
    const changed = samples.some((item) => {
      const current = attestationByBlock.get(item.block.number)?.issue
      return current && rule.compareFields.some((field) => baseline[field] !== current[field])
    })
    if (changed) {
      status = 'changed'
      reason = 'sampled_code_identity_mismatch'
    } else if (sampled.some((item) => item.evidenceStatus === 'invalid')) {
      reason = 'invalid_sample_attestation'
    } else if (sampled.some((item) => item.attestation === null)) {
      reason = 'missing_or_late_sample_attestation'
    } else {
      status = 'sampled_match_only'
      reason = 'all_sampled_code_fields_match'
    }
  }
  return {
    status,
    reason,
    anchor,
    samples: sampled,
    comparedFields: rule.compareFields,
    continuity: 'unverified',
    causalAttribution: 'unavailable',
    pointOutcomeUnaffected: true,
    caveat:
      'Sampled code identity does not establish behavior, strategy state, or continuous exit availability.',
  }
}

function comparabilityReason(issue, previous, item, gap) {
  if (gap > issue.outcomeProtocol.comparability.maxAdjacentVerifiedQuoteGapSeconds)
    return 'quote_sampling_gap'
  if (item.status === 'missing') return 'missing_holder_observation'
  if (item.status === 'provider_ambiguity') return 'provider_ambiguity'
  if (item.balanceSharesRaw === null || item.previewSharesRaw === null)
    return 'holder_diagnostics_unavailable'
  if (
    BigInt(item.balanceSharesRaw) < BigInt(previous.balanceSharesRaw) ||
    BigInt(item.balanceSharesRaw) < BigInt(item.previewSharesRaw)
  )
    return 'share_attrition_or_insufficient_shares'
  if (
    item.status === 'success' &&
    !cleanSuccess({
      issue: {
        rawCrvUsd: issue.qAssetsRaw,
        result: {
          status: item.status,
          maxWithdrawAssetsRaw: item.maxWithdrawAssetsRaw,
          balanceSharesRaw: item.balanceSharesRaw,
          previewSharesRaw: item.previewSharesRaw,
        },
      },
    })
  )
    return 'inconsistent_success_diagnostics'
  return null
}

function sampledLossInterval(issue, lastSuccess, item) {
  return {
    intervalStartBlock: lastSuccess.number,
    intervalEndBlock: item.block.number,
    intervalStartUtc: new Date(lastSuccess.timestamp * 1000).toISOString(),
    intervalEndUtc: item.sampledAtUtc,
    intervalStartKind:
      lastSuccess.timestamp * 1000 <= Date.parse(issue.issuedAtUtc)
        ? 'pre_issue_anchor_sample'
        : 'post_issue_clean_success_sample',
    secondsFromIssueAtStart: lastSuccess.timestamp - Date.parse(issue.issuedAtUtc) / 1000,
    secondsFromIssueAtEnd: item.block.timestamp - Date.parse(issue.issuedAtUtc) / 1000,
    caveat:
      'Signed offsets locate sampled bounds around issuance; a pre-issue start is not a positive survival lower bound from NOW.',
  }
}

function trajectory(issue, samples) {
  let previous = {
    block: issue.anchorBlock,
    balanceSharesRaw: issue.currentExecutableAbility.balanceSharesRaw,
  }
  let firstLoss = null
  let recovery = null
  let laterSampledSuccess = null
  let postLossCensor = null
  let postRecoveryCensor = null
  let censor = null
  let lastSuccess = issue.anchorBlock
  let preFirstLossLastCleanSuccessBlock = issue.anchorBlock
  let latestCleanSampledSuccessBlock = issue.anchorBlock
  let latestComparableStatus = 'sampled_success'
  let afterRecoveryStatus = null
  const relapses = []
  const subsequentRecoveries = []
  const gaps = []
  for (const item of samples) {
    const gap = item.block.timestamp - previous.block.timestamp
    if (gap > issue.outcomeProtocol.comparability.maxAdjacentVerifiedQuoteGapSeconds)
      gaps.push({ fromBlock: previous.block.number, toBlock: item.block.number, seconds: gap })
    if (!firstLoss && !censor) {
      const reason = comparabilityReason(issue, previous, item, gap)
      if (reason) censor = { reason, atBlock: item.block, lastCleanSuccessBlock: lastSuccess }
      else if (item.status === 'revert') {
        firstLoss = sampledLossInterval(issue, lastSuccess, item)
        preFirstLossLastCleanSuccessBlock = lastSuccess
        latestComparableStatus = 'sampled_revert'
      } else {
        lastSuccess = item.block
        preFirstLossLastCleanSuccessBlock = item.block
        latestCleanSampledSuccessBlock = item.block
      }
    } else if (firstLoss && !recovery) {
      if (item.status === 'success' && !laterSampledSuccess)
        laterSampledSuccess = { block: item.block, sampledAtUtc: item.sampledAtUtc }
      if (!postLossCensor) {
        const reason = comparabilityReason(issue, previous, item, gap)
        if (reason) postLossCensor = { reason, atBlock: item.block }
        else if (item.status === 'success') {
          // A comparable sampled success cannot repair the prior first-loss interval.
          recovery = { block: item.block, sampledAtUtc: item.sampledAtUtc }
          lastSuccess = item.block
          latestCleanSampledSuccessBlock = item.block
          latestComparableStatus = 'sampled_success'
          afterRecoveryStatus = 'sampled_success'
        } else latestComparableStatus = 'sampled_revert'
      }
    } else if (firstLoss && recovery && !postRecoveryCensor) {
      const reason = comparabilityReason(issue, previous, item, gap)
      if (reason)
        postRecoveryCensor = {
          reason,
          atBlock: item.block,
          lastCleanSuccessBlock: latestCleanSampledSuccessBlock,
          observedStatus: item.status,
        }
      else if (item.status === 'revert') {
        if (afterRecoveryStatus === 'sampled_success')
          relapses.push(sampledLossInterval(issue, lastSuccess, item))
        afterRecoveryStatus = 'sampled_revert'
        latestComparableStatus = 'sampled_revert'
      } else {
        if (afterRecoveryStatus === 'sampled_revert')
          subsequentRecoveries.push({ block: item.block, sampledAtUtc: item.sampledAtUtc })
        afterRecoveryStatus = 'sampled_success'
        lastSuccess = item.block
        latestCleanSampledSuccessBlock = item.block
        latestComparableStatus = 'sampled_success'
      }
    }
    previous = item
  }
  return {
    status: firstLoss
      ? recovery
        ? postRecoveryCensor
          ? 'first_loss_with_recovery_followup_censored'
          : relapses.length
            ? 'first_loss_with_later_sampled_recovery_and_relapse'
            : 'first_loss_with_later_sampled_recovery'
        : laterSampledSuccess
          ? 'first_loss_with_later_unverified_success'
          : 'first_loss_interval'
      : censor
        ? 'right_censored_ambiguous'
        : 'right_censored_at_last_sampled_success',
    firstLoss,
    recovery,
    laterSampledSuccess,
    postLossCensor,
    postRecoveryCensor,
    relapses,
    subsequentRecoveries,
    latestComparableStatus,
    censor,
    preFirstLossLastCleanSuccessBlock,
    latestCleanSampledSuccessBlock,
    adjacentQuoteGaps: gaps,
    continuity: 'unverified',
    mechanismAttribution: 'unavailable',
    caveat: 'Discrete read-only probes do not establish continuous exit availability.',
  }
}

function outcomeSelection(issue, checkpoints) {
  const issueMs = Date.parse(issue.issuedAtUtc)
  const targetMs = Date.parse(issue.targetUtc)
  const deadlineMs = Date.parse(issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc)
  const windowMs = issue.outcomeProtocol.checkpointSelection.windowSeconds * 1000
  const asOfQuotes = checkpoints.filter(
    (row) => Date.parse(row.checkpoint.captureEndUtc) <= deadlineMs,
  )
  const candidates = asOfQuotes
    .filter((row) => {
      const time = blockOf(row).timestamp * 1000
      return time > issueMs && Math.abs(time - targetMs) <= windowMs
    })
    .sort(
      (a, b) =>
        Math.abs(blockOf(a).timestamp * 1000 - targetMs) -
          Math.abs(blockOf(b).timestamp * 1000 - targetMs) ||
        blockOf(a).number - blockOf(b).number ||
        blockOf(a).hash.localeCompare(blockOf(b).hash),
    )
  const selected = candidates[0] ?? null
  const interveningQuotes = asOfQuotes.filter(
    (row) =>
      blockOf(row).number > issue.anchorBlock.number &&
      blockOf(row).timestamp * 1000 > issueMs &&
      selected &&
      blockOf(row).number <= blockOf(selected).number,
  )
  return { asOfQuotes, selected, interveningQuotes, targetMs, deadlineMs }
}

export function buildScore({
  issueRow,
  checkpoints,
  holderRows,
  attestationRows = [],
  invalidAttestationBlocks = [],
  invalidAttestationFiles = [],
  scoredAtUtc,
  issueStudy = 'scrvusd-now-origin-exit-forecast-issue-v1',
  scoreStudy = STUDY,
}) {
  validateRows(issueRow, checkpoints, holderRows, issueStudy)
  const issue = issueRow.issue
  const deadlineUtc = issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc
  const deadlineMs = Date.parse(deadlineUtc)
  const scoredMs = Date.parse(scoredAtUtc)
  if (!validTime(scoredAtUtc) || scoredMs < deadlineMs)
    throw new Error('Exit outcome capture deadline has not closed')
  const { asOfQuotes, selected, interveningQuotes, targetMs } = outcomeSelection(issue, checkpoints)
  const asOfHolders = holderRows.filter((row) => Date.parse(row.issue.captureEndUtc) <= deadlineMs)
  const asOfNames = new Set(asOfQuotes.map((row) => row.filename))
  const evidenceSnapshot = {
    quoteRefs: asOfQuotes.map(quoteRef),
    holderRefs: asOfHolders.filter((row) => asOfNames.has(row.filename)).map(holderRef),
    attestationRefs: attestationRows
      .filter((row) => Date.parse(row.issue.captureEndUtc) <= deadlineMs)
      .map((row) => ref(row, row.issue)),
    invalidAttestationBlocks: [...invalidAttestationBlocks],
    invalidAttestationFiles: [...invalidAttestationFiles],
  }
  const relevant = [
    ...checkpoints.filter((row) => sameBlock(blockOf(row), issue.anchorBlock)),
    ...interveningQuotes,
  ]
  const quoteByFilename = new Map(relevant.map((row) => [row.filename, row]))
  const attestationByBlock = new Map()
  const invalidBlocks = new Set(invalidAttestationBlocks)
  const sampledBlocks = new Set(interveningQuotes.map((row) => blockOf(row).number))
  if ([...invalidBlocks].some((block) => !sampledBlocks.has(block)))
    throw new Error('Invalid attestation marker is outside selected sample path')
  for (const row of attestationRows) {
    const quote = quoteByFilename.get(row.filename)
    if (!quote) continue
    const block = blockOf(quote)
    try {
      if (
        !sameBlock(row.issue?.block, block) ||
        row.physicalSha256 !== sha(`${JSON.stringify(row.issue)}\n`) ||
        attestationByBlock.has(block.number)
      )
        throw new Error('Attestation physical or exact-block binding mismatch')
      validateAttestation(row.issue, {
        identity: sourceIdentity(),
        checkpoints: [quote],
        nowUtc: scoredAtUtc,
      })
      if (Date.parse(row.issue.captureEndUtc) <= deadlineMs)
        attestationByBlock.set(block.number, row)
    } catch {
      if (sameBlock(block, issue.anchorBlock) && issue.source.targetCodeAttestation)
        throw new Error('Issue-bound anchor attestation is invalid')
      if (sampledBlocks.has(block.number)) invalidBlocks.add(block.number)
    }
  }
  const selectedHolder = selected ? holderAt(asOfHolders, blockOf(selected)) : null
  if (
    selectedHolder &&
    (selectedHolder.issue.holder !== issue.holder ||
      selectedHolder.issue.rawCrvUsd !== issue.qAssetsRaw)
  )
    throw new Error('Selected holder/q differs from sealed issue')
  const intervening = interveningQuotes.map((quote) => {
    const holder = holderAt(asOfHolders, blockOf(quote))
    if (
      holder &&
      (holder.issue.holder !== issue.holder || holder.issue.rawCrvUsd !== issue.qAssetsRaw)
    )
      throw new Error('Intervening holder/q differs from sealed issue')
    return sample(quote, holder)
  })
  const selectedSample = selected ? sample(selected, selectedHolder) : null
  const frontier = asOfQuotes.at(-1) ?? null
  const outcome = selectedSample
    ? {
        status: selectedSample.status,
        sampledAtUtc: selectedSample.sampledAtUtc,
        targetOffsetSeconds: blockOf(selected).timestamp - targetMs / 1000,
        block: blockOf(selected),
        holder: issue.holder,
        qAssetsRaw: issue.qAssetsRaw,
        route: issue.route,
        holderProbe: selectedSample.holderProbe,
        holderCaptureEndUtc: selectedSample.holderCaptureEndUtc,
      }
    : {
        status: 'missing_quote_checkpoint',
        sampledAtUtc: null,
        targetOffsetSeconds: null,
        block: null,
        holder: issue.holder,
        qAssetsRaw: issue.qAssetsRaw,
        route: issue.route,
        holderProbe: null,
        holderCaptureEndUtc: null,
      }
  return seal({
    study: scoreStudy,
    issue: ref(issueRow, issue),
    scoredAtUtc,
    evidenceCutoffUtc: deadlineUtc,
    evidenceSnapshot,
    targetUtc: issue.targetUtc,
    horizonSeconds: issue.horizonSeconds,
    sourceFrontier: frontier
      ? {
          status: 'verified_through_checkpoint',
          quote: quoteRef(frontier),
          block: blockOf(frontier),
        }
      : { status: 'no_verified_quote_checkpoint', quote: null, block: null },
    finality: 'source_checkpoints_verified_as_finalized_at_capture',
    selectedQuote: selected ? quoteRef(selected) : null,
    interveningSamples: intervening,
    pointOutcome: outcome,
    sampledCodeIdentity: codeIdentity(issue, intervening, attestationByBlock, invalidBlocks),
    trajectory: selected
      ? trajectory(issue, intervening)
      : {
          status: 'unavailable_missing_capture',
          firstLoss: null,
          recovery: null,
          laterSampledSuccess: null,
          postLossCensor: null,
          postRecoveryCensor: null,
          relapses: [],
          subsequentRecoveries: [],
          latestComparableStatus: 'sampled_success',
          censor: null,
          preFirstLossLastCleanSuccessBlock: issue.anchorBlock,
          latestCleanSampledSuccessBlock: issue.anchorBlock,
          adjacentQuoteGaps: [],
          continuity: 'unverified',
          mechanismAttribution: 'unavailable',
          caveat: 'No verified quote checkpoint was captured in the sealed target window.',
        },
    caveat:
      'A point result is a same-block read-only simulation, not a transaction guarantee. Holder continuity, implementation continuity, and exit mechanism attribution are unverified.',
  })
}

function readSealed(path) {
  const bytes = readFileSync(path)
  const value = JSON.parse(bytes)
  if (
    bytes.toString() !== `${JSON.stringify(value)}\n` ||
    value.sha256 !== sha(JSON.stringify(unsigned(value)))
  )
    throw new Error('Exit score artifact physical or logical seal mismatch')
  return { filename: path.split('/').at(-1), issue: value, physicalSha256: sha(bytes) }
}

function issueRows(out) {
  return existsSync(out)
    ? readdirSync(out)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => readSealed(join(out, name)))
    : []
}

export function readScoreAttestations({ issue, checkpoints, out = ATTESTATION_OUT, nowUtc }) {
  const deadlineUtc = issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc
  const { interveningQuotes } = outcomeSelection(issue, checkpoints)
  const anchor = issue.source.targetCodeAttestation
    ? checkpoints.find((quote) => sameBlock(blockOf(quote), issue.anchorBlock))
    : null
  if (issue.source.targetCodeAttestation && !anchor)
    throw new Error('Issue-bound anchor quote is unavailable')
  const rows = []
  const invalidAttestationBlocks = []
  const invalidAttestationFiles = []
  for (const checkpoint of [...(anchor ? [anchor] : []), ...interveningQuotes]) {
    try {
      const row = readVerifiedAtCheckpoint({ out, checkpoint, asOfUtc: deadlineUtc, nowUtc })
      if (row) rows.push(row)
    } catch {
      if (anchor && sameBlock(blockOf(checkpoint), issue.anchorBlock))
        throw new Error('Issue-bound anchor attestation is invalid')
      invalidAttestationBlocks.push(blockOf(checkpoint).number)
      const filename = checkpoint.filename
      // The invalid marker is evidence too: bind its exact bytes before
      // collapsing it to an unknown sampled-code observation.
      invalidAttestationFiles.push({
        blockNumber: blockOf(checkpoint).number,
        filename,
        physicalSha256: sha(readFileSync(join(out, filename))),
      })
    }
  }
  return { attestationRows: rows, invalidAttestationBlocks, invalidAttestationFiles }
}

// Replay the exact source set sealed at score time. A later file whose receipt says
// captureEnd <= deadline is a new observation for audit, not a mutation of history.
export function replayScore({
  saved,
  issueRow,
  checkpoints,
  holderRows,
  attestationRows = [],
  invalidAttestationBlocks = [],
  invalidAttestationFiles = [],
  snapshotInvalidAttestationFiles = invalidAttestationFiles,
  allowContested = false,
  issueStudy = 'scrvusd-now-origin-exit-forecast-issue-v1',
  scoreStudy = STUDY,
}) {
  const snapshot = saved.evidenceSnapshot
  if (
    !snapshot ||
    !Array.isArray(snapshot.invalidAttestationBlocks) ||
    new Set(snapshot.invalidAttestationBlocks).size !== snapshot.invalidAttestationBlocks.length ||
    !Array.isArray(snapshot.invalidAttestationFiles)
  )
    throw new Error('Invalid sealed exit score evidence snapshot')
  if (
    snapshot.invalidAttestationFiles.some(
      (source) => !snapshotInvalidAttestationFiles.some((current) => sameRef(current, source)),
    )
  )
    throw new Error('Sealed invalid attestation evidence is unavailable or changed')
  const quotes = snapshotRows(checkpoints, snapshot.quoteRefs, quoteRef, 'quote')
  const holders = snapshotRows(holderRows, snapshot.holderRefs, holderRef, 'holder')
  const attestations = snapshotRows(
    attestationRows,
    snapshot.attestationRefs,
    (row) => ref(row, row.issue),
    'attestation',
  )
  const expected = buildScore({
    issueRow,
    checkpoints: quotes,
    holderRows: holders,
    attestationRows: attestations,
    invalidAttestationBlocks: snapshot.invalidAttestationBlocks,
    invalidAttestationFiles: snapshot.invalidAttestationFiles,
    scoredAtUtc: saved.scoredAtUtc,
    issueStudy,
    scoreStudy,
  })
  if (JSON.stringify(saved) !== JSON.stringify(expected))
    throw new Error('Exit score sealed-evidence replay mismatch')
  const deadlineMs = Date.parse(saved.evidenceCutoffUtc)
  const notSaved = (items, refs, makeRef) =>
    items.filter((row) => !refs.some((source) => sameRef(makeRef(row), source))).length
  const additionalEligibleEvidence = {
    quotes: notSaved(
      checkpoints.filter((row) => Date.parse(row.checkpoint.captureEndUtc) <= deadlineMs),
      snapshot.quoteRefs,
      quoteRef,
    ),
    holders: notSaved(
      holderRows.filter((row) => Date.parse(row.issue.captureEndUtc) <= deadlineMs),
      snapshot.holderRefs,
      holderRef,
    ),
    attestations: notSaved(
      attestationRows.filter((row) => Date.parse(row.issue.captureEndUtc) <= deadlineMs),
      snapshot.attestationRefs,
      (row) => ref(row, row.issue),
    ),
    invalidAttestationBlocks: invalidAttestationBlocks.filter(
      (block) => !snapshot.invalidAttestationBlocks.includes(block),
    ).length,
  }
  const resultFields = (row) => ({
    selectedQuote: row.selectedQuote,
    interveningSamples: row.interveningSamples,
    pointOutcome: row.pointOutcome,
    sampledCodeIdentity: row.sampledCodeIdentity,
    trajectory: row.trajectory,
  })
  const wouldChangeResult = Object.values(additionalEligibleEvidence).some((count) => count > 0)
    ? JSON.stringify(
        resultFields(
          buildScore({
            issueRow,
            checkpoints,
            holderRows,
            attestationRows,
            invalidAttestationBlocks,
            invalidAttestationFiles,
            scoredAtUtc: saved.scoredAtUtc,
            issueStudy,
            scoreStudy,
          }),
        ),
      ) !== JSON.stringify(resultFields(saved))
    : false
  if (wouldChangeResult && !allowContested)
    throw new Error('Exit score contested by additional eligible evidence; adjudication required')
  return {
    additionalEligibleEvidence,
    wouldChangeResult,
  }
}

export function verify({
  out = OUT,
  issueOut = ISSUE_OUT,
  roots = {},
  now = () => new Date(),
  allowContested = false,
} = {}) {
  verifyIssues({ out: issueOut, roots, now })
  const sources = readSources({ ...roots, now })
  const issues = issueRows(issueOut)
  const byName = new Map(issues.map((row) => [row.filename, row]))
  const scores = issueRows(out)
  const additionalEligibleEvidence = {
    quotes: 0,
    holders: 0,
    attestations: 0,
    invalidAttestationBlocks: 0,
  }
  const contestedScores = []
  for (const row of scores) {
    const issueRow = byName.get(row.filename)
    if (!issueRow) throw new Error('Exit score has no matching issue')
    const saved = row.issue
    if (Date.parse(saved.scoredAtUtc) > now().getTime()) throw new Error('Future score clock')
    const snapshot = saved.evidenceSnapshot
    if (!snapshot || !Array.isArray(snapshot.quoteRefs))
      throw new Error('Exit score has no sealed evidence snapshot')
    const snapshotQuotes = snapshotRows(sources.checkpoints, snapshot.quoteRefs, quoteRef, 'quote')
    const attestationOptions = {
      issue: issueRow.issue,
      out: roots.attestationOut ?? ATTESTATION_OUT,
      nowUtc: now().toISOString(),
    }
    const snapshotAttestations = readScoreAttestations({
      ...attestationOptions,
      checkpoints: snapshotQuotes,
    })
    const currentAttestations = readScoreAttestations({
      ...attestationOptions,
      checkpoints: sources.checkpoints,
    })
    const attestationRows = [
      ...new Map(
        [...snapshotAttestations.attestationRows, ...currentAttestations.attestationRows].map(
          (source) => [source.filename, source],
        ),
      ).values(),
    ]
    const replay = replayScore({
      saved,
      issueRow,
      checkpoints: sources.checkpoints,
      holderRows: sources.holderRows,
      allowContested,
      attestationRows,
      invalidAttestationBlocks: currentAttestations.invalidAttestationBlocks,
      invalidAttestationFiles: currentAttestations.invalidAttestationFiles,
      snapshotInvalidAttestationFiles: snapshotAttestations.invalidAttestationFiles,
    })
    for (const key of Object.keys(additionalEligibleEvidence))
      additionalEligibleEvidence[key] += replay.additionalEligibleEvidence[key]
    if (Object.values(replay.additionalEligibleEvidence).some((count) => count > 0))
      contestedScores.push({
        filename: row.filename,
        wouldChangeResult: replay.wouldChangeResult,
        ...replay.additionalEligibleEvidence,
      })
  }
  return {
    issues: issues.length,
    scores: scores.length,
    additionalEligibleEvidence,
    contestedScores,
  }
}

function guard(path, bytes, stat = statfsSync) {
  let ancestor = path
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const fs = stat(ancestor)
  if (Number(fs.bavail) * Number(fs.bsize) - bytes < RESERVE_BYTES)
    throw new Error('Exit score disk reserve reached')
}

export function scoreMatured({
  out = OUT,
  issueOut = ISSUE_OUT,
  roots = {},
  now = () => new Date(),
  stat = statfsSync,
} = {}) {
  verify({ out, issueOut, roots, now })
  const sources = readSources({ ...roots, now })
  let written = 0
  let pending = 0
  for (const issueRow of issueRows(issueOut)) {
    const path = join(out, issueRow.filename)
    if (existsSync(path)) continue
    if (
      now().getTime() <
      Date.parse(issueRow.issue.outcomeProtocol.checkpointSelection.captureDeadlineUtc)
    ) {
      pending++
      continue
    }
    const score = buildScore({
      issueRow,
      checkpoints: sources.checkpoints,
      holderRows: sources.holderRows,
      ...readScoreAttestations({
        issue: issueRow.issue,
        checkpoints: sources.checkpoints,
        out: roots.attestationOut ?? ATTESTATION_OUT,
        nowUtc: now().toISOString(),
      }),
      scoredAtUtc: now().toISOString(),
    })
    const bytes = `${JSON.stringify(score)}\n`
    guard(out, Buffer.byteLength(bytes), stat)
    mkdirSync(out, { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 })
      linkSync(temp, path)
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
    }
    written++
  }
  return { written, pending }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode = '--verify'] = process.argv.slice(2)
    if (mode === '--verify') console.log(JSON.stringify(verify()))
    else if (mode === '--audit-late') console.log(JSON.stringify(verify({ allowContested: true })))
    else if (mode === '--score') console.log(JSON.stringify(scoreMatured()))
    else throw new Error('Usage: --verify | --audit-late | --score')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
