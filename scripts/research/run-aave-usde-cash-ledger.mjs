// Explicit research runner. This does not schedule, notify, or publish a user forecast.
// A dedicated non-owner PostgreSQL role is required by createPgCashLedgerStore.
import { statfsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Pool, neonConfig } from '@neondatabase/serverless'
import { createPgCashScheduleStore } from './aave-usde-cash-schedule-db.mjs'
import { createCashSchedule } from './aave-usde-cash-schedule.mjs'
import {
  createPgCashLedgerStore,
  issueFixedGrid,
  scoreDueIssues,
} from './aave-usde-cash-ledger.mjs'
import { SCORE_AMOUNTS_USD, SCORE_HORIZONS_SECONDS, STUDY } from './aave-usde-prospective-cash.mjs'

const CONFIG_URL = new URL('../../tools/venue-recorder.config.json', import.meta.url)
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MIN_FREE_BYTES = 1024 ** 3
const ATOKEN = '0x4f5923fc5fd4a93352581b38b7cd26943012decf'
const UNDERLYING = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3'
const PREFLIGHT_CODES = new Set([
  'usage_issue_or_score',
  'cash_publisher_database_url_required',
  'cash_publisher_url_must_be_distinct',
  'invalid_cash_publisher_database_url',
  'venue_config_unreadable',
  'aave_usde_config_ineligible',
  'disk_reserve_below_1gib',
  'websocket_unavailable',
  'invalid_schedule_command',
  'schedule_requires_2h_lead',
])
const SHA = /^[0-9a-f]{64}$/

class RunnerError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

export function parseMode(args) {
  if (args.length === 1 && args[0] === '--score') return 'score'
  if (args.length === 2 && ['--issue', '--audit-schedule'].includes(args[0]) && SHA.test(args[1]))
    return args[0].slice(2)
  if (
    [3, 4].includes(args.length) &&
    args[0] === '--publish-schedule' &&
    (args.length === 3 || args[3] === '--apply')
  )
    return 'publish-schedule'
  throw new RunnerError('invalid_schedule_command')
}

export function publisherUrl(env) {
  const value = env.CASH_PUBLISHER_DATABASE_URL
  if (typeof value !== 'string' || !value.trim())
    throw new RunnerError('cash_publisher_database_url_required')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new RunnerError('invalid_cash_publisher_database_url')
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username
  )
    throw new RunnerError('invalid_cash_publisher_database_url')
  const identity = (url) =>
    [
      url.hostname,
      url.port || '5432',
      url.pathname || '/',
      decodeURIComponent(url.username),
      decodeURIComponent(url.password),
    ].join('\u0000')
  for (const other of [env.DATABASE_URL, env.DATABASE_URL_UNPOOLED]) {
    if (!other) continue
    if (value === other) throw new RunnerError('cash_publisher_url_must_be_distinct')
    try {
      if (identity(parsed) === identity(new URL(other)))
        throw new RunnerError('cash_publisher_url_must_be_distinct')
    } catch (error) {
      if (error instanceof RunnerError) throw error
    }
  }
  return value
}

export function selectUsdeConfig(document) {
  const matches = Array.isArray(document?.venues)
    ? document.venues.filter((venue) => venue?.name === 'aave-v3-usde')
    : null
  if (
    !Array.isArray(matches) ||
    matches.length !== 1 ||
    matches[0].enabled !== true ||
    matches[0].kind !== 'atoken-liquidity' ||
    matches[0].address?.toLowerCase() !== ATOKEN ||
    matches[0].underlying?.toLowerCase() !== UNDERLYING ||
    matches[0].decimals !== 18
  )
    throw new RunnerError('aave_usde_config_ineligible')
  return matches[0]
}

const grid = () =>
  SCORE_AMOUNTS_USD.flatMap((amountUsd) =>
    SCORE_HORIZONS_SECONDS.map((horizonSeconds) => ({ amountUsd, horizonSeconds })),
  )

export function summarizeResult(mode, result) {
  if (mode === 'audit-schedule') return { study: STUDY, mode, status: 'audited', ...result }
  if (mode === 'publish-schedule') return { study: STUDY, mode, ...result }
  if (mode === 'score') {
    return {
      study: STUDY,
      mode,
      status: 'processed',
      scanAt: result.scanAt,
      results: result.results.map(({ issueId, status, reason }) => ({
        issueId,
        status,
        reason: reason ?? null,
      })),
    }
  }
  if (result.status === 'processed' && result.issues.length !== grid().length)
    throw new RunnerError('incomplete_issue_grid_result')
  // issueFixedGrid iterates the fixed grid in this exact order. Duplicate
  // acknowledgments omit payload, so retain the positional cell identity.
  const arms =
    result.status === 'processed'
      ? grid().map(({ amountUsd, horizonSeconds }, index) => {
          const row = result.issues[index]
          return {
            amountUsd,
            horizonSeconds,
            status: row.inserted ? 'issued' : 'duplicate',
            issueId: row.id,
          }
        })
      : grid().map((cell) => ({ ...cell, status: 'abstained', reason: result.status }))
  return {
    study: STUDY,
    mode,
    status: result.status,
    cohortEligible: result.cohortEligible === true,
    confirmedAt: result.confirmedAt ?? null,
    runId: result.runId,
    issuedAt: result.issuedAt,
    manifestSha256: result.manifestSha256 ?? null,
    slotId: result.slotId ?? null,
    arms,
  }
}

export function formatFailure(mode, error) {
  const reason = error instanceof RunnerError ? error.code : 'operation_failed'
  const armStatus = PREFLIGHT_CODES.has(reason) ? 'not_started' : 'receipt_unknown'
  return {
    study: STUDY,
    mode,
    status: 'failed',
    reason,
    ...(mode === 'issue' ? { arms: grid().map((cell) => ({ ...cell, status: armStatus })) } : {}),
  }
}

// Dependencies are injectable only to exercise orchestration without a database.
export async function runCashLedger({
  args,
  env,
  readConfig = () => readFile(CONFIG_URL, 'utf8'),
  statfs = statfsSync,
  freeBytes = () => {
    const fs = statfs(REPO_ROOT)
    return fs.bavail * fs.bsize
  },
  makePool = (url) => {
    if (typeof WebSocket !== 'function') throw new RunnerError('websocket_unavailable')
    neonConfig.webSocketConstructor = WebSocket
    return new Pool({ connectionString: url, max: 1 })
  },
  makeStore = createPgCashLedgerStore,
  makeScheduleStore = createPgCashScheduleStore,
  issue = issueFixedGrid,
  score = scoreDueIssues,
  localNow = () => new Date().toISOString(),
}) {
  const mode = parseMode(args)
  if (mode === 'publish-schedule' && args.length === 3) {
    const draft = createCashSchedule({
      plannedAt: localNow(),
      startAt: args[1],
      endAt: args[2],
      cadenceSeconds: 3600,
    })
    if (Date.parse(draft.startAt) - Date.parse(draft.plannedAt) < 2 * 3600 * 1000)
      throw new RunnerError('schedule_requires_2h_lead')
    return summarizeResult(mode, {
      status: 'draft_unpublished',
      startAt: draft.startAt,
      endAt: draft.endAt,
      cadenceSeconds: draft.cadenceSeconds,
      slotCount: draft.slots.length,
      fixedGridArmsPerSlot: grid().length,
      note: 'Local-clock draft only; no database manifest or issue receipts exist',
    })
  }
  const url = publisherUrl(env)
  let config = null
  if (mode === 'issue' || mode === 'publish-schedule') {
    let document
    try {
      document = JSON.parse(await readConfig())
    } catch {
      throw new RunnerError('venue_config_unreadable')
    }
    config = selectUsdeConfig(document)
  }
  const availableBytes = freeBytes()
  if (!Number.isFinite(availableBytes) || availableBytes < MIN_FREE_BYTES)
    throw new RunnerError('disk_reserve_below_1gib')
  const pool = makePool(url)
  try {
    const scheduleStore = mode === 'score' ? null : makeScheduleStore(pool)
    if (mode === 'publish-schedule') {
      const published = await scheduleStore.publishFuture({ startAt: args[1], endAt: args[2] })
      return summarizeResult(mode, {
        status: 'published',
        manifestSha256: published.manifest.sha256,
        inserted: published.inserted,
        persistedAt: published.persistedAt,
        confirmedAt: published.confirmedAt,
        startAt: published.manifest.startAt,
        endAt: published.manifest.endAt,
        slotCount: published.manifest.slots.length,
      })
    }
    if (mode === 'audit-schedule')
      return summarizeResult(mode, await scheduleStore.auditPersisted(args[1]))
    const store = makeStore(pool)
    const result =
      mode === 'issue'
        ? await (async () => {
            const current = await scheduleStore.loadCurrentSlot(args[1])
            const issued = await issue({
              store,
              config,
              schedule: { manifest: current.manifest, slotId: current.slotId },
            })
            if (issued.cohortEligible !== true)
              throw new Error('Bound issue run did not confirm cohort eligibility')
            return {
              ...issued,
              manifestSha256: current.manifest.sha256,
              slotId: current.slotId,
            }
          })()
        : await score({ store })
    return summarizeResult(mode, result)
  } finally {
    await pool.end()
  }
}

async function main() {
  try {
    const result = await runCashLedger({ args: process.argv.slice(2), env: process.env })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.mode === 'score' && result.results.some((row) => row.status === 'failed'))
      process.exitCode = 1
  } catch (error) {
    // PostgreSQL errors can contain connection details. Only controlled codes
    // cross the process boundary; the DB attempt tables retain arm details.
    const mode = ['--issue', '--score', '--audit-schedule', '--publish-schedule'].includes(
      process.argv[2],
    )
      ? process.argv[2].slice(2)
      : null
    process.stderr.write(`${JSON.stringify(formatFailure(mode, error))}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
