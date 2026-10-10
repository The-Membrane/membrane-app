#!/usr/bin/env node
// Read-only operational summary. A successful process can issue nothing.
import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STAGES = Object.freeze([
  'quote',
  'holder_observe',
  'holder_duration_issue',
  'now_1h_issue',
  'now_2h_issue',
  'now_24h_issue',
  'now_7d_issue',
])

const STAGE_SET = new Set(STAGES)
const REASONS = new Set(['plan_absent', 'selection_verification_failed'])
const SAFE_QUOTE_REASONS = new Set([
  'disk_reserve',
  'rpc_failure',
  'verification_failed',
  'collection_failed',
])
const SAFE_OUTCOME_REASONS = Object.freeze({
  holder_observe: new Set(['no_eligible_unobserved_checkpoint', 'contract_holder']),
  holder_duration_issue: new Set(['no_quote_checkpoint', 'latest_holder_exit_not_success']),
  now_1h_issue: new Set(['no_latest_verified_holder_duration_anchor']),
  now_2h_issue: new Set(['no_latest_verified_holder_duration_anchor']),
  now_24h_issue: new Set(['no_latest_verified_holder_duration_anchor']),
  now_7d_issue: new Set(['no_latest_verified_holder_duration_anchor']),
})
const OBSERVATIONS = new Set(['success', 'revert', 'provider_error'])
const BASELINES = new Set(['uncalibrated'])
const QUOTE_STUDY = 'curve-crvusd-secondary-prospective-quote-v1'
const UTC = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z`
const NONCE = String.raw`[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}`
const TICK = new RegExp(`^=== recorder tick (${UTC}) ===$`)
const INIT = new RegExp(`^@@recorder-stage-v1 event=tick-init utc=(${UTC}) nonce=(${NONCE})$`)
const START = new RegExp(
  `^@@recorder-stage-v1 event=start stage=([a-z0-9_]+) utc=(${UTC}) nonce=(${NONCE})$`,
)
const END = new RegExp(
  String.raw`^@@recorder-stage-v1 event=end stage=([a-z0-9_]+) utc=(${UTC}) nonce=(${NONCE}) exit=(\d{1,3})$`,
)
const SKIP = new RegExp(
  `^@@recorder-stage-v1 event=skip stage=([a-z0-9_]+) utc=(${UTC}) nonce=(${NONCE}) reason=([a-z_]+)$`,
)
const MAX_LINE_BYTES = 4096

function validUtc(value) {
  return (
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().replace('.000Z', 'Z') === value
  )
}

function emptyStages(status) {
  return Object.fromEntries(STAGES.map((stage) => [stage, { status }]))
}

function safeQuoteReason(line) {
  if (!line.startsWith('{')) return null
  try {
    const parsed = JSON.parse(line)
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'reason,status,study' ||
      parsed.study !== QUOTE_STUDY ||
      parsed.status !== 'error' ||
      !SAFE_QUOTE_REASONS.has(parsed.reason)
    ) {
      return null
    }
    return parsed.reason
  } catch {
    return null
  }
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function safeOutcome(stage, line) {
  if (!SAFE_OUTCOME_REASONS[stage] || !line.startsWith('{')) return null
  try {
    const value = JSON.parse(line)
    if (value === null || Array.isArray(value) || typeof value !== 'object') return null
    if (value.status === 'unavailable') {
      const keys =
        stage === 'holder_observe' && value.reason === 'contract_holder'
          ? ['status', 'reason', 'block']
          : ['status', 'reason']
      if (!exactKeys(value, keys) || !SAFE_OUTCOME_REASONS[stage].has(value.reason)) return null
      if ('block' in value && (!Number.isSafeInteger(value.block) || value.block < 0)) return null
      return { status: 'unavailable', reason: value.reason }
    }
    if (stage === 'holder_observe') {
      if (
        !OBSERVATIONS.has(value.status) ||
        !exactKeys(value, ['status', 'block', 'path']) ||
        !Number.isSafeInteger(value.block) ||
        value.block < 0 ||
        typeof value.path !== 'string' ||
        !value.path
      )
        return null
      return { status: 'observed', observation: value.status }
    }
    if (value.status === 'unchanged') {
      if (!exactKeys(value, ['status', 'path']) || typeof value.path !== 'string' || !value.path)
        return null
      return { status: 'unchanged' }
    }
    if (value.status !== 'issued' || typeof value.path !== 'string' || !value.path) return null
    if (stage === 'holder_duration_issue') {
      if (!exactKeys(value, ['status', 'path', 'baseline']) || !BASELINES.has(value.baseline))
        return null
      return { status: 'issued' }
    }
    if (
      !exactKeys(value, ['status', 'path', 'futureForecast']) ||
      value.futureForecast !== 'unavailable'
    )
      return null
    return { status: 'issued' }
  } catch {
    return null
  }
}

export function createAttemptParser() {
  let tickUtc = null
  let stages = emptyStages('absent')
  let activeStage = null
  let markerSeen = false
  let nonce = null
  let pendingTickUtc = null

  return {
    line(line) {
      const tick = TICK.exec(line)
      if (tick && validUtc(tick[1])) {
        // A child can print log text while its stage is open. Only the parent
        // shell prints the next tick heading after that process has exited.
        if (activeStage !== null) return
        pendingTickUtc = tick[1]
        // A newer uninstrumented tick supersedes the previous complete tick.
        // Its missing markers must not leave an older success looking current.
        tickUtc = tick[1]
        stages = emptyStages('unobserved_uninstrumented')
        markerSeen = false
        nonce = null
        return
      }
      if (pendingTickUtc) {
        const init = INIT.exec(line)
        if (init && validUtc(init[1])) {
          tickUtc = pendingTickUtc
          stages = emptyStages('not_attempted')
          activeStage = null
          markerSeen = false
          nonce = init[2]
          pendingTickUtc = null
          return
        }
        pendingTickUtc = null
      }
      if (!tickUtc) return

      const start = START.exec(line)
      if (start && nonce && start[3] === nonce && STAGE_SET.has(start[1]) && validUtc(start[2])) {
        markerSeen = true
        stages[start[1]] = { status: 'unknown', startedAtUtc: start[2] }
        activeStage = start[1]
        return
      }
      const end = END.exec(line)
      if (end && nonce && end[3] === nonce && STAGE_SET.has(end[1]) && validUtc(end[2])) {
        const exitCode = Number(end[4])
        const prior = stages[end[1]]
        if (exitCode > 255) return
        markerSeen = true
        if (prior.status === 'unknown' && activeStage === end[1]) {
          stages[end[1]] = {
            status: exitCode === 0 ? 'process_success' : 'process_failed',
            startedAtUtc: prior.startedAtUtc,
            endedAtUtc: end[2],
            exitCode,
            ...(end[1] === 'quote' && exitCode !== 0 && prior.safeReason
              ? { safeReason: prior.safeReason }
              : {}),
            ...(SAFE_OUTCOME_REASONS[end[1]]
              ? {
                  outcome:
                    exitCode === 0 && prior.outcome && !prior.outcomeConflict
                      ? prior.outcome
                      : { status: 'unknown' },
                }
              : {}),
          }
          activeStage = null
        } else if (prior.status === 'not_attempted') {
          // A partial log can retain the end while losing the start.
          stages[end[1]] = { status: 'unknown', endedAtUtc: end[2] }
        }
        return
      }
      const skip = SKIP.exec(line)
      if (
        skip &&
        nonce &&
        skip[3] === nonce &&
        STAGE_SET.has(skip[1]) &&
        validUtc(skip[2]) &&
        REASONS.has(skip[4])
      ) {
        markerSeen = true
        if (stages[skip[1]].status === 'not_attempted') {
          stages[skip[1]] = { status: 'skipped', atUtc: skip[2], reason: skip[4] }
        }
        return
      }
      if (activeStage === 'quote' && stages.quote.status === 'unknown') {
        const reason = safeQuoteReason(line)
        if (reason) stages.quote.safeReason = reason
      } else if (activeStage && stages[activeStage].status === 'unknown') {
        const outcome = safeOutcome(activeStage, line)
        if (outcome) {
          const prior = stages[activeStage]
          if (prior.outcome) prior.outcomeConflict = true
          else prior.outcome = outcome
        }
      }
    },
    result() {
      return {
        tickUtc,
        scope: 'selected_stage_process_attempts_and_unverified_cli_outcomes',
        stages: tickUtc && !markerSeen ? emptyStages('unobserved_uninstrumented') : stages,
      }
    },
  }
}

export async function statusFromLog(path) {
  const parser = createAttemptParser()
  const stream = createReadStream(path)
  let pending = ''
  let overflow = false
  for await (const chunk of stream) {
    const text = chunk.toString('utf8')
    for (const part of text.split(/(\n)/)) {
      if (part === '\n') {
        if (!overflow) parser.line(pending.endsWith('\r') ? pending.slice(0, -1) : pending)
        pending = ''
        overflow = false
      } else if (!overflow) {
        pending += part
        if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
          pending = ''
          overflow = true
        }
      }
    }
  }
  if (!overflow && pending) parser.line(pending)
  return parser.result()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/research/recorder-attempt-status.mjs RECORDER_LOG_PATH')
    process.exitCode = 2
  } else {
    statusFromLog(process.argv[2])
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(`recorder-attempt-status: ${error.code ?? 'read_failed'}`)
        process.exitCode = 1
      })
  }
}
