/** Offline exact-roster reconciliation. Retrospective funding diagnostics cannot establish holder forecasts. */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import { loadPinnedAudit } from './conditional-cash-time-holdout.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const ROSTER_SHA256 = '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3'
export const BACKTEST_FILE =
  'data/research/venue-signals/retrospective-native-funding-backtest-2026-10-08T02-34-33-final.json'
export const BACKTEST_SHA256 = 'b3d1bd6359b521d4bf2d144bc703ea8b3834df92ce6ffa7203e3c26bdf5543be'
export const OUTPUT_FILE =
  'data/research/venue-signals/all-venue-retrospective-funding-coverage-2026-10-08.json'
const sha = (value) => createHash('sha256').update(value).digest('hex')
const id = (row) => `${row.routeKey}\0${row.destination}\0${row.asset}`
const destinationId = (row) => `${row.routeKey}\0${row.destination}`
const fail = (reason) => {
  throw Error(`all_venue_funding_${reason}`)
}
const utc = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value

export function authenticateFundingBacktest(text) {
  if (sha(text) !== BACKTEST_SHA256) fail('backtest_file_pin_mismatch')
  const report = JSON.parse(text)
  const { bodySha256, ...body } = report
  if (sha(JSON.stringify(body)) !== bodySha256) fail('backtest_body_seal_mismatch')
  return report
}

/** Reconciles supplied verifier results; the production builder authenticates every input first. */
export function reconcileFundingCoverage(manifest, audit, backtest) {
  if (
    manifest.sha256 !== ROSTER_SHA256 ||
    sha(manifest.payload) !== ROSTER_SHA256 ||
    manifest.payload !== JSON.stringify(manifest.subjects)
  )
    fail('roster_pin_mismatch')
  if (
    !utc(backtest.analysisAtUtc) ||
    backtest.scope !== 'funding_only' ||
    backtest.historyResults.length !== 64
  )
    fail('backtest_shape')
  const roster = manifest.subjects.map((row) => ({
    routeKey: row.route_key,
    destination: row.destination,
    asset: row.asset,
  }))
  if (
    roster.length !== 67 ||
    new Set(roster.map(id)).size !== 67 ||
    new Set(roster.map((row) => row.routeKey)).size !== 25
  )
    fail('core_roster_counts')
  const histories = new Map()
  for (const result of backtest.historyResults) {
    const key = id(result.identity)
    const source = audit.histories[key]
    if (
      histories.has(key) ||
      result.historyKey !== key ||
      !source ||
      JSON.stringify(source.identity) !== JSON.stringify(result.identity) ||
      JSON.stringify(source.witness) !== JSON.stringify(result.witness) ||
      result.acquisitionAtUtc !== source.witness.availableAt ||
      !utc(result.acquisitionAtUtc) ||
      Date.parse(result.acquisitionAtUtc) > Date.parse(backtest.analysisAtUtc)
    )
      fail('history_identity_or_acquisition')
    histories.set(key, result)
  }
  const exclusions = new Map(audit.exclusions.map((row) => [destinationId(row), row]))
  if (
    exclusions.size !== 4 ||
    JSON.stringify(backtest.exclusions) !== JSON.stringify(audit.exclusions)
  )
    fail('exclusion_mismatch')
  const rows = roster.map((identity) => {
    const history = histories.get(id(identity))
    const exclusion = exclusions.get(destinationId(identity))
    if (Boolean(history) === Boolean(exclusion)) fail('core_partition')
    if (history && history.witness.manifestSha256 !== ROSTER_SHA256) fail('core_manifest')
    return {
      identity,
      scope: history ? 'native_original_asset_funding_only' : 'partial_or_foreign_asset_stage_only',
      nativeFinalOriginalAssetHistory: Boolean(history),
      holderFacts: 'holder_facts_unavailable',
      probability: null,
      forecastValidated: false,
      prospectiveValidated: false,
      holderExecutableExit: false,
      exclusion: exclusion?.reason ?? null,
      censorReasons: history
        ? [...new Set(history.horizons.flatMap((h) => Object.keys(h.censorReasons)))]
        : ['native_final_original_asset_history_unavailable', exclusion.reason],
      historyKey: history?.historyKey ?? null,
      acquisitionAtUtc: history?.acquisitionAtUtc ?? null,
      witness: history?.witness ?? null,
      pointCount: history?.pointCount ?? 0,
      horizons: history?.horizons ?? [],
    }
  })
  const coreKeys = new Set(roster.map(id))
  const supplemental = [...histories]
    .filter(([key]) => !coreKeys.has(key))
    .map(([, result]) => result)
  const expectedSupplemental = manifest.supplementalSubjects.map((row) =>
    id({ routeKey: row.route_key, destination: row.destination, asset: row.asset }),
  )
  if (
    supplemental.length !== 1 ||
    expectedSupplemental.length !== 1 ||
    id(supplemental[0].identity) !== expectedSupplemental[0]
  )
    fail('supplemental_partition')
  const nativeRows = rows.filter((row) => row.nativeFinalOriginalAssetHistory)
  const groups = [...new Set(roster.map((row) => row.routeKey))].map((routeKey) => ({
    routeKey,
    destinations: rows.filter((row) => row.identity.routeKey === routeKey),
  }))
  const nativeGroups = new Set(nativeRows.map((row) => row.identity.routeKey)).size
  if (nativeRows.length !== 63 || nativeGroups !== 21) fail('native_partition_counts')
  const jointClocks = [
    ...backtest.susdeJoint.acquisitionClocks.map((clock) => clock.availableAtUtc),
    backtest.apyJoint.acquisitionAtUtc,
  ]
  if (
    jointClocks.some(
      (clock) => !utc(clock) || Date.parse(clock) > Date.parse(backtest.analysisAtUtc),
    )
  )
    fail('joint_acquisition_after_analysis')
  const body = {
    schemaVersion: 1,
    label: 'Retrospective reconstructed funding-only coverage; not validated holder forecasts',
    analysisAtUtc: backtest.analysisAtUtc,
    scope: 'funding_only',
    probability: null,
    holderFacts: 'holder_facts_unavailable',
    calibratedProbability: false,
    prospectiveValidated: false,
    holderExecutableExit: false,
    source: {
      rosterSha256: ROSTER_SHA256,
      backtestFile: BACKTEST_FILE,
      backtestFileSha256: BACKTEST_SHA256,
      backtestBodySha256: backtest.bodySha256,
      auditBodySha256: audit.sha256,
    },
    counts: {
      coreGroups: groups.length,
      coreDestinations: rows.length,
      nativeOriginalAssetFundingGroups: nativeGroups,
      nativeOriginalAssetFundingDestinations: nativeRows.length,
      excludedFinalOriginalAssetGroups: 4,
      excludedFinalOriginalAssetDestinations: 4,
      supplementalGroups: 1,
      supplementalDestinations: 1,
    },
    limits: [
      'All 25/67 entries are researched scope, not full holder model coverage.',
      'Existing ten connected conditional holder groups are separate qualification; funding folds do not qualify the other 48 Morpho destinations.',
      'Fluid USDC-stage funding is not original USDT exit cash.',
      'Errors remain per identity and raw native channel; cross-asset raw errors are not added.',
      'Acquisition clocks are real; simulated issue, donor and outcome clocks remain original historical clocks.',
      'sUSDe joint has four anchors and one 24h chronological fold; APY joint has two anchors and insufficient training plus holdout. Vault-only cash scoring is separate.',
    ],
    groups,
    supplemental: { scope: 'outside_core_denominators_funding_only', histories: supplemental },
    jointFunding: { susde: backtest.susdeJoint, apy: backtest.apyJoint },
  }
  return { ...body, bodySha256: sha(JSON.stringify(body)) }
}

export async function buildAllVenueRetrospectiveFundingCoverage() {
  const manifest = await buildSubjectManifest()
  const audit = loadPinnedAudit()
  const text = readBoundedReceiptFile(resolve(ROOT, BACKTEST_FILE), {
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
    totalBytes: 0,
  })
  return reconcileFundingCoverage(manifest, audit, authenticateFundingBacktest(text))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await buildAllVenueRetrospectiveFundingCoverage()
  const bytes = JSON.stringify(report, null, 2) + '\n'
  writeFileSync(resolve(ROOT, OUTPUT_FILE), bytes, { flag: 'wx', mode: 0o600 })
  console.log(
    JSON.stringify({
      path: OUTPUT_FILE,
      bytes: Buffer.byteLength(bytes),
      sha256: sha(bytes),
      counts: report.counts,
    }),
  )
}
