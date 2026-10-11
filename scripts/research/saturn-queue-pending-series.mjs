// Append-only sampled gate terms for the fixed Saturn pending-ticket cohort.
// Samples are historical observations; neither a crossing nor a quote predicts payout.
import { createHash } from 'node:crypto'
import { statfsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { writeExclusive } from './apyusd-receipt-cohort-source.mjs'
import { verifyEpisodes } from './saturn-queue-episode-cohort.mjs'
import {
  observe,
  summarize,
  validateCurrentSnapshot,
  verify as verifyCurrent,
} from './saturn-queue-pending-current.mjs'
import { verifyPending } from './saturn-queue-pending-terms.mjs'

export const SERIES_DIR = resolve('data/research/venue-signals/saturn-queue-pending-series-v1')
const DATA_DIR = resolve('data/research/venue-signals')
const STUDY = 'saturn_queue_pending_series_v1'
const SHA = /^[0-9a-f]{64}$/
const FILE = /^([0-9]{6})\.json$/
const MAX_RECORDS = 5000
const MAX_RECORD_BYTES = 90_000
const MIN_FREE_BYTES = 1024 * 1024 * 1024 + 262144
const digest = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const validIso = (value) => {
  if (typeof value !== 'string') return false
  const millis = Date.parse(value)
  return Number.isFinite(millis) && new Date(millis).toISOString() === value
}

export function buildSeriesRecord(snapshot, previous, baseline) {
  const body = {
    study: STUDY,
    sequence: previous ? previous.sequence + 1 : 1,
    previousSha256: previous ? previous.sha256 : baseline.sha256,
    baselineSha256: baseline.sha256,
    snapshot,
  }
  return { ...body, sha256: digest(body) }
}

export function validateSeriesRecord(record, { baseline, previous, cohort, episodes }) {
  if (!record || typeof record !== 'object') throw Error('saturn_series_record_invalid')
  const { sha256, ...body } = record
  const prior = previous ? previous.snapshot : baseline
  const expectedSequence = previous ? previous.sequence + 1 : 1
  if (
    record.study !== STUDY ||
    record.sequence !== expectedSequence ||
    record.sequence > MAX_RECORDS ||
    record.previousSha256 !== (previous ? previous.sha256 : baseline.sha256) ||
    record.baselineSha256 !== baseline.sha256 ||
    !SHA.test(sha256 ?? '') ||
    sha256 !== digest(body)
  )
    throw Error('saturn_series_record_invalid')
  const snapshot = validateCurrentSnapshot(record.snapshot, cohort, episodes)
  if (
    snapshot.sourceSha256 !== baseline.sourceSha256 ||
    !validIso(snapshot.capturedAtUtc) ||
    !validIso(prior.capturedAtUtc) ||
    Date.parse(snapshot.capturedAtUtc) <= Date.parse(prior.capturedAtUtc) ||
    Date.parse(snapshot.capturedAtUtc) < snapshot.block.timestamp * 1000 ||
    snapshot.block.number <= prior.block.number ||
    snapshot.block.timestamp <= prior.block.timestamp ||
    snapshot.block.hash.toLowerCase() === prior.block.hash.toLowerCase() ||
    snapshot.rows.some((row, index) => prior.rows[index].status !== 1 && row.status === 1) ||
    JSON.stringify(snapshot.summary) !== JSON.stringify(summarize(snapshot.rows))
  )
    throw Error('saturn_series_transition_invalid')
  return record
}

export function validateSeriesRecords(records, context) {
  let previous = null
  for (const record of records) {
    validateSeriesRecord(record, { ...context, previous })
    previous = record
  }
  return {
    samples: records.length,
    lastBlock: previous ? previous.snapshot.block.number : context.baseline.block.number,
    lastSha256: previous ? previous.sha256 : context.baseline.sha256,
    requestedPriceGated: (previous ? previous.snapshot : context.baseline).summary
      .requestedPriceGated,
  }
}

// Compare only tickets still requested in both samples. A terminal status is
// neither a price-gate recovery nor proof of the holder receiving AUSD.
export function summarizeGateChange(previous, current) {
  const change = {
    previousBlock: previous.block.number,
    previousEvidenceSha256: previous.sha256,
    newlyGated: 0,
    newlyQuoteEligible: 0,
    stillGatedDeeper: 0,
  }
  for (const [index, row] of current.rows.entries()) {
    const prior = previous.rows[index]
    if (prior.ticketId !== row.ticketId) throw Error('saturn_series_ticket_order_invalid')
    if (prior.status !== 1 || row.status !== 1) continue
    if (prior.belowMin === false && row.belowMin === true) change.newlyGated++
    else if (prior.belowMin === true && row.belowMin === false) change.newlyQuoteEligible++
    else if (prior.belowMin === true && row.belowMin === true) {
      const oldMargin =
        (BigInt(prior.quoteUsdatRaw) * 10n ** 18n) / BigInt(prior.sharesRaw) -
        BigInt(prior.minSharePriceRaw)
      const newMargin =
        (BigInt(row.quoteUsdatRaw) * 10n ** 18n) / BigInt(row.sharesRaw) -
        BigInt(row.minSharePriceRaw)
      if (newMargin < oldMargin) change.stillGatedDeeper++
    }
  }
  return change
}

export async function verifySeries(directory = SERIES_DIR, evidence) {
  const [baseline, cohort, episodes] = evidence
    ? [evidence.baseline, evidence.cohort, evidence.episodes]
    : await Promise.all([verifyCurrent(), verifyPending(), verifyEpisodes()])
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    names = []
  }
  names.sort()
  if (
    names.length > MAX_RECORDS ||
    names.some((name, index) => !FILE.test(name) || Number(FILE.exec(name)[1]) !== index + 1)
  )
    throw Error('saturn_series_files_invalid')
  const records = []
  for (const name of names) {
    const bytes = await readFile(join(directory, name), 'utf8')
    if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw Error('saturn_series_oversize')
    const record = JSON.parse(bytes)
    if (bytes !== JSON.stringify(record) + '\n') throw Error('saturn_series_file_invalid')
    validateSeriesRecord(record, {
      baseline,
      previous: records.at(-1) ?? null,
      cohort,
      episodes,
    })
    records.push(record)
  }
  return {
    baseline,
    records,
    summary: validateSeriesRecords(records, { baseline, cohort, episodes }),
  }
}

export async function captureSeries(directory = SERIES_DIR) {
  const disk = statfsSync(DATA_DIR)
  if (Number(disk.bavail) * Number(disk.bsize) < MIN_FREE_BYTES)
    throw Error('saturn_series_disk_reserve')
  const verified = await verifySeries(directory)
  if (verified.records.length >= MAX_RECORDS) throw Error('saturn_series_full')
  const snapshot = await observe()
  const context = {
    baseline: verified.baseline,
    previous: verified.records.at(-1) ?? null,
    cohort: await verifyPending(),
    episodes: await verifyEpisodes(),
  }
  const record = buildSeriesRecord(snapshot, context.previous, context.baseline)
  validateSeriesRecord(record, context)
  const name = String(record.sequence).padStart(6, '0') + '.json'
  await writeExclusive(join(directory, name), record)
  return record
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2]
    if (process.argv.length !== 3 || !['--capture', '--verify'].includes(mode))
      throw Error('usage: --capture|--verify')
    if (mode === '--capture') {
      const record = await captureSeries()
      process.stdout.write(
        JSON.stringify({
          sequence: record.sequence,
          block: record.snapshot.block.number,
          sha256: record.sha256,
        }) + '\n',
      )
    } else {
      const verified = await verifySeries()
      process.stdout.write(JSON.stringify(verified.summary) + '\n')
    }
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n')
    process.exitCode = 1
  }
}
