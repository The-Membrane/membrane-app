// Offline retrospective study. These later-acquired reads never become old issue-time knowledge.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import { replayFluidUsdtConversionHistory } from './fluid-usdt-historical-conversion-capture.mjs'
import { replayFluidFullPositionHistory } from './fluid-usdt-full-position-history-capture.mjs'

const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
const check = (ok, code) => {
  if (!ok) throw Error('fluid_holder_history_study_' + code)
}
const sha = (text) => createHash('sha256').update(text).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const HOSTS = freeze(['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'])
const BUCKETS = freeze(['10145', '10000000000'])
const MAX = (1n << 256n) - 1n
const uint = (value) =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= MAX

// These hashes are external anchors for the exact original files, not candidate self-seals.
export const FLUID_HOLDER_STUDY_INPUTS = freeze([
  {
    key: 'issue0001',
    path: 'data/research/venue-signals/carry-fluid-bridge-usdt-holder-v1/issues/00000001.json',
    bytes: 7022,
    fileSha256: 'ed9879f7bd271fac0b39fc140bf87839dc04995374ea97e034f022952fa71356',
    bodySha256: '388c7a3c3ea53d4c343249bc813ae659053f895afdf9738f3e1c29f7c002ad14',
  },
  {
    key: 'issue0002',
    path: 'data/research/venue-signals/carry-fluid-bridge-usdt-holder-v1/issues/00000002.json',
    bytes: 7083,
    fileSha256: 'e7cb0e58d3849202387856279b774e5026349e5f46f8fecbffe55bdbbeb64dbc',
    bodySha256: 'db3db5ff1af80bb1d29bb122e75dab810e134e76e07855cd31a48687c8304e16',
  },
  {
    key: 'conversion',
    path: 'data/research/venue-signals/fluid-usdt-historical-conversion-2026-10-07T14-14.json',
    bytes: 714020,
    fileSha256: '071b8036b38110ea382264e70d30d88dc242fb94e297777add40912814282b41',
    bodySha256: '6c3078bab4cffe3000dfedfb3e38f91c1cb293840cb6628a81f7689ed2fb1584',
  },
  {
    key: 'fullPosition',
    path: 'data/research/venue-signals/fluid-usdt-full-position-history-2026-10-07T19-10.json',
    bytes: 13976,
    fileSha256: '6a1526fdcb4ee3d85ccaa5a6d72e4d23ec32d5cffb73c36cec909ac35160ee52',
    bodySha256: 'f66d39903d7352e6c839efcbc8ef5ce59d0e0289a61483b3bb98fc594c4e1ecb',
  },
])

function pinnedInputs(texts) {
  check(
    texts &&
      typeof texts === 'object' &&
      !Array.isArray(texts) &&
      Object.keys(texts).length === FLUID_HOLDER_STUDY_INPUTS.length &&
      FLUID_HOLDER_STUDY_INPUTS.every((spec) => Object.hasOwn(texts, spec.key)),
    'input_keys',
  )
  return Object.fromEntries(
    FLUID_HOLDER_STUDY_INPUTS.map((spec) => {
      const text = texts[spec.key]
      check(
        typeof text === 'string' &&
          Buffer.byteLength(text) === spec.bytes &&
          sha(text) === spec.fileSha256,
        spec.key + '_file_pin',
      )
      const value = JSON.parse(text)
      const { sha256, ...body } = value
      check(
        sha256 === spec.bodySha256 && sha(JSON.stringify(body)) === spec.bodySha256,
        spec.key + '_body_pin',
      )
      return [spec.key, value]
    }),
  )
}

/** Funding eligibility only; this says nothing about withdrawal or payment delivery. */
export function classifyFluidHistoricalBucket(fullPositionEntitlementRaw, inputRaw) {
  check(
    uint(fullPositionEntitlementRaw) && uint(inputRaw) && BigInt(inputRaw) > 0n,
    'funding_units',
  )
  const entitlement = BigInt(fullPositionEntitlementRaw)
  const input = BigInt(inputRaw)
  return freeze({
    status:
      entitlement >= input ? 'full_position_covers_input' : 'full_position_does_not_cover_input',
    headroomRaw: entitlement >= input ? (entitlement - input).toString() : null,
    deficitRaw: entitlement < input ? (input - entitlement).toString() : null,
    basis: 'preview_redeem_full_position',
  })
}

const ref = (key, pointer) => ({
  path: FLUID_HOLDER_STUDY_INPUTS.find((spec) => spec.key === key).path,
  pointer,
})
const range = (values) => {
  check(values.every(uint), 'range_units')
  const sorted = values.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { minRaw: sorted[0].toString(), maxRaw: sorted.at(-1).toString() }
}

/** No network, wall-clock substitution, forecast kernel, or current-approval closure is used. */
export function replayFluidUsdtHolderHistoryStudy(texts) {
  const input = pinnedInputs(texts)
  const full = replayFluidFullPositionHistory(input.fullPosition, input.fullPosition.plan)
  const conversion = replayFluidUsdtConversionHistory(input.conversion, input.conversion.plan)
  const subject = input.fullPosition.plan.subject
  check(
    full.historicalOnly &&
      full.points.length === 2 &&
      conversion.history.points.length === 2 &&
      conversion.history.elapsedSeconds[1] === 3072 &&
      conversion.owner === subject.owner &&
      conversion.input.asset === subject.asset &&
      conversion.input.decimals === 6 &&
      conversion.input.amountRaw === BUCKETS[0] &&
      conversion.protocolInput.amountRaw === BUCKETS[1] &&
      conversion.protocolInput.holderBound === false &&
      conversion.output.decimals === 6 &&
      input.conversion.plan.fee === 100,
    'replay_identity',
  )

  const points = full.points.map((native, index) => {
    const issueKey = index === 0 ? 'issue0001' : 'issue0002'
    const issue = input[issueKey]
    const quote = conversion.history.points[index]
    const caseIndex = issue.baseline.cases.findIndex((row) => row.qRaw === BUCKETS[0])
    const measurement = issue.baseline.cases[caseIndex]?.measurement
    check(
      same(native.source, quote.source) &&
        quote.identityVerified &&
        quote.status === 'conditional_quote' &&
        quote.protocolQuote.status === 'conditional_quote' &&
        quote.missingLegs.length === 0 &&
        quote.protocolQuote.inputRaw === BUCKETS[1] &&
        native.owner === subject.owner &&
        native.asset === subject.asset &&
        native.assetDecimals === 6 &&
        native.holderSharesRaw === input.fullPosition.plan.anchors[index].originalHolderSharesRaw &&
        issue.routeKey === subject.routeKey &&
        issue.destination === subject.destination &&
        issue.holder === subject.owner &&
        issue.asset === subject.asset &&
        issue.finalAsset === conversion.output.asset &&
        issue.previousSha256 === (index === 0 ? null : input.issue0001.sha256) &&
        String(issue.baseline.blockNumber) === native.source.blockNumber &&
        issue.baseline.blockHash === native.source.blockHash &&
        new Date(issue.baseline.blockTimestamp * 1000).toISOString() === native.source.blockTime &&
        measurement?.assayOwner === subject.owner &&
        measurement.blockHash === native.source.blockHash &&
        measurement.vault.address === subject.destination &&
        measurement.vault.assetAddress === subject.asset &&
        measurement.vault.assetDecimals === 6 &&
        measurement.request.assetsRaw === BUCKETS[0] &&
        measurement.request.assetUnit === 'USDC' &&
        measurement.position.holderSharesRaw === native.holderSharesRaw &&
        measurement.simulation.status === 'success' &&
        measurement.routeLeg.usdcToUsdtConversion === 'unassessed' &&
        measurement.routeLeg.usdtReceipt === 'unassessed',
      'native_quote_source_join',
    )
    return {
      source: native.source,
      originalIssueAvailableAtUtc: issue.issuedAtUtc,
      fullPositionAvailableAtUtc: native.availableAtUtc,
      conversionAvailableAtUtc: conversion.knowledgeCutoff,
      nativePosition: {
        holderSharesRaw: native.holderSharesRaw,
        shareDecimalsFromOriginalIssue: measurement.vault.shareDecimals,
        fullPositionEntitlementRaw: native.fullPositionEntitlementRaw,
        entitlementBasis: 'preview_redeem_full_position',
        asset: native.asset,
        assetDecimals: native.assetDecimals,
        twoOriginAgreement: true,
        evidence: ref('fullPosition', '/origins/*/observations/' + index),
      },
      buckets: BUCKETS.map((inputRaw, bucketIndex) => ({
        inputRaw,
        inputAsset: native.asset,
        inputDecimals: 6,
        // Entitlement coverage is necessary eligibility; native cash and delivery need separate proof.
        fundingEligibility: classifyFluidHistoricalBucket(
          native.fullPositionEntitlementRaw,
          inputRaw,
        ),
        nativeWithdrawal: {
          status:
            bucketIndex === 0
              ? 'unqualified_historical_simulation_summary'
              : 'unassessed_exact_bucket',
          reportedSimulationStatus: bucketIndex === 0 ? measurement.simulation.status : null,
          reportedSharesBurnedRaw:
            bucketIndex === 0 ? measurement.simulation.sharesBurnedRaw : null,
          twoOriginRawAgreement: false,
          deliveredAssetsRaw: null,
          missingProof:
            bucketIndex === 0
              ? ['two_origin_raw_withdrawal_trace', 'recipient_balance_delta_or_mined_transfer']
              : ['exact_bucket_native_withdrawal_proof'],
          evidence:
            bucketIndex === 0
              ? ref(issueKey, '/baseline/cases/' + caseIndex + '/measurement')
              : null,
        },
        conversion: {
          status: 'conditional_historical_exact_size_quote',
          quotedUsdtOutRaw:
            bucketIndex === 0 ? quote.usdtQuotedRaw : quote.protocolQuote.usdtQuotedRaw,
          outputAsset: conversion.output.asset,
          outputDecimals: 6,
          pool: quote.pool,
          poolFeeUnits: 100,
          feeDenominator: 1000000,
          chargedFeeRaw: null,
          chargedFeeStatus: 'unobserved_quoter_has_no_charged_fee_field',
          twoOriginAgreement: true,
          holderFundingRequired: true,
          evidence: ref('conversion', '/traces'),
        },
        composedHolderDelivery: 'unassessed',
        finalSwapExecution: 'unassessed',
        minedUsdtPayment: 'unassessed',
        bucketDeliveryDurationSeconds: null,
      })),
    }
  })
  const elapsedSeconds =
    (Date.parse(points[1].source.blockTime) - Date.parse(points[0].source.blockTime)) / 1000
  check(
    elapsedSeconds === 3072 &&
      full.availableAtUtc === '2026-10-07T19:10:55.523Z' &&
      Date.parse(full.availableAtUtc) > Date.parse(conversion.knowledgeCutoff) &&
      points.every(
        (point) =>
          Date.parse(point.originalIssueAvailableAtUtc) < Date.parse(conversion.knowledgeCutoff),
      ),
    'separate_availability',
  )
  const body = {
    schema: 'fluid_usdt_holder_history_study_v1',
    scope: 'newly_dated_retrospective_historical_study',
    studyDateUtc: '2026-10-07',
    evidenceAvailableAtUtc: full.availableAtUtc,
    historicalOnly: true,
    originalIssuedForecast: false,
    liveHolderForecast: false,
    futureProjection: false,
    originalUsdtRequestedRaw: null,
    subject: {
      routeKey: subject.routeKey,
      destination: subject.destination,
      owner: subject.owner,
      nativeAsset: subject.asset,
      nativeAssetDecimals: 6,
      finalAsset: conversion.output.asset,
      finalAssetDecimals: 6,
    },
    inputs: FLUID_HOLDER_STUDY_INPUTS,
    approvedOriginHosts: HOSTS,
    replayedPhysicalStarts: {
      fullPosition: input.fullPosition.physicalStarts,
      conversion: input.conversion.physicalStarts,
    },
    points,
    sampledRange: {
      sourceCount: 2,
      elapsedSeconds,
      scope: 'two_historical_endpoints_no_intermediate_or_future_inference',
      fullPositionEntitlementRaw: range(
        points.map((point) => point.nativePosition.fullPositionEntitlementRaw),
      ),
      exactBuckets: BUCKETS.map((inputRaw, index) => ({
        inputRaw,
        conditionalQuotedUsdtOutRaw: range(
          points.map((point) => point.buckets[index].conversion.quotedUsdtOutRaw),
        ),
        entitlementCoversInputAtBothSources: points.every(
          (point) =>
            point.buckets[index].fundingEligibility.status === 'full_position_covers_input',
        ),
        nativeDeliveredAssetsRangeRaw: null,
        finalUsdtPaymentRangeRaw: null,
        bucketDeliveryDurationSeconds: null,
      })),
    },
    excludedCurrentConversionPoint: conversion.current !== null,
    openGapCount: 4,
    gapCountChange: 0,
    execution: 'unassessed',
    minedPayout: false,
    sourceImplementationEquivalence: false,
  }
  const result = { ...body, sha256: sha(JSON.stringify(body)) }
  check(Buffer.byteLength(JSON.stringify(result)) + 1 <= 65536, 'study_size')
  return freeze(result)
}

export function loadFluidUsdtHolderHistoryStudy({ root = process.cwd() } = {}) {
  const budget = { maxFileBytes: 750000, maxTotalBytes: 750000, totalBytes: 0 }
  const texts = Object.fromEntries(
    FLUID_HOLDER_STUDY_INPUTS.map((spec) => [
      spec.key,
      readBoundedReceiptFile(resolve(root, spec.path), budget),
    ]),
  )
  return replayFluidUsdtHolderHistoryStudy(texts)
}

// Explicit offline output only. Importing the module never reads or writes an artifact.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  check(process.argv.length === 3, 'usage_output_path_required')
  const study = loadFluidUsdtHolderHistoryStudy()
  writeFileSync(resolve(process.argv[2]), JSON.stringify(study) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(
    JSON.stringify({
      status: study.schema,
      points: study.points.length,
      buckets: study.points.reduce((count, point) => count + point.buckets.length, 0),
      sha256: study.sha256,
      bytes: Buffer.byteLength(JSON.stringify(study)) + 1,
    }),
  )
}
