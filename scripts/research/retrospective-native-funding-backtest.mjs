/** Bounded offline retrospective analysis. No providers, env reads, or forecast enrollment. */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import {
  loadPinnedAudit,
  AUDIT_PATH,
  AUDIT_SHA,
  HORIZONS,
} from './conditional-cash-time-holdout.mjs'
import * as math from '../../lib/venueForecast/retrospectiveFundingBacktest.ts'
import * as susde from '../../lib/carry/susdeJointHistoryPins.ts'
const retrospectiveFundingFold =
  math.retrospectiveFundingFold ?? math.default?.retrospectiveFundingFold
const SUSDE = susde.SUSDE_JOINT_HISTORY_PIN ?? susde.default?.SUSDE_JOINT_HISTORY_PIN
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hash = (x) => createHash('sha256').update(x).digest('hex')
const SUSDE_MANIFEST_SHA = '4219be74f4e986f2a10f29b0d2797f7b33e450f325bf4c0f643bddfc20970eec'
const APY_FILE = 'data/research/venue-signals/apyusd-joint-native-history-2026-10-08T00-35.json'
const APY_SHA = '602b7e9803141ddfb93a327c63f4d23a8e44d39b9d4902802e55aa794aa7bf3d'
const APY_BODY = 'e9a73739a9155551cc8309201f7af853394916da02c9c99ccdd7adbb7f00957c'
function pinnedJson(path, filePin, bodyPin, budget) {
  const text = readBoundedReceiptFile(resolve(ROOT, path), budget)
  if (hash(text) !== filePin) throw Error('retrospective_file_pin_mismatch')
  const value = JSON.parse(text),
    { bodySha256, ...body } = value
  if (bodySha256 !== bodyPin || hash(JSON.stringify(body)) !== bodyPin)
    throw Error('retrospective_body_pin_mismatch')
  return value
}
function summarize(historyKey, history, analysisAtUtc) {
  const { identity, witness } = history
  const native = [{ key: 'cash', assetAddress: identity.asset, decimals: identity.assetDecimals }]
  const points = history.points.map((p) => ({
    anchor: p[0],
    sourceAtUtc: p[3],
    availableAtUtc: witness.availableAt,
    provenanceRef: `${witness.manifestSha256}:${p[1]}:${p[2]}`,
    valuesByChannel: { cash: p[4] },
  }))
  const horizons = HORIZONS.map((horizonHours) => {
    const folds = []
    for (let sourceIndex = 2; sourceIndex < points.length; sourceIndex++) {
      const issue = points[sourceIndex].sourceAtUtc
      const outcomeIndex = points.findIndex(
        (p) => Date.parse(p.sourceAtUtc) === Date.parse(issue) + horizonHours * 3600000,
      )
      if (outcomeIndex < 0) {
        folds.push({ status: 'censored', reason: 'missing_exact_outcome', sourceIndex })
        continue
      }
      folds.push(
        retrospectiveFundingFold(
          {
            analysisAtUtc,
            simulatedIssueAtUtc: issue,
            horizonHours,
            outcomeToleranceSeconds: 0,
            maxGapSeconds: 91800,
            channels: native,
            history: points,
            sourceIndex,
            outcomeIndex,
            thresholdsByChannel: {
              cash: [10n, 50n, 90n].map((p) =>
                String((BigInt(points[sourceIndex].valuesByChannel.cash) * p) / 100n),
              ),
            },
          },
          () => true,
        ),
      ) // points were copied from loadPinnedAudit's externally authenticated immutable snapshot
    }
    const scored = folds.filter((f) => f.status === 'scored'),
      censored = folds.filter((f) => f.status === 'censored')
    const sum = (key) =>
      String(scored.reduce((total, f) => total + BigInt(f.comparisonByChannel.cash[key]), 0n))
    return {
      horizonHours,
      candidateFolds: folds.length,
      scoredFolds: scored.length,
      censoredFolds: censored.length,
      censorReasons: Object.fromEntries(
        [...new Set(censored.map((f) => f.reason))].map((reason) => [
          reason,
          censored.filter((f) => f.reason === reason).length,
        ]),
      ),
      absoluteErrorSumByChannel: { cash: sum('absoluteErrorRaw') },
      persistenceAbsoluteErrorSumByChannel: { cash: sum('persistenceAbsoluteErrorRaw') },
      signedErrorSumByChannel: { cash: sum('signedErrorRaw') },
      bandContainsActualFolds: scored.filter(
        (f) => f.comparisonByChannel.cash.empiricalBandContainsActual,
      ).length,
      diagnosticThresholds: [10, 50, 90].map((percent, i) => ({
        originCashPercent: percent,
        holderQ: false,
        actualCoveringFolds: scored.filter(
          (f) => f.comparisonByChannel.cash.thresholdCoverage[i].actualCovers,
        ).length,
        scenarioCoveringCount: scored.reduce(
          (n, f) => n + f.comparisonByChannel.cash.thresholdCoverage[i].scenarioCoverage.numerator,
          0,
        ),
        scenarioTotal: scored.reduce((n, f) => n + f.scenarioCount, 0),
      })),
      exampleScoredFold: scored[0] ? { ...scored[0], acquisitionClocks: undefined } : null,
      foldsSha256: hash(JSON.stringify(folds)),
    }
  })
  return {
    historyKey,
    identity,
    witness,
    scope:
      identity.routeKey === 'apxUSD → ApyUSD [apxUSD]'
        ? 'vault_cash_only_not_receipt_or_holder'
        : 'native_cash_only_not_holder',
    acquisitionAtUtc: witness.availableAt,
    pointCount: points.length,
    horizons,
  }
}
export function buildRetrospectiveFundingReport(analysisAtUtc) {
  if (
    typeof analysisAtUtc !== 'string' ||
    !Number.isSafeInteger(Date.parse(analysisAtUtc)) ||
    new Date(Date.parse(analysisAtUtc)).toISOString() !== analysisAtUtc
  )
    throw Error('invalid_analysis_clock')
  if (Date.parse(analysisAtUtc) > Date.now()) throw Error('analysis_clock_in_future')
  const audit = loadPinnedAudit()
  const budget = { maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 6 * 1024 * 1024, totalBytes: 0 }
  if (
    hash(readBoundedReceiptFile(resolve(ROOT, 'lib/carry/susdeJointHistoryPins.ts'), budget)) !==
    SUSDE_MANIFEST_SHA
  )
    throw Error('susde_manifest_pin_mismatch')
  const paired = pinnedJson(SUSDE.file, SUSDE.fileSha256, SUSDE.bodySha256, budget)
  const rows = paired.observation.rows
  if (
    rows.length !== 4 ||
    SUSDE.rows.some((expected, i) => Object.entries(expected).some(([k, v]) => rows[i][k] !== v))
  )
    throw Error('susde_joint_rows_mismatch')
  const apy = pinnedJson(APY_FILE, APY_SHA, APY_BODY, budget)
  if (
    apy.replayed.status !== 'internally_consistent_paired_native_history' ||
    apy.replayed.points.length !== 2
  )
    throw Error('apy_joint_points_mismatch')
  const susdeJoint = retrospectiveFundingFold(
    {
      analysisAtUtc,
      simulatedIssueAtUtc: SUSDE.rows[2].sourceAt,
      horizonHours: 24,
      outcomeToleranceSeconds: 0,
      maxGapSeconds: 91800,
      sourceIndex: 2,
      outcomeIndex: 3,
      channels: ['vault', 'silo'].map((key) => ({
        key,
        assetAddress: SUSDE.addresses.asset,
        decimals: SUSDE.assetDecimals,
      })),
      history: SUSDE.rows.map((row) => ({
        anchor: row.index,
        sourceAtUtc: row.sourceAt,
        availableAtUtc: row.availableAt,
        provenanceRef: `${SUSDE.fileSha256}:${row.blockNumber}:${row.blockHash}`,
        valuesByChannel: { vault: row.vaultUsdeRaw, silo: row.siloUsdeRaw },
      })),
    },
    () => true,
  )
  const historyResults = Object.entries(audit.histories).map(([key, h]) =>
    summarize(key, h, analysisAtUtc),
  )
  const body = {
    schemaVersion: 1,
    label: 'retrospective_reconstructed_analysis',
    analysisAtUtc,
    scope: 'funding_only',
    holderFacts: 'holder_facts_unavailable',
    probability: null,
    calibratedProbability: false,
    acquisitionClockPolicy: 'preserved_availableAt_must_precede_analysis_not_simulated_issue',
    prospectiveForecastRecords: 'untouched',
    method:
      'strictly_earlier_native_net_rate_intervals_project_source_age_plus_selected_horizon_jointly',
    auditSource: { file: AUDIT_PATH, fileSha256: AUDIT_SHA, bodySha256: audit.sha256 },
    historyCount: historyResults.length,
    historyResults,
    exclusions: audit.exclusions,
    susdeJointSource: {
      file: SUSDE.file,
      fileSha256: SUSDE.fileSha256,
      bodySha256: SUSDE.bodySha256,
      manifestFileSha256: SUSDE_MANIFEST_SHA,
    },
    susdeJoint,
    apyJoint: {
      file: APY_FILE,
      fileSha256: APY_SHA,
      bodySha256: APY_BODY,
      acquisitionAtUtc: apy.replayed.availableAtUtc,
      status: 'censored',
      reason:
        Date.parse(apy.replayed.availableAtUtc) > Date.parse(analysisAtUtc)
          ? 'history_not_acquired_at_analysis'
          : 'insufficient_joint_train_and_holdout',
      pairedAnchors: 2,
      scope: 'joint_receipt_funding',
      probability: null,
    },
  }
  return { ...body, bodySha256: hash(JSON.stringify(body)) }
}
export function main(args = process.argv.slice(2)) {
  if (args.length !== 4 || args[0] !== '--analysis-at' || args[2] !== '--out')
    throw Error('usage: --analysis-at <UTC> --out <new-research.json>')
  if (Date.parse(args[1]) > Date.now()) throw Error('analysis_clock_in_future')
  const out = resolve(args[3])
  if (dirname(out) !== resolve(ROOT, 'data/research/venue-signals'))
    throw Error('research_output_directory_required')
  const report = buildRetrospectiveFundingReport(args[1]),
    text = JSON.stringify(report) + '\n'
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error('report_size_limit')
  writeFileSync(out, text, { flag: 'wx', mode: 0o600 })
  process.stdout.write(
    JSON.stringify({
      output: out,
      fileSha256: hash(text),
      bodySha256: report.bodySha256,
      historyCount: report.historyCount,
      scoredFolds: report.historyResults.reduce(
        (n, h) => n + h.horizons.reduce((m, x) => m + x.scoredFolds, 0),
        0,
      ),
      susdeJointStatus: report.susdeJoint.status,
      apyJointStatus: report.apyJoint.status,
    }) + '\n',
  )
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
