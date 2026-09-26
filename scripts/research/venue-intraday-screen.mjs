// Offline exploratory screen over one SHA-sealed observed-snapshot export.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readExport, VENUES } from './venue-intraday-export.mjs'

const HOUR = 3_600_000
const BIN = 6 * HOUR
const HORIZON = 24 * HOUR
const RIGHT_EDGE = 26 * HOUR
const MAX_GAP = 4 * HOUR
const EPISODE_GAP = 48 * HOUR
const COOLDOWN = 24 * HOUR
const finiteNonnegative = (value) =>
  value != null && Number.isFinite(Number(value)) && Number(value) >= 0
const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const validAddress = (address) => /^0x[0-9a-f]{40}$/i.test(String(address))
const validDecimals = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
const identity = (saved, expected) =>
  saved == null ? 'missing' : sameAddress(saved, expected) ? 'match' : 'mismatch'

export function assessMetric(row, config) {
  const p = row.params ?? {}
  if (config.kind === 'atoken-liquidity') {
    if (
      p.kind !== config.kind ||
      !finiteNonnegative(row.instant_usd) ||
      !/^\d+$/.test(String(p.underlyingBalance ?? '')) ||
      Number(p.decimals) !== Number(config.decimals) ||
      p.reads?.underlyingBalance === false ||
      Number(p.priceAssumptionUsd) !== 1
    )
      return null
    const expected = Number(p.underlyingBalance) / 10 ** Number(config.decimals)
    const actual = Number(row.instant_usd)
    if (
      !Number.isFinite(expected) ||
      Math.abs(actual - expected) > Math.max(1e-6, expected * 1e-10)
    )
      return null
    const token = identity(p.underlying, config.underlying)
    const receipt = identity(p.aToken, config.address)
    if (token === 'mismatch' || receipt === 'mismatch') return null
    const onchain = p.underlyingOnchain
    if (onchain != null && !validAddress(onchain)) return null
    if (onchain != null && !sameAddress(onchain, config.underlying)) return null
    const onchainDecimals = p.underlyingDecimalsOnchain
    if (
      onchainDecimals != null &&
      (!validDecimals(onchainDecimals) || onchainDecimals !== Number(config.decimals))
    )
      return null
    if (p.underlyingIdentity === 'mismatch' || p.decimalsIdentity === 'mismatch') return null
    return {
      value: actual,
      identityVerified:
        token === 'match' &&
        receipt === 'match' &&
        p.reads?.underlyingBalance === true &&
        p.reads?.underlyingAsset === true &&
        p.reads?.underlyingDecimals === true &&
        onchain != null &&
        validAddress(onchain) &&
        sameAddress(onchain, config.underlying) &&
        onchainDecimals != null &&
        onchainDecimals === Number(config.decimals) &&
        p.underlyingIdentity === 'match' &&
        p.decimalsIdentity === 'match',
    }
  }
  const expected = (config.depthMarkets ?? []).filter((m) => m.enabled)
  const markets = p.depthMarkets
  if (
    !expected.length ||
    !Array.isArray(markets) ||
    markets.length !== expected.length ||
    !finiteNonnegative(p.depth_usd) ||
    p.depth_complete === false ||
    (p.kind != null && p.kind !== config.kind)
  )
    return null
  const wanted = new Set(expected.map((m) => m.address.toLowerCase()))
  const actual = markets.map((m) => String(m.address ?? '').toLowerCase())
  if (new Set(actual).size !== expected.length || actual.some((address) => !wanted.has(address)))
    return null
  let sum = 0
  let identityVerified = p.depth_complete === true && p.kind === config.kind
  for (const market of expected) {
    const saved = markets.find((m) => m.address?.toLowerCase() === market.address.toLowerCase())
    if (!saved || !finiteNonnegative(saved.exitableUsd)) return null
    if (saved.priceAssumptionUsd != null && Number(saved.priceAssumptionUsd) !== 1) return null
    if (saved.priceAssumptionUsd == null) identityVerified = false
    for (const field of market.kind === 'psm-buffer'
      ? ['kind', 'buffer', 'bufferToken', 'exitFrom']
      : ['kind', 'token0', 'token1', 'exitFrom']) {
      const match = identity(saved[field], market[field])
      if (match === 'mismatch') return null
      if (match === 'missing') identityVerified = false
    }
    if (market.kind === 'psm-buffer') {
      if (saved.reads?.buffer !== true || saved.reads?.decimals !== true) return null
    } else if (
      saved.reads?.reserve0 !== true ||
      saved.reads?.reserve1 !== true ||
      saved.reads?.decimals0 !== true ||
      saved.reads?.decimals1 !== true
    )
      return null
    if (market.kind !== 'psm-buffer' && identity(saved.exitFrom, market.exitFrom) === 'match') {
      const exitIs0 = sameAddress(market.exitFrom, market.token0)
      const exitIs1 = sameAddress(market.exitFrom, market.token1)
      if (!exitIs0 && !exitIs1) return null
      const savedSide = exitIs0 ? saved.reserve1Usd : saved.reserve0Usd
      if (savedSide == null) identityVerified = false
      else if (
        !finiteNonnegative(savedSide) ||
        Math.abs(Number(savedSide) - Number(saved.exitableUsd)) >
          Math.max(1e-6, Number(saved.exitableUsd) * 1e-10)
      )
        return null
    }
    sum += Number(saved.exitableUsd)
  }
  const value = Number(p.depth_usd)
  return Math.abs(sum - value) <= Math.max(1, value * 1e-8) ? { value, identityVerified } : null
}

export function validMetric(row, config) {
  return assessMetric(row, config)?.value ?? null
}

function validCoverage(anchor, later, endMs) {
  if (anchor.ms + RIGHT_EDGE > endMs) return false
  let previous = anchor.ms
  let reached = false
  for (const row of later) {
    if (row.ms - anchor.ms > RIGHT_EDGE) break
    if (row.ms - previous > MAX_GAP) return false
    previous = row.ms
    if (previous - anchor.ms >= HORIZON) {
      reached = true
      break
    }
  }
  return reached
}

function priorMove(valid, anchorIndex) {
  const now = valid[anchorIndex]
  const start = now.ms - BIN
  const prior = valid.find((row, i) => i < anchorIndex && row.ms >= start)
  if (!prior || prior.value === 0) return null
  // The comparator uses only observations acquired by the anchor time.
  return now.value / prior.value - 1
}

function episodes(crossings) {
  const sorted = [...crossings].sort(
    (a, b) =>
      a.crossingAt.localeCompare(b.crossingAt) ||
      Number(b.status === 'target') - Number(a.status === 'target'),
  )
  const result = []
  let episodeStart = -Infinity
  for (const crossing of sorted) {
    const ms = Date.parse(crossing.crossingAt)
    if (ms - episodeStart >= EPISODE_GAP) {
      result.push(crossing)
      episodeStart = ms
    }
  }
  return result
}

function screenStratum(payload, { pinnedOnly, identityOnly }) {
  const results = []
  for (const name of VENUES) {
    const config = payload.config.find((v) => v.name === name)
    if (!config) throw new Error(`Missing venue config: ${name}`)
    const raw = payload.rows.filter(
      (row) => row.venue === name && (!pinnedOnly || row.params?.read_block_pinned === true),
    )
    const assessed = raw.map((row) => ({
      ...row,
      ms: Date.parse(row.observed_at),
      metric: assessMetric(row, config),
    }))
    const valid = assessed
      .filter((row) => row.metric !== null && (!identityOnly || row.metric.identityVerified))
      .map((row) => ({
        ...row,
        value: row.metric.value,
        identityVerified: row.metric.identityVerified,
      }))
      .sort((a, b) => a.ms - b.ms || Number(a.block) - Number(b.block))
    const firstByBin = new Map()
    for (let i = 0; i < valid.length; i++) {
      const bin = Math.floor(valid[i].ms / BIN)
      if (!firstByBin.has(bin)) firstByBin.set(bin, i)
    }
    const anchors = []
    const lastAlert = { rise: -Infinity, fall: -Infinity }
    for (const index of firstByBin.values()) {
      const anchor = valid[index]
      const later = valid.slice(index + 1).filter((row) => row.ms - anchor.ms <= RIGHT_EDGE)
      const labelRows = later.filter((row) => row.ms > anchor.ms && row.ms - anchor.ms <= HORIZON)
      const complete = validCoverage(anchor, later, Date.parse(payload.end))
      const pastMove = priorMove(valid, index)
      const directions = {}
      for (const direction of ['rise', 'fall']) {
        const crossing = labelRows.find((row) =>
          direction === 'rise' ? row.value >= anchor.value * 1.2 : row.value <= anchor.value * 0.8,
        )
        const status =
          anchor.value === 0
            ? 'zero-anchor'
            : !complete
              ? 'censored'
              : crossing
                ? crossing.ms - anchor.ms < BIN
                  ? 'too-soon'
                  : 'target'
                : 'quiet'
        const comparatorTriggered =
          pastMove !== null && (direction === 'rise' ? pastMove >= 0.05 : pastMove <= -0.05)
        const comparatorAlert = comparatorTriggered && anchor.ms - lastAlert[direction] >= COOLDOWN
        if (comparatorAlert) lastAlert[direction] = anchor.ms
        directions[direction] = {
          status,
          crossingAt: complete ? (crossing?.observed_at ?? null) : null,
          leadHours: complete && crossing ? (crossing.ms - anchor.ms) / HOUR : null,
          crossingPct: complete && crossing ? (crossing.value / anchor.value - 1) * 100 : null,
          comparatorAlert,
        }
      }
      anchors.push({
        at: anchor.observed_at,
        identityVerified: anchor.identityVerified,
        complete,
        comparatorPastSixHourMovePct: pastMove === null ? null : pastMove * 100,
        rise: directions.rise,
        fall: directions.fall,
      })
    }
    const channels = {}
    for (const direction of ['rise', 'fall']) {
      const inStatus = (status) => anchors.filter((a) => a[direction].status === status)
      const targets = inStatus('target').map((a) => a[direction])
      const tooSoon = inStatus('too-soon').map((a) => a[direction])
      const alerts = anchors.filter((a) => a[direction].comparatorAlert)
      const episodeStarts = episodes([...targets, ...tooSoon])
      const targetEpisodes = episodeStarts.filter((episode) => episode.status === 'target')
      const tooSoonEpisodes = episodeStarts.filter((episode) => episode.status === 'too-soon')
      // Count each crossing episode at most once even if many anchor alerts overlap it.
      const alertedEpisodes = targetEpisodes.filter((episode) =>
        alerts.some((a) => {
          const alertMs = Date.parse(a.at)
          const crossingMs = Date.parse(episode.crossingAt)
          return (
            alertMs < crossingMs &&
            crossingMs - alertMs <= HORIZON &&
            a[direction].status === 'target'
          )
        }),
      ).length
      const crossingTimes = [...targets, ...tooSoon].map((event) => Date.parse(event.crossingAt))
      const quiet = inStatus('quiet')
      const episodeClearQuiet = quiet.filter((a) => {
        const start = Date.parse(a.at)
        return !crossingTimes.some(
          (crossing) => crossing <= start + HORIZON && crossing + EPISODE_GAP > start,
        )
      })
      let lastControl = -Infinity
      const independentControls24h = episodeClearQuiet.filter((a) => {
        const ms = Date.parse(a.at)
        if (ms - lastControl < HORIZON) return false
        lastControl = ms
        return true
      }).length
      channels[direction] = {
        targetAnchors: targets.length,
        tooSoonAnchors: tooSoon.length,
        quietAnchors: quiet.length,
        censoredAnchors: inStatus('censored').length,
        zeroAnchors: inStatus('zero-anchor').length,
        targetEpisodes48h: targetEpisodes.length,
        tooSoonEpisodes48h: tooSoonEpisodes.length,
        allCrossingEpisodes48h: episodeStarts.length,
        targetLeadHours: targets.map((a) => a.leadHours),
        episodeLeadHours: targetEpisodes.map((a) => a.leadHours),
        episodeClearQuiet: episodeClearQuiet.length,
        independentControls24h,
        comparator: {
          definition: `past-only >=5% ${direction} within preceding 6h; 24h per-venue alert cooldown`,
          evaluableAnchors: anchors.filter((a) => a.comparatorPastSixHourMovePct !== null).length,
          alerts: alerts.length,
          alertedTargetEpisodes: alertedEpisodes,
          targetAlerts: alerts.filter((a) => a[direction].status === 'target').length,
          quietAlerts: alerts.filter((a) => a[direction].status === 'quiet').length,
          tooSoonAlerts: alerts.filter((a) => a[direction].status === 'too-soon').length,
          censoredAlerts: alerts.filter((a) => a[direction].status === 'censored').length,
        },
      }
    }
    results.push({
      venue: name,
      proxy:
        config.kind === 'atoken-liquidity'
          ? 'Aave aToken underlying cash inventory proxy'
          : 'configured secondary-pool/PSM exit-side inventory proxy',
      rawRows: raw.length,
      validRows: valid.length,
      incompleteRows: assessed.filter((row) => row.metric === null).length,
      identityExcludedRows: identityOnly
        ? assessed.filter((row) => row.metric !== null && !row.metric.identityVerified).length
        : 0,
      identityVerifiedRows: valid.filter((row) => row.identityVerified).length,
      identityUnverifiedRows: valid.filter((row) => !row.identityVerified).length,
      sixHourAnchors: anchors.length,
      completeAnchors: anchors.filter((a) => a.complete).length,
      zeroAnchors: anchors.filter((a) => a.rise.status === 'zero-anchor').length,
      directions: channels,
      anchors,
    })
  }
  return {
    study: 'venue-intraday-first-crossing-v1',
    status: 'historical-training-screen; no predictive claim or holdout',
    observationInterval: [payload.start, payload.end],
    fetchedAt: payload.fetchedAt,
    stratum: identityOnly
      ? 'pinned-and-identity-verified'
      : pinnedOnly
        ? 'read_block_pinned-only'
        : 'complete-all',
    results,
  }
}

export function screen(payload) {
  return {
    completeAll: screenStratum(payload, { pinnedOnly: false, identityOnly: false }),
    readBlockPinnedOnly: screenStratum(payload, { pinnedOnly: true, identityOnly: false }),
    pinnedIdentityVerified: screenStratum(payload, { pinnedOnly: true, identityOnly: true }),
  }
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--source')
    throw new Error('Usage: --source <sealed-export.json>')
  const saved = readExport(resolve(args[1]))
  return {
    sourcePayloadSha256: saved.sha256,
    sourcePhysicalSha256: saved.physicalSha256,
    ...screen(saved.payload),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(main(), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
