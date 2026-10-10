// Explicit, opt-in owner/Q prospective Morpho Vault V2 study. Read-only eth_call;
// a successful simulation is neither a mined withdrawal nor proof of key control.
// CLI deliberately exposes verification only: node --import tsx this-file --verify [dir]
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from '../lib/carry-exit-v2-rpc-proof.mjs'
import { appendChain, readChain } from './carry-local-morpho-holder-store.mjs'

export const STUDY = 'carry_morpho_requested_holder_v1'
export const DEFAULT_DIR = resolve('data/research/venue-signals/carry-morpho-requested-holder-v1')
export const HORIZONS = Object.freeze([1, 24])
export const MAX_ISSUES = 256
export const MAX_SCORES = MAX_ISSUES * HORIZONS.length
export const MAX_ATTEMPTS = 1024
const MANIFEST_PATH = resolve('lib/carry/morpho-v2-asset-identities.json')
const MANIFEST_SHA = '8dd54bbb3dea0842bb67e582f0725adcafb7594107933122c5fa381c083566da'
const ADDRESS = /^0x[0-9a-f]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^[1-9][0-9]{0,77}$/
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]*)$/
const OPERATORS = new Set([
  'alchemy',
  'infura',
  'ankr',
  'quicknode',
  'publicnode',
  'llamarpc',
  'drpc',
  'chainstack',
  'loopback',
])
const CLAIMS = Object.freeze({
  keyControlProved: false,
  minedPayoutProved: false,
  prospectiveValidated: false,
  independentOriginBindingProved: false,
})
const HOUR = 3_600_000
const WINDOW = 2 * HOUR
const sha = (x) => createHash('sha256').update(x).digest('hex')
const canonical = (x) => JSON.stringify(x)
const iso = (ms) => new Date(ms).toISOString()
const same = (a, b) => canonical(a) === canonical(b)
const safeTime = (value) => {
  const n = Date.parse(value)
  if (!Number.isSafeInteger(n) || iso(n) !== value) throw Error('requested_holder_time_invalid')
  return n
}
const dirs = (dir) => ({
  issues: resolve(dir, 'issues'),
  scores: resolve(dir, 'scores'),
  attempts: resolve(dir, 'attempts'),
})

export function originHost(value) {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw Error('requested_holder_origin_invalid')
  const host = url.hostname
    .replace(/\.$/, '')
    .replace(/^www\./, '')
    .toLowerCase()
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/.test(host)) return 'loopback'
  const operators = [
    ['alchemy', 'alchemy.com'],
    ['infura', 'infura.io'],
    ['ankr', 'ankr.com'],
    ['quicknode', 'quiknode.pro'],
    ['publicnode', 'publicnode.com'],
    ['llamarpc', 'llamarpc.com'],
    ['drpc', 'drpc.org'],
    ['drpc', 'drpc.live'],
    ['chainstack', 'chainstack.com'],
  ]
  const match = operators.find(([, suffix]) => host === suffix || host.endsWith(`.${suffix}`))
  if (!match) throw Error('requested_holder_origin_operator_unknown')
  return match[0]
}
export function exactSubject(request) {
  if (
    typeof request?.routeKey !== 'string' ||
    !request.routeKey ||
    request.routeKey.length > 160 ||
    !ADDRESS.test(request.destinationAddress) ||
    !ADDRESS.test(request.owner) ||
    typeof request.assetsRaw !== 'string' ||
    !DECIMAL.test(request.assetsRaw) ||
    BigInt(request.assetsRaw) >= 1n << 256n
  )
    throw Error('requested_holder_request_invalid')
  const bytes = readFileSync(MANIFEST_PATH)
  if (sha(bytes) !== MANIFEST_SHA) throw Error('requested_holder_manifest_changed')
  const manifest = JSON.parse(bytes)
  if (manifest.schemaVersion !== 1 || manifest.chainId !== 1 || manifest.entries?.length !== 49)
    throw Error('requested_holder_manifest_invalid')
  const route = CARRY_EXIT_V2_FROZEN_ROUTES.find(
    (x) =>
      x.kind === 'morpho' &&
      x.routeKey === request.routeKey &&
      x.destination === request.destinationAddress,
  )
  const identity = manifest.entries.find((x) => x.vault === request.destinationAddress)
  if (!route || !identity || route.asset !== identity.asset)
    throw Error('requested_holder_subject_unknown')
  return {
    routeKey: route.routeKey,
    destinationAddress: route.destination,
    assetAddress: route.asset,
    owner: request.owner,
    assetsRaw: request.assetsRaw,
    manifestSha256: MANIFEST_SHA,
  }
}

function validateQuote(quote, frozen, block) {
  if (
    quote?.status !== 'checked_at_finalized_block' ||
    quote.source?.chainId !== 1 ||
    !Number.isSafeInteger(quote.source.blockNumber) ||
    quote.source.blockNumber < 0 ||
    !HASH.test(quote.source.blockHash) ||
    quote.routeKey !== frozen.routeKey ||
    quote.vault?.address !== frozen.destinationAddress ||
    quote.vault?.assetAddress !== frozen.assetAddress ||
    quote.request?.assetsRaw !== frozen.assetsRaw ||
    !NONNEGATIVE_DECIMAL.test(quote.position?.previewRedeemAssetsRaw ?? '') ||
    !['success', 'evm_revert'].includes(quote.simulation?.status) ||
    (block && (quote.source.blockNumber !== block.number || quote.source.blockHash !== block.hash))
  )
    throw Error('requested_holder_quote_identity_invalid')
  safeTime(quote.source.blockTime)
  const measurement = {
    blockNumber: quote.source.blockNumber,
    blockHash: quote.source.blockHash,
    blockAtUtc: quote.source.blockTime,
    claimRaw: quote.position.previewRedeemAssetsRaw,
    simulation: quote.simulation.status,
    reason: quote.simulation.reason ?? null,
  }
  validateMeasurement(measurement, frozen)
  return measurement
}
function validOperators(operators) {
  return (
    Array.isArray(operators) &&
    operators.length === 2 &&
    operators.every((x) => OPERATORS.has(x)) &&
    operators[0] !== operators[1]
  )
}
function validateMeasurement(measurement, frozen) {
  if (
    !measurement ||
    !same(
      Object.keys(measurement).sort(),
      ['blockNumber', 'blockHash', 'blockAtUtc', 'claimRaw', 'simulation', 'reason'].sort(),
    ) ||
    !Number.isSafeInteger(measurement.blockNumber) ||
    measurement.blockNumber < 0 ||
    !HASH.test(measurement.blockHash) ||
    !NONNEGATIVE_DECIMAL.test(measurement.claimRaw ?? '') ||
    !['success', 'evm_revert'].includes(measurement.simulation) ||
    (measurement.simulation === 'success' &&
      (measurement.reason !== null || BigInt(measurement.claimRaw) < BigInt(frozen.assetsRaw))) ||
    (measurement.simulation === 'evm_revert' &&
      ![
        'no_holder_shares',
        'requested_amount_exceeds_preview_claim',
        'unknown_execution_constraint',
      ].includes(measurement.reason)) ||
    (measurement.reason === 'requested_amount_exceeds_preview_claim' &&
      BigInt(measurement.claimRaw) >= BigInt(frozen.assetsRaw)) ||
    (measurement.reason === 'unknown_execution_constraint' &&
      BigInt(measurement.claimRaw) < BigInt(frozen.assetsRaw)) ||
    (measurement.reason === 'no_holder_shares' && measurement.claimRaw !== '0')
  )
    throw Error('requested_holder_measurement_invalid')
  safeTime(measurement.blockAtUtc)
}
function consensus(a, b) {
  if (!same(a, b)) throw Error('requested_holder_two_origin_disagreement')
  return a
}
export async function defaultReader(client, request, now, historical) {
  const quoteModule = await import('../../lib/carry/morphoExitQuote.ts')
  const readMorphoExitQuote =
    quoteModule.readMorphoExitQuote ?? quoteModule.default?.readMorphoExitQuote
  if (typeof readMorphoExitQuote !== 'function')
    throw Error('requested_holder_quote_reader_missing')
  return readMorphoExitQuote(client, request, now, historical)
}
async function paired({ clients, originUrls, request, frozen, now, readQuote = defaultReader }) {
  if (
    !Array.isArray(clients) ||
    clients.length !== 2 ||
    clients[0] === clients[1] ||
    originUrls?.length !== 2
  )
    throw Error('requested_holder_two_origins_required')
  const hosts = originUrls.map(originHost)
  if (hosts[0] === hosts[1]) throw Error('requested_holder_two_origins_required')
  const firstQuote = await readQuote(clients[0], request, now)
  const first = validateQuote(firstQuote, frozen)
  const pin = {
    mode: 'internal_historical_finalized_block',
    blockNumber: BigInt(first.blockNumber),
    blockHash: first.blockHash,
  }
  // viem getCode normalizes raw 0x to undefined. Read the raw pinned RPC response.
  for (const client of clients) {
    const code = await client.request({
      method: 'eth_getCode',
      params: [frozen.owner, { blockHash: first.blockHash, requireCanonical: true }],
    })
    if (code !== '0x') throw Error('requested_holder_owner_code_unproved')
  }
  const secondQuote = await readQuote(clients[1], request, now, pin)
  const second = validateQuote(secondQuote, frozen, {
    number: first.blockNumber,
    hash: first.blockHash,
  })
  return { measured: consensus(first, second), assertedOriginOperators: hosts }
}
function validateIssue(x) {
  if (
    x?.study !== STUDY ||
    x.type !== 'issue' ||
    x.chainId !== 1 ||
    !HORIZONS.every((h, i) => x.horizonsHours?.[i] === h) ||
    x.horizonsHours.length !== 2
  )
    throw Error('requested_holder_issue_invalid')
  const frozen = exactSubject(x.request)
  validateMeasurement(x.baseline, frozen)
  if (
    !same(frozen, x.frozen) ||
    !validOperators(x.assertedOriginOperators) ||
    !same(x.clock, { source: 'local_operator_clock', independentTimestampProof: false }) ||
    !same(x.claims, CLAIMS) ||
    safeTime(x.issuedAtUtc) - safeTime(x.baseline.blockAtUtc) < -120_000 ||
    safeTime(x.issuedAtUtc) - safeTime(x.baseline.blockAtUtc) > 2 * HOUR ||
    !same(
      x.targets,
      HORIZONS.map((horizonHours) => ({
        horizonHours,
        targetAtUtc: iso(safeTime(x.issuedAtUtc) + horizonHours * HOUR),
        deadlineUtc: iso(safeTime(x.issuedAtUtc) + horizonHours * HOUR + WINDOW),
      })),
    ) ||
    x.issueId !==
      sha(
        canonical({
          request: x.request,
          baseline: x.baseline,
          issuedAtUtc: x.issuedAtUtc,
          manifestSha256: MANIFEST_SHA,
        }),
      )
  )
    throw Error('requested_holder_issue_invalid')
}
function validateScore(x, issue) {
  if (
    x?.study !== STUDY ||
    x.type !== 'score' ||
    x.issueId !== issue.issueId ||
    !HORIZONS.includes(x.horizonHours) ||
    !same(x.request, issue.request) ||
    !same(x.frozen, issue.frozen) ||
    x.targetAtUtc !== issue.targets.find((t) => t.horizonHours === x.horizonHours)?.targetAtUtc ||
    x.deadlineUtc !== issue.targets.find((t) => t.horizonHours === x.horizonHours)?.deadlineUtc ||
    !['measured_success', 'measured_failure', 'censored'].includes(x.outcome) ||
    safeTime(x.scoredAtUtc) < safeTime(x.targetAtUtc) ||
    !same(x.claims, CLAIMS)
  )
    throw Error('requested_holder_score_invalid')
  if (x.outcome === 'censored') {
    if (
      x.measurement !== null ||
      x.assertedOriginOperators !== null ||
      !['missed_window', 'window_expired_after_attempts'].includes(x.censorReason) ||
      safeTime(x.scoredAtUtc) <= safeTime(x.deadlineUtc)
    )
      throw Error('requested_holder_score_invalid')
  } else {
    validateMeasurement(x.measurement, issue.frozen)
    if (
      x.censorReason !== null ||
      !x.measurement ||
      !validOperators(x.assertedOriginOperators) ||
      x.measurement.blockNumber <= issue.baseline.blockNumber ||
      safeTime(x.measurement.blockAtUtc) < safeTime(x.targetAtUtc) ||
      safeTime(x.measurement.blockAtUtc) > safeTime(x.deadlineUtc) ||
      safeTime(x.measurement.blockAtUtc) > safeTime(x.scoredAtUtc) + 120_000 ||
      x.outcome !==
        (x.measurement.simulation === 'success' ? 'measured_success' : 'measured_failure')
    )
      throw Error('requested_holder_score_invalid')
  }
}
function validateAttempt(x, issue) {
  const target = issue.targets.find((t) => t.horizonHours === x?.horizonHours)
  if (
    x?.study !== STUDY ||
    x.type !== 'attempt' ||
    x.issueId !== issue.issueId ||
    !target ||
    !same(x.request, issue.request) ||
    x.targetAtUtc !== target.targetAtUtc ||
    x.deadlineUtc !== target.deadlineUtc ||
    safeTime(x.attemptedAtUtc) < safeTime(target.targetAtUtc) ||
    safeTime(x.attemptedAtUtc) > safeTime(target.deadlineUtc) ||
    !['rpc_or_measurement_error', 'two_origin_disagreement', 'physical_window_unobserved'].includes(
      x.reason,
    )
  )
    throw Error('requested_holder_attempt_invalid')
}
export async function verify(dir = DEFAULT_DIR) {
  const paths = dirs(dir)
  const issues = await readChain(paths.issues, validateIssue)
  if (issues.length > MAX_ISSUES || new Set(issues.map((x) => x.issueId)).size !== issues.length)
    throw Error('requested_holder_issue_replay_invalid')
  const byId = new Map(issues.map((x) => [x.issueId, x]))
  const scores = await readChain(paths.scores, (x) => {
    const issue = byId.get(x.issueId)
    if (!issue) throw Error('requested_holder_score_orphan')
    validateScore(x, issue)
  })
  if (
    scores.length > MAX_SCORES ||
    new Set(scores.map((x) => `${x.issueId}:${x.horizonHours}`)).size !== scores.length
  )
    throw Error('requested_holder_score_replay_invalid')
  const attempts = await readChain(paths.attempts, (x) => {
    const issue = byId.get(x.issueId)
    if (!issue) throw Error('requested_holder_attempt_orphan')
    validateAttempt(x, issue)
  })
  if (attempts.length > MAX_ATTEMPTS) throw Error('requested_holder_attempt_limit')
  return { issues, scores, attempts }
}
export async function issue({
  request,
  clients,
  originUrls,
  dir = DEFAULT_DIR,
  now = () => Date.now(),
  readQuote = defaultReader,
}) {
  const frozen = exactSubject(request)
  const previous = await verify(dir)
  if (previous.issues.length >= MAX_ISSUES) throw Error('requested_holder_issue_limit')
  const issuedMs = now()
  if (!Number.isSafeInteger(issuedMs)) throw Error('requested_holder_time_invalid')
  const { measured: baseline, assertedOriginOperators } = await paired({
    clients,
    originUrls,
    request,
    frozen,
    now: () => issuedMs,
    readQuote,
  })
  if (
    issuedMs - safeTime(baseline.blockAtUtc) < -120_000 ||
    issuedMs - safeTime(baseline.blockAtUtc) > 2 * HOUR
  )
    throw Error('requested_holder_baseline_stale')
  const issuedAtUtc = iso(issuedMs)
  const record = {
    study: STUDY,
    type: 'issue',
    chainId: 1,
    request,
    frozen,
    baseline,
    assertedOriginOperators,
    issuedAtUtc,
    horizonsHours: [...HORIZONS],
    targets: HORIZONS.map((horizonHours) => ({
      horizonHours,
      targetAtUtc: iso(issuedMs + horizonHours * HOUR),
      deadlineUtc: iso(issuedMs + horizonHours * HOUR + WINDOW),
    })),
    clock: { source: 'local_operator_clock', independentTimestampProof: false },
    claims: CLAIMS,
  }
  record.issueId = sha(canonical({ request, baseline, issuedAtUtc, manifestSha256: MANIFEST_SHA }))
  if (previous.issues.some((x) => x.issueId === record.issueId))
    throw Error('requested_holder_issue_duplicate')
  return appendChain(dirs(dir).issues, record, validateIssue)
}
export async function score({
  issueId,
  horizonHours,
  request,
  clients,
  originUrls,
  dir = DEFAULT_DIR,
  now = () => Date.now(),
  readQuote = defaultReader,
}) {
  const state = await verify(dir)
  const issued = state.issues.find((x) => x.issueId === issueId)
  if (!issued || !HORIZONS.includes(horizonHours)) throw Error('requested_holder_issue_unknown')
  const issuesById = new Map(state.issues.map((entry) => [entry.issueId, entry]))
  if (request && !same(request, issued.request)) throw Error('requested_holder_tuple_changed')
  if (state.scores.some((x) => x.issueId === issueId && x.horizonHours === horizonHours))
    throw Error('requested_holder_score_duplicate')
  const target = issued.targets.find((x) => x.horizonHours === horizonHours)
  const scoredMs = now()
  if (!Number.isSafeInteger(scoredMs)) throw Error('requested_holder_time_invalid')
  if (scoredMs < safeTime(target.targetAtUtc))
    return { status: 'not_due', targetAtUtc: target.targetAtUtc }
  let measurement = null,
    censorReason = null,
    outcome = 'censored',
    assertedOriginOperators = null
  if (scoredMs > safeTime(target.deadlineUtc))
    censorReason = state.attempts.some(
      (x) => x.issueId === issueId && x.horizonHours === horizonHours,
    )
      ? 'window_expired_after_attempts'
      : 'missed_window'
  else {
    try {
      const result = await paired({
        clients,
        originUrls,
        request: issued.request,
        frozen: issued.frozen,
        now: () => scoredMs,
        readQuote,
      })
      assertedOriginOperators = result.assertedOriginOperators
      measurement = result.measured
      const blockMs = safeTime(measurement.blockAtUtc)
      if (blockMs < safeTime(target.targetAtUtc) || blockMs > safeTime(target.deadlineUtc)) {
        measurement = null
        censorReason = 'physical_window_unobserved'
      } else
        outcome = measurement.simulation === 'success' ? 'measured_success' : 'measured_failure'
    } catch (error) {
      censorReason =
        error?.message === 'requested_holder_two_origin_disagreement'
          ? 'two_origin_disagreement'
          : 'rpc_or_measurement_error'
    }
  }
  if (scoredMs <= safeTime(target.deadlineUtc) && outcome === 'censored') {
    if (state.attempts.length >= MAX_ATTEMPTS) throw Error('requested_holder_attempt_limit')
    const attempt = await appendChain(
      dirs(dir).attempts,
      {
        study: STUDY,
        type: 'attempt',
        issueId,
        horizonHours,
        request: issued.request,
        targetAtUtc: target.targetAtUtc,
        deadlineUtc: target.deadlineUtc,
        attemptedAtUtc: iso(scoredMs),
        reason: censorReason,
      },
      (x) => {
        const sourceIssue = issuesById.get(x.issueId)
        if (!sourceIssue) throw Error('requested_holder_attempt_orphan')
        validateAttempt(x, sourceIssue)
      },
    )
    return {
      status: 'pending',
      reason: censorReason,
      attemptSequence: attempt.sequence,
      deadlineUtc: target.deadlineUtc,
    }
  }
  const record = {
    study: STUDY,
    type: 'score',
    issueId,
    horizonHours,
    request: issued.request,
    frozen: issued.frozen,
    targetAtUtc: target.targetAtUtc,
    deadlineUtc: target.deadlineUtc,
    scoredAtUtc: iso(scoredMs),
    outcome,
    censorReason,
    measurement,
    assertedOriginOperators,
    claims: CLAIMS,
  }
  return appendChain(dirs(dir).scores, record, (x) => {
    const sourceIssue = issuesById.get(x.issueId)
    if (!sourceIssue) throw Error('requested_holder_score_orphan')
    validateScore(x, sourceIssue)
  })
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] !== '--verify' || process.argv.length > 4) {
    process.stderr.write(
      'Only --verify [dir] is supported; issue/score require explicit programmatic opt-in.\n',
    )
    process.exitCode = 2
  } else
    verify(process.argv[3])
      .then((state) => {
        process.stdout.write(
          `${JSON.stringify({ study: STUDY, issues: state.issues.length, scores: state.scores.length, attempts: state.attempts.length })}\n`,
        )
      })
      .catch(() => {
        process.stderr.write('requested_holder_verify_failed\n')
        process.exitCode = 1
      })
}
