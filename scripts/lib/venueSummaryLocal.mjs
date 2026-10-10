// Read-only projection of the sealed local venue snapshot chain for the venue
// permalink. It contains observed state, never a reconstructed flow window.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import {
  LOCAL_VENUE_SNAPSHOT_ROOT,
  MAX_LOCAL_SNAPSHOT_BYTES,
  MAX_LOCAL_SNAPSHOTS_PER_VENUE,
  verifyLocalVenueSnapshots,
} from './localVenueSnapshotStore.mjs'
import { aTokenSuppliedUsd } from './venue-reads.mjs'
import { coverageFor, instantExitUsd } from './alarmRules.mjs'

const MAX_AGE_MS = 3 * 60 * 60 * 1_000
const FUTURE_SKEW_MS = 5 * 60 * 1_000
const DIGITS = /^\d+$/
const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : null)
const measured = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

function suppliedStock(record, cfg) {
  const params = record?.measurement?.params
  if (
    params?.kind !== 'atoken-liquidity' ||
    lower(params.aToken) !== lower(cfg.address) ||
    lower(params.underlying) !== lower(cfg.underlying) ||
    Number(params.decimals) !== cfg.decimals ||
    params.reads?.totalSupply !== true
  )
    return null
  const usd = aTokenSuppliedUsd(params)
  const block = Number(record.source?.block)
  if (usd === null || !Number.isSafeInteger(block) || block <= 0) return null
  return { usd, block, observedAt: record.observedAtUtc }
}

function readBoundedPriorRecord(root, venue, sequence) {
  const path = join(root, venue, `${String(sequence).padStart(12, '0')}.json`)
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const file = fstatSync(fd)
    if (!file.isFile() || file.size <= 0 || file.size > MAX_LOCAL_SNAPSHOT_BYTES)
      throw new Error('local_summary_prior_size')
    const bytes = Buffer.alloc(file.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (count <= 0) throw new Error('local_summary_prior_changed')
      offset += count
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0)
      throw new Error('local_summary_prior_changed')
    const raw = bytes.toString('utf8')
    const record = JSON.parse(raw)
    const { sha256, ...body } = record
    if (
      raw !== `${JSON.stringify(record)}\n` ||
      sha256 !== createHash('sha256').update(JSON.stringify(body)).digest('hex') ||
      record.venue !== venue ||
      record.sequence !== sequence
    )
      throw new Error('local_summary_prior_changed')
    return record
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function latestPriorSuppliedStock(root, venue, cfg, firstReplay) {
  if (firstReplay.count > MAX_LOCAL_SNAPSHOTS_PER_VENUE)
    throw new Error('local_summary_prior_count')
  let selected = null
  for (let sequence = firstReplay.count - 1; sequence >= 1; sequence -= 1) {
    selected = suppliedStock(readBoundedPriorRecord(root, venue, sequence), cfg)
    if (selected !== null) break
  }
  // A replacement or append between the first replay and bounded lookback
  // cannot mix an earlier supply read with a different latest cash history.
  const secondReplay = verifyLocalVenueSnapshots(venue, root)
  if (
    secondReplay.count !== firstReplay.count ||
    secondReplay.last?.sha256 !== firstReplay.last?.sha256
  )
    throw new Error('local_summary_chain_changed')
  return selected
}

export function readLocalVenueSummary(
  venue,
  cfg,
  { root = LOCAL_VENUE_SNAPSHOT_ROOT, nowMs = Date.now() } = {},
) {
  const firstReplay = verifyLocalVenueSnapshots(venue, root)
  const { count, last } = firstReplay
  if (!last)
    return {
      status: 'missing',
      count,
      observed: null,
      suppliedTvl: null,
      times: null,
      hasInstant: false,
    }

  const block = Number(last.source.block)
  if (!Number.isSafeInteger(block) || block <= 0 || last.measurement.params?.kind !== cfg.kind)
    throw new Error('local_summary_identity_mismatch')
  const params = last.measurement.params
  if (
    (cfg.kind === 'atoken-liquidity' &&
      (lower(params.aToken) !== lower(cfg.address) ||
        lower(params.underlying) !== lower(cfg.underlying) ||
        Number(params.decimals) !== cfg.decimals)) ||
    (cfg.kind === 'erc4626-vault-cash' &&
      (lower(params.vault) !== lower(cfg.address) ||
        lower(params.underlying) !== lower(cfg.underlying)))
  )
    throw new Error('local_summary_identity_mismatch')

  const sourceAt = new Date(last.source.timestamp * 1_000).toISOString()
  const fetchedAt = last.observedAtUtc
  const firstLocalReceiptAt = last.firstLocalReceiptAtUtc
  const times = { sourceAt, fetchedAt, firstLocalReceiptAt }
  if (
    [sourceAt, fetchedAt, firstLocalReceiptAt].some(
      (time) => Date.parse(time) > nowMs + FUTURE_SKEW_MS,
    )
  )
    return { status: 'unknown', count, observed: null, suppliedTvl: null, times, hasInstant: false }
  const status =
    nowMs - Date.parse(sourceAt) > MAX_AGE_MS || nowMs - Date.parse(fetchedAt) > MAX_AGE_MS
      ? 'stale'
      : 'fresh'
  const observed = {
    block,
    observedAt: fetchedAt,
    sourceAt,
    fetchedAt,
    firstLocalReceiptAt,
    instantUsd: last.measurement.instantUsd,
    params: {
      totalAssets:
        typeof params.totalAssets === 'string' && DIGITS.test(params.totalAssets)
          ? params.totalAssets
          : null,
      cooldownDuration: measured(params.cooldownDuration),
      utilizationPct: measured(params.utilization_pct),
      depthUsd: last.measurement.depthUsd,
      depthSkewPct: measured(params.depth_skew_pct),
      depthMarkets: Array.isArray(params.depthMarkets) ? params.depthMarkets : null,
    },
  }
  let suppliedTvl = cfg.kind === 'atoken-liquidity' ? suppliedStock(last, cfg) : null
  if (cfg.kind === 'atoken-liquidity' && suppliedTvl === null && count > 1)
    suppliedTvl = latestPriorSuppliedStock(root, venue, cfg, firstReplay)
  const hasInstant =
    instantExitUsd({ instant_usd: last.measurement.instantUsd, params, observed_at: fetchedAt }) !==
    null
  return { status, count, observed, suppliedTvl, times, hasInstant }
}

export function localObservationIsNewer(local, databaseObserved) {
  return Boolean(
    local?.observed &&
    local.status !== 'unknown' &&
    (!databaseObserved || local.observed.block > databaseObserved.block),
  )
}

export function localOnlyVenueSummary(venue, label, cfg, local) {
  if (!local?.observed || local.status === 'unknown') throw new Error('local_summary_missing')
  return {
    venue,
    label,
    kind: cfg.kind,
    observed: local.observed,
    suppliedTvl: local.suppliedTvl,
    corpus: {
      snapshots: local.count,
      snapshotsObserved: local.count,
      snapshotSpan: { start: null, end: local.observed.observedAt },
      flows: null,
      flowSpan: { start: null, end: null },
      news: null,
      status: 'local_only',
    },
    worstOutflows: {
      d1: null,
      d7: null,
      status: 'unavailable',
      reason: 'legacy_flow_coverage_uncertified',
    },
    alarms: {
      open: [],
      uncovered: coverageFor(cfg, { hasInstant: local.hasInstant }),
      status: 'unknown',
    },
    provenance: {
      storage: 'local_mac_recorder',
      observationStatus: local.status,
      databaseStatus: 'unavailable',
      ...local.times,
    },
  }
}
