/** Offline research only. Importing starts no reads, providers, jobs, app API or forecasts. */
import { createHash } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  writeFileSync,
  fsyncSync,
  statfsSync,
  lstatSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { decodeFunctionResult } from 'viem'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import * as nativeHolderModule from '../../lib/venueForecast/nativeHolderSizedHoldout.ts'
import type {
  ReceiptPaymentRow,
  ApySizedFrame,
} from '../../lib/venueForecast/nativeHolderSizedHoldout.ts'
import * as apyEvidenceModule from '../../lib/carry/apyUsdJointNativeEvidence.ts'
import * as umbrellaHistoryModule from '../../lib/carry/umbrellaGhoJointNativeHistory.ts'
import type {
  UmbrellaGhoJointNativeHistoryBinding,
  UmbrellaGhoJointNativeHistoryWire,
} from '../../lib/carry/umbrellaGhoJointNativeHistory.ts'
import type { UmbrellaFundingQuoteFrame } from '../../lib/venueForecast/nativeHolderSizedHoldout.ts'
import type {
  ApyUsdJointNativeHistoryBinding,
  ApyUsdJointNativeHistoryWire,
} from '../../lib/carry/apyUsdJointNativeEvidence.ts'
import type { Usd3JointHistoricalPoint } from '../../lib/carry/usd3JointHistoricalProcess.ts'
import type { FluidBridgeUsdcFrame } from '../../lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const NATIVE_HOLDER_PLAN_PATH =
  'data/research/venue-signals/native-holder-sized-holdout-v2.plan.json'
export const NATIVE_HOLDER_PLAN_SHA256 =
  '8ca9d4b630b79e33d361e7ebd59f85ff6ae28d998bf3b850a2d7977b121863f7'
export const NATIVE_HOLDER_V3_PLAN_PATH =
  'data/research/venue-signals/native-holder-sized-holdout-v3.plan.json'
export const NATIVE_HOLDER_V3_PLAN_SHA256 =
  '6b0c08e9a9ff059faa52db221914db8430bfc1ab2f2554ba7757fae735e3d47a'
const MB = 1024 * 1024
const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
function check(value: unknown, reason: string): asserts value {
  if (!value) throw Error('native_holder_runner_' + reason)
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
/** Installed tsx exposes local TypeScript as ESM names or a CommonJS default namespace. */
function localNativeModule<T>(
  namespace: unknown,
  specification: Readonly<Record<string, 'function' | 'record' | 'array'>>,
): T {
  check(record(namespace), 'local_module_namespace')
  const valid = (value: unknown): value is Record<string, unknown> =>
    record(value) &&
    Object.entries(specification).every(
      ([key, kind]) =>
        Object.hasOwn(value, key) &&
        (kind === 'function'
          ? typeof value[key] === 'function'
          : kind === 'array'
            ? Array.isArray(value[key])
            : record(value[key])),
    )
  const direct = valid(namespace),
    fallback = valid(namespace.default)
  check(direct || fallback, 'local_module_required_exports')
  if (direct && fallback) {
    const common = namespace.default as Record<string, unknown>
    check(
      Object.keys(specification).every((key) => namespace[key] === common[key]),
      'local_module_ambiguous_exports',
    )
  }
  return (direct ? namespace : namespace.default) as T
}
const {
  RESEARCH_ONLY,
  nativeRaw,
  researchClock,
  scoreUsd3SizedHistory,
  scoreFluidSizedHistory,
  scoreApySizedHistory,
  scoreApyReceiptPayments,
  scoreUmbrellaFundingQuoteHistory,
} = localNativeModule<typeof nativeHolderModule>(nativeHolderModule, {
  RESEARCH_ONLY: 'record',
  nativeRaw: 'function',
  researchClock: 'function',
  scoreUsd3SizedHistory: 'function',
  scoreFluidSizedHistory: 'function',
  scoreApySizedHistory: 'function',
  scoreApyReceiptPayments: 'function',
  scoreUmbrellaFundingQuoteHistory: 'function',
})
const { replayApyUsdJointNativeHistoryPoint, APY_USD_JOINT_NATIVE_ABI } = localNativeModule<
  typeof apyEvidenceModule
>(apyEvidenceModule, {
  replayApyUsdJointNativeHistoryPoint: 'function',
  APY_USD_JOINT_NATIVE_ABI: 'array',
})
const { replayUmbrellaGhoJointNativeHistoryPoint } = localNativeModule<
  typeof umbrellaHistoryModule
>(umbrellaHistoryModule, {
  replayUmbrellaGhoJointNativeHistoryPoint: 'function',
})
const identityKey = (r: Identity) => [r.routeKey, r.destination, r.asset].join('\0')
type Identity = {
  routeKey: string
  destination: string
  asset: string
  assetDecimals?: number | null
}
type Pin = { path: string; bytes: number; fileSha256: string }
type Plan = {
  schema: string
  coreRosterSha256: string
  inputs: Record<string, Pin>
  measurementSourcePins: { path: string; fileSha256: string }[]
  roster: Identity[]
  supplementalRoster: Identity[]
  paymentHorizonsDays: number[]
  umbrellaDiagnosticSpec?: {
    identity: Identity
    fullSharesRaw: string
    cooldownSharesRaw: string
    cashIndices: number[]
    horizonHours: number
    sourceAgeMs: number
  }
}
type FundingHorizon = {
  horizonHours: number
  scoredFolds: number
  censoredFolds: number
  censorReasons: Record<string, number>
  absoluteErrorSumByChannel: { cash: string }
  persistenceAbsoluteErrorSumByChannel: { cash: string }
  bandContainsActualFolds: number
}
type FundingHistory = {
  historyKey: string
  identity: Identity
  pointCount: number
  acquisitionAtUtc: string
  witness: { manifestSha256: string; lastDailyReceiptSha256: string; availableAt: string }
  horizons: FundingHorizon[]
}
type Funding = { historyResults: FundingHistory[]; analysisAtUtc: string; bodySha256: string }
type CashAudit = {
  histories: Record<
    string,
    {
      identity: Identity
      witness: FundingHistory['witness']
      points: [number, number, string, string, string][]
    }
  >
  sha256: string
}
type Coverage = {
  groups: { routeKey: string; destinations: { identity: Identity; exclusion: string | null }[] }[]
  bodySha256: string
}
type Usd3Report = {
  schema: string
  joinedPoints: { point: Usd3JointHistoricalPoint }[]
  folds: { correlatedRequestedAmountsRaw: string[] }[]
  sha256: string
}
type FluidReport = {
  schema: string
  frames: FluidBridgeUsdcFrame[]
  folds: { cases: { requestedRaw: string }[] }[]
  sha256: string
}
type ApyResponse = {
  apyUsdJointHistoricalEvidence: {
    schema: string
    points: { binding: ApyUsdJointNativeHistoryBinding; wire: ApyUsdJointNativeHistoryWire }[]
    acquiredAtUtc: string
    availableAtUtc: string
  }
}
type UmbrellaResponse = {
  umbrellaGhoJointHistoricalEvidence: {
    schema: string
    subject: {
      fullSharesRaw: string
      cooldownSharesRaw: string
      owner: null
      historicalOwnership: false
    }
    points: {
      binding: UmbrellaGhoJointNativeHistoryBinding
      wire: UmbrellaGhoJointNativeHistoryWire
    }[]
    acquiredAtUtc: string
    originalAuthority: false
    authenticated: false
    historicalOwnership: false
    executionQualified: false
    forecastIssued: false
  }
}
type UmbrellaPreparedPlan = {
  schema: string
  batchIndex: number
  fullSharesRaw: string
  cooldownSharesRaw: string
  currentSource: UmbrellaGhoJointNativeHistoryBinding['source']
  owner: null
  historicalOwnership: false
  anchors: {
    cashIndex: number
    source: UmbrellaGhoJointNativeHistoryBinding['source']
    requests: { key: string; request: { method: string; params: unknown[] } }[]
  }[]
  planSha256: string
}
type UmbrellaNativeRow = {
  physicalId: number
  host: string
  request: { jsonrpc: string; id: number; method: string; params: unknown[] }
  requestBodyBase64: string
  requestBodySha256: string
  rawBodyBase64: string
  bodySha256: string
  bodyBytes: number
  completedAtUtc: string
  startedAtUtc: string
  status: string
  accepted: boolean
  httpStatus: number
}
type UmbrellaOriginalReceipt = {
  ledger: UmbrellaNativeRow[]
  physicalStarts: number
  pendingSettlements: number
  failure: unknown
  planSha256: string
  availableAtUtc: string
  terminalCommitments: { physicalId: number; rowSha256: string }[]
  settlements: {
    schema: string
    physicalId: number
    captureAcceptance: false
    observation: UmbrellaNativeRow
    sha256: string
  }[]
}
type UmbrellaManifest = {
  schema: string
  kind: string
  sharesRaw: string
  completedAtUtc: string
  originalAuthority: false
  authenticated: false
  executionQualified: false
  historicalOwnership: false
  batches: {
    batchIndex: number
    physicalStarts: number
    availableAtUtc: string
    receipt: { fileSha256: string }
    plan: { fileSha256: string }
  }[]
  sha256: string
}
// Exact recursive key sorting used by umbrella-gho-joint-history-capture.mjs.
// Applies only to its row commitments and physical settlement body seals.
function umbrellaCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(umbrellaCanonical).join(',') + ']'
  if (value && typeof value === 'object') {
    const fields = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(fields)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + umbrellaCanonical(fields[key]))
        .join(',') +
      '}'
    )
  }
  const encoded = JSON.stringify(value)
  check(typeof encoded === 'string', 'umbrella_canonical_json_value')
  return encoded
}

/** Raw byte/row joins plus unsigned native replay. This never authenticates a historical holder. */
export function joinUmbrellaDiagnosticFrames(
  response: UmbrellaResponse,
  manifest: UmbrellaManifest,
  batches: readonly { plan: UmbrellaPreparedPlan; receipt: UmbrellaOriginalReceipt }[],
  identity: Identity,
  analysisAtUtc: string,
) {
  const analysis = researchClock(analysisAtUtc),
    h = response.umbrellaGhoJointHistoricalEvidence
  verifySeal(manifest, 'sha256')
  check(
    h?.schema === 'umbrella_gho_joint_native_history_evidence_v1' &&
      h.points.length === 8 &&
      h.subject.owner === null &&
      h.subject.historicalOwnership === false &&
      h.subject.fullSharesRaw === manifest.sharesRaw &&
      [
        h.originalAuthority,
        h.authenticated,
        h.historicalOwnership,
        h.executionQualified,
        h.forecastIssued,
      ].every((v) => v === false),
    'umbrella_evidence_subject',
  )
  check(
    manifest.schema === 'holder_native_history_originals_manifest_v1' &&
      manifest.kind === 'umbrella_gho_history' &&
      manifest.batches.length === 2 &&
      batches.length === 2 &&
      [
        manifest.originalAuthority,
        manifest.authenticated,
        manifest.executionQualified,
        manifest.historicalOwnership,
      ].every((v) => v === false) &&
      researchClock(h.acquiredAtUtc) <= researchClock(manifest.completedAtUtc) &&
      researchClock(manifest.completedAtUtc) <= analysis,
    'umbrella_manifest_clock_or_authority',
  )
  const points: UmbrellaFundingQuoteFrame[] = []
  let joinedNativeTraces = 0,
    joinedChainRows = 0
  batches.forEach(({ plan, receipt }, batchIndex) => {
    const m = manifest.batches[batchIndex]
    check(
      plan.schema === 'umbrella_gho_joint_native_history_capture_plan_v1' &&
        plan.batchIndex === batchIndex &&
        m.batchIndex === batchIndex &&
        plan.owner === null &&
        plan.historicalOwnership === false &&
        plan.fullSharesRaw === h.subject.fullSharesRaw &&
        plan.cooldownSharesRaw === h.subject.cooldownSharesRaw &&
        receipt.planSha256 === plan.planSha256 &&
        receipt.physicalStarts === 146 &&
        m.physicalStarts === 146 &&
        receipt.ledger.length === 146 &&
        receipt.pendingSettlements === 0 &&
        receipt.failure === null &&
        researchClock(receipt.availableAtUtc) <= researchClock(m.availableAtUtc) &&
        researchClock(m.availableAtUtc) <= researchClock(manifest.completedAtUtc),
      'umbrella_original_batch',
    )
    check(
      receipt.terminalCommitments.length === 146 &&
        receipt.settlements.length === 146 &&
        new Set(receipt.ledger.map((r) => r.physicalId)).size === 146 &&
        new Set(receipt.terminalCommitments.map((r) => r.physicalId)).size === 146 &&
        new Set(receipt.settlements.map((r) => r.physicalId)).size === 146,
      'umbrella_physical_duplicates',
    )
    const envelopes = new Map<number, Record<string, unknown>>()
    receipt.ledger.forEach((row) => {
      const requestBytes = Buffer.from(row.requestBodyBase64, 'base64'),
        rawBytes = Buffer.from(row.rawBodyBase64, 'base64')
      check(
        Number.isSafeInteger(row.physicalId) &&
          row.physicalId > 0 &&
          requestBytes.length <= 65536 &&
          rawBytes.length <= 65536 &&
          requestBytes.toString('base64') === row.requestBodyBase64 &&
          rawBytes.toString('base64') === row.rawBodyBase64 &&
          hash(requestBytes) === row.requestBodySha256 &&
          hash(rawBytes) === row.bodySha256 &&
          rawBytes.length === row.bodyBytes &&
          row.accepted === true &&
          row.status === 'success' &&
          row.httpStatus === 200 &&
          researchClock(row.startedAtUtc) <= researchClock(row.completedAtUtc) &&
          researchClock(row.completedAtUtc) <= researchClock(receipt.availableAtUtc),
        'umbrella_raw_native_row',
      )
      const request = JSON.parse(requestBytes.toString('utf8')),
        envelope = JSON.parse(rawBytes.toString('utf8'))
      check(
        record(request) &&
          record(envelope) &&
          JSON.stringify(request) === JSON.stringify(row.request) &&
          request.jsonrpc === '2.0' &&
          Number.isSafeInteger(request.id) &&
          envelope.jsonrpc === '2.0' &&
          envelope.id === request.id &&
          Object.hasOwn(envelope, 'result') &&
          !Object.hasOwn(envelope, 'error'),
        'umbrella_raw_native_envelope',
      )
      const terminal = receipt.terminalCommitments.find((c) => c.physicalId === row.physicalId),
        settlement = receipt.settlements.find((s) => s.physicalId === row.physicalId)
      check(
        terminal?.rowSha256 === hash(umbrellaCanonical(row)) &&
          settlement &&
          settlement.schema === 'umbrella_history_physical_settlement_v1' &&
          settlement.captureAcceptance === false &&
          JSON.stringify(settlement.observation) === JSON.stringify(row),
        'umbrella_terminal_settlement_join',
      )
      const { sha256, ...settlementBody } = settlement
      check(hash(umbrellaCanonical(settlementBody)) === sha256, 'umbrella_settlement_body_seal')
      envelopes.set(row.physicalId, envelope)
    })
    const used = new Set<number>()
    const candidates = (
      host: string,
      request: { method: string; params: unknown[] },
      completedAtUtc?: string,
    ) =>
      receipt.ledger.filter(
        (row) =>
          row.host === host &&
          row.request.method === request.method &&
          JSON.stringify(row.request.params) === JSON.stringify(request.params) &&
          (completedAtUtc === undefined || row.completedAtUtc === completedAtUtc),
      )
    const selected = h.points.slice(batchIndex * 4, batchIndex * 4 + 4)
    check(plan.anchors.length === 4, 'umbrella_plan_anchor_count')
    selected.forEach((p, i) => {
      const a = plan.anchors[i]
      check(
        p.binding.cashIndex === 112 + batchIndex * 4 + i &&
          p.binding.cashIndex === a.cashIndex &&
          JSON.stringify(p.binding.source) === JSON.stringify(a.source) &&
          JSON.stringify(p.binding.currentSource) === JSON.stringify(plan.currentSource) &&
          p.binding.fullSharesRaw === plan.fullSharesRaw &&
          p.binding.cooldownSharesRaw === plan.cooldownSharesRaw &&
          a.requests.length === 18,
        'umbrella_original_binding',
      )
      p.wire.origins.forEach((origin) => {
        const chains = candidates(origin.host, origin.chainIdTrace.request)
        check(
          chains.length === 1 &&
            envelopes.get(chains[0].physicalId)?.result === origin.chainIdTrace.result,
          'umbrella_chain_raw_join',
        )
        if (!used.has(chains[0].physicalId)) joinedChainRows++
        used.add(chains[0].physicalId)
        origin.traces.forEach((trace, j) => {
          check(
            trace.key === a.requests[j].key &&
              JSON.stringify(trace.request) === JSON.stringify(a.requests[j].request),
            'umbrella_prepared_request_join',
          )
          const rows = candidates(origin.host, trace.request, trace.completedAtUtc)
          check(
            rows.length === 1 && !used.has(rows[0].physicalId),
            'umbrella_unique_trace_raw_join',
          )
          const result = envelopes.get(rows[0].physicalId)!.result
          const projected =
            trace.key === 'headerBefore' || trace.key === 'headerAfter'
              ? record(result)
                ? { number: result.number, hash: result.hash, timestamp: result.timestamp }
                : null
              : result
          check(
            JSON.stringify(projected) === JSON.stringify(trace.result),
            'umbrella_native_result_agreement',
          )
          used.add(rows[0].physicalId)
          joinedNativeTraces++
        })
      })
      const replay = replayUmbrellaGhoJointNativeHistoryPoint(p.wire, p.binding)
      check(replay, 'umbrella_native_replay')
      points.push({ ...replay, asset: identity.asset, assetDecimals: 18, shareDecimals: 18 })
    })
    check(used.size === 146, 'umbrella_complete_physical_join')
  })
  check(
    joinedNativeTraces === 288 &&
      joinedChainRows === 4 &&
      Math.max(...points.map((p) => researchClock(p.acquiredAtUtc))) ===
        researchClock(h.acquiredAtUtc),
    'umbrella_native_join_counts',
  )
  return {
    points,
    provenance: {
      joinedNativeTraces,
      joinedChainRows,
      physicalRows: 292,
      actualAcquiredAtUtc: h.acquiredAtUtc,
      actualRetainedAtUtc: manifest.completedAtUtc,
      historicalOwnership: false,
      originalAcquisitionAuthority: false,
      nativeGetterTargetsAreMinedDelivery: false,
    },
  }
}

type Escrow = {
  payoutsSha256: string
  proofs: {
    tokenId: string
    holder: string
    issuedAt: number
    claimableAt: number
    grossWithdrawRaw: string
    vaultFeeRaw: string
    receiptEscrowRaw: string
  }[]
  sha256: string
}
type Payouts = {
  openIds: string[]
  proofs: {
    tokenId: string
    holder: string
    request: { timestamp: number; requestedAssetRaw: string }
    payout: { timestamp: number; paidAssetRaw: string }
  }[]
  sha256: string
}
const reports = new WeakSet<object>()
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
export function authenticateNativeHolderPlan(text: string, version: 2 | 3 = 2): Plan {
  check(
    Buffer.byteLength(text) <= MB &&
      hash(text) === (version === 3 ? NATIVE_HOLDER_V3_PLAN_SHA256 : NATIVE_HOLDER_PLAN_SHA256),
    'immutable_plan_pin',
  )
  const p: Plan = JSON.parse(text)
  check(
    p.schema ===
      (version === 3
        ? 'native_holder_sized_holdout_v3_plan'
        : 'native_holder_sized_holdout_v2_plan') &&
      p.coreRosterSha256 === '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
    'plan_scope',
  )
  check(
    p.roster.length === 67 &&
      new Set(p.roster.map(identityKey)).size === 67 &&
      new Set(p.roster.map((r) => r.routeKey)).size === 25,
    'roster',
  )
  check(
    p.supplementalRoster.length === 1 &&
      !p.roster.some((r) => identityKey(r) === identityKey(p.supplementalRoster[0])),
    'supplemental_roster',
  )
  return p
}
function safeInputPath(path: string) {
  check(
    typeof path === 'string' &&
      path.length <= 512 &&
      !path.includes('..') &&
      !path.includes('://') &&
      !path.startsWith('/') &&
      !path.includes('\\'),
    'input_path',
  )
  const full = resolve(ROOT, path)
  check(full.startsWith(ROOT + '/'), 'input_root')
  return full
}
function verifySeal(value: unknown, key: 'sha256' | 'bodySha256') {
  check(record(value) && typeof value[key] === 'string', 'body_seal_shape')
  const { [key]: pin, ...body } = value
  check(hash(JSON.stringify(body)) === pin, 'body_seal')
}
function readPinned<T>(
  pin: Pin,
  budget: { maxFileBytes: number; maxTotalBytes: number; totalBytes: number },
): T {
  check(
    Number.isSafeInteger(pin.bytes) &&
      pin.bytes > 0 &&
      pin.bytes <= 8 * MB &&
      /^[a-f0-9]{64}$/.test(pin.fileSha256),
    'input_pin',
  )
  const text = readBoundedReceiptFile(safeInputPath(pin.path), budget)
  check(Buffer.byteLength(text) === pin.bytes && hash(text) === pin.fileSha256, 'input_bytes_pin')
  return JSON.parse(text) as T
}
export function joinApyPaymentRows(escrow: Escrow, payouts: Payouts): ReceiptPaymentRow[] {
  check(
    escrow.payoutsSha256 === payouts.sha256 &&
      escrow.proofs.length === 96 &&
      payouts.proofs.length === 89 &&
      payouts.openIds.length === 7,
    'payment_sources',
  )
  const byId = new Map(payouts.proofs.map((p) => [p.tokenId, p])),
    open = new Set(payouts.openIds)
  check(
    byId.size === payouts.proofs.length &&
      open.size === payouts.openIds.length &&
      new Set(escrow.proofs.map((p) => p.tokenId)).size === 96,
    'payment_duplicates',
  )
  const rows = escrow.proofs.map((r) => {
    const p = byId.get(r.tokenId)
    check((p !== undefined) !== open.has(r.tokenId), 'payment_partition')
    check(
      nativeRaw(r.grossWithdrawRaw) - nativeRaw(r.vaultFeeRaw) === nativeRaw(r.receiptEscrowRaw),
      'payment_vault_fee',
    )
    if (p)
      check(
        p.holder.toLowerCase() === r.holder.toLowerCase() &&
          p.request.timestamp === r.issuedAt &&
          p.request.requestedAssetRaw === r.grossWithdrawRaw,
        'payment_receipt_owner_join',
      )
    return {
      tokenId: r.tokenId,
      holder: r.holder.toLowerCase(),
      issuedAt: r.issuedAt,
      claimableAt: r.claimableAt,
      escrowRaw: r.receiptEscrowRaw,
      paidAt: p?.payout.timestamp ?? null,
      paidRaw: p?.payout.paidAssetRaw ?? null,
      payoutHolder: p?.holder.toLowerCase() ?? null,
    }
  })
  check(rows.filter((r) => r.paidAt !== null).length === 89, 'payment_complete_partition')
  return rows
}
function historyPause(wire: ApyUsdJointNativeHistoryWire, key: 'vault_paused' | 'receipt_paused') {
  const row = wire.origins[0].traces.find((t) => t.key === key)
  check(
    row && !row.error && typeof row.result === 'string' && /^0x[0-9a-f]*$/.test(row.result),
    'native_pause_trace',
  )
  const decoded = decodeFunctionResult({
    abi: APY_USD_JOINT_NATIVE_ABI,
    functionName: 'paused',
    data: row.result as `0x${string}`,
  })
  check(typeof decoded === 'boolean', 'native_pause_decode')
  return decoded
}
/** Fixed source pins authenticate local bytes for this study, never private/native execution authority. */
export function buildNativeHolderSizedHoldout(
  analysisAtUtc: string,
  planPath = resolve(ROOT, NATIVE_HOLDER_PLAN_PATH),
) {
  const analysis = researchClock(analysisAtUtc)
  check(analysis <= Date.now(), 'analysis_in_future')
  const version: 2 | 3 = resolve(planPath) === resolve(ROOT, NATIVE_HOLDER_V3_PLAN_PATH) ? 3 : 2
  check(
    resolve(planPath) ===
      resolve(ROOT, version === 3 ? NATIVE_HOLDER_V3_PLAN_PATH : NATIVE_HOLDER_PLAN_PATH),
    'plan_path',
  )
  const budget = { maxFileBytes: MB, maxTotalBytes: 32 * MB, totalBytes: 0 },
    plan = authenticateNativeHolderPlan(readBoundedReceiptFile(planPath, budget), version)
  for (const pin of plan.measurementSourcePins) {
    const text = readBoundedReceiptFile(safeInputPath(pin.path), budget)
    check(hash(text) === pin.fileSha256, 'measurement_source_changed')
  }
  const implementationPaths = [
    'lib/venueForecast/nativeHolderSizedHoldout.ts',
    'scripts/research/native-holder-sized-holdout.mts',
    'scripts/lib/boundedLocalReceiptFile.mjs',
  ]
  const studyImplementationSourcePins = implementationPaths.map((path) => {
    const text = readBoundedReceiptFile(safeInputPath(path), budget)
    return { path, bytes: Buffer.byteLength(text), fileSha256: hash(text) }
  })
  const loaderPath = 'node_modules/tsx/dist/loader.mjs',
    loaderAbsolute = safeInputPath(loaderPath),
    explicitTsxLoaderObserved = process.execArgv.some(
      (arg, n) =>
        (arg === '--import' && process.execArgv[n + 1] === loaderAbsolute) ||
        arg === '--import=' + loaderAbsolute,
    )
  const loaderText = explicitTsxLoaderObserved
    ? readBoundedReceiptFile(loaderAbsolute, budget)
    : null
  const runtimeProvenance = {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    explicitTsxLoaderObserved,
    installedLoaderFilePin:
      loaderText === null
        ? null
        : { path: loaderPath, bytes: Buffer.byteLength(loaderText), fileSha256: hash(loaderText) },
    localTypeScriptExportResolution: 'checked_ESM_namespace_or_CJS_default',
    sourceBytesAreLoadedCompiledModuleProof: false,
    originalIssueReproducibilityAuthority: false,
  }
  budget.maxFileBytes = 8 * MB
  const coverage = readPinned<Coverage>(plan.inputs.coverage, budget),
    audit = readPinned<CashAudit>(plan.inputs.cashAudit, budget),
    cashPins = readPinned<Record<string, unknown>>(plan.inputs.cashPins, budget),
    funding = readPinned<Funding>(plan.inputs.funding, budget),
    usd3 = readPinned<Usd3Report>(plan.inputs.usd3, budget),
    fluid = readPinned<FluidReport>(plan.inputs.fluid, budget),
    apy = readPinned<ApyResponse>(plan.inputs.apy, budget),
    index = readPinned<{ copies: { file: string; fileSha256: string }[] }>(
      plan.inputs.apyArchiveIndex,
      budget,
    ),
    escrow = readPinned<Escrow>(plan.inputs.apyEscrow, budget),
    payouts = readPinned<Payouts>(plan.inputs.apyPayouts, budget)
  for (const value of [audit, cashPins, usd3, fluid, escrow, payouts]) verifySeal(value, 'sha256')
  for (const value of [coverage, funding]) verifySeal(value, 'bodySha256')
  check(researchClock(funding.analysisAtUtc) <= analysis, 'funding_analysis_clock')
  const originalRoster = coverage.groups.flatMap((g) => g.destinations.map((d) => d.identity))
  check(
    originalRoster.length === 67 &&
      originalRoster.every((r, n) => identityKey(r) === identityKey(plan.roster[n])),
    'exact_roster_mapping',
  )
  check(
    index.copies.filter(
      (p) =>
        p.file === 'capture/actual-response-parsed.json' &&
        p.fileSha256 === plan.inputs.apy.fileSha256,
    ).length === 1,
    'APY_archive_reference',
  )
  check(
    usd3.schema === 'usd3_historical_holder_backtest_v1' &&
      usd3.joinedPoints.length === 8 &&
      usd3.folds.length === 5,
    'USD3_saved_frames',
  )
  check(
    fluid.schema === 'fluid_bridge_usdc_historical_hypothetical_same_S_backtest_v1' &&
      fluid.frames.length === 10 &&
      fluid.folds.length === 7,
    'Fluid_saved_frames',
  )
  const h = apy.apyUsdJointHistoricalEvidence
  check(
    h.schema === 'apyusd_joint_native_history_evidence_v1' && h.points.length === 8,
    'APY_native_frames',
  )
  check(
    researchClock(h.acquiredAtUtc) <= researchClock(h.availableAtUtc) &&
      researchClock(h.availableAtUtc) <= analysis,
    'APY_retention_clock',
  )
  const apyPoints: ApySizedFrame[] = h.points.map((p) => ({
    ...replayApyUsdJointNativeHistoryPoint(p.wire, p.binding),
    vaultPaused: historyPause(p.wire, 'vault_paused'),
    receiptPaused: historyPause(p.wire, 'receipt_paused'),
  }))
  check(
    Math.max(...apyPoints.map((p) => researchClock(p.acquiredAtUtc))) ===
      researchClock(h.acquiredAtUtc),
    'APY_acquisition_max',
  )
  const USD = 'USDC → USD3 [USDC]',
    FLUID = 'USDC → FluidBridgeAggregatorProxy [USDC]',
    APY = 'apxUSD → ApyUSD [apxUSD]'
  const studies = [
    {
      routeKey: USD,
      destination: '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
      asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      scope: 'same_S_native_reference_withdrawal_quote',
      input: plan.inputs.usd3,
      folds: scoreUsd3SizedHistory(
        usd3.joinedPoints.map((p) => p.point),
        analysisAtUtc,
        usd3.folds.map((f) => f.correlatedRequestedAmountsRaw),
      ),
    },
    {
      routeKey: FLUID,
      destination: '0x273da948aca9261043fbdb2a857bc255ecc29012',
      asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      scope: 'same_S_native_USDC_bridge_prongs_after_fee',
      input: plan.inputs.fluid,
      folds: scoreFluidSizedHistory(
        fluid.frames,
        analysisAtUtc,
        fluid.folds.map((f) => f.cases.map((c) => c.requestedRaw)),
      ),
    },
    {
      routeKey: APY,
      destination: '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a',
      asset: '0x98a878b1cd98131b271883b390f68d2c90674665',
      scope: 'same_S_native_escrow_quote_funding_upper_bound_without_native_initiation_call',
      input: plan.inputs.apy,
      folds: scoreApySizedHistory(apyPoints, analysisAtUtc),
    },
  ]
  const fundingQuoteDiagnostics =
    version === 3
      ? (() => {
          const spec = plan.umbrellaDiagnosticSpec
          check(
            spec &&
              spec.fullSharesRaw === '72016496913002872528' &&
              spec.cooldownSharesRaw === '72016496913002872528' &&
              JSON.stringify(spec.cashIndices) ===
                JSON.stringify([112, 113, 114, 115, 116, 117, 118, 119]) &&
              spec.sourceAgeMs === 0 &&
              spec.horizonHours === 24,
            'umbrella_diagnostic_spec',
          )
          const response = readPinned<UmbrellaResponse>(plan.inputs.umbrella, budget),
            manifest = readPinned<UmbrellaManifest>(plan.inputs.umbrellaManifest, budget),
            batches = [0, 1].map((n) => ({
              plan: readPinned<UmbrellaPreparedPlan>(plan.inputs['umbrellaPlan' + n], budget),
              receipt: readPinned<UmbrellaOriginalReceipt>(
                plan.inputs['umbrellaReceipt' + n],
                budget,
              ),
            }))
          manifest.batches.forEach((m, n) =>
            check(
              m.plan.fileSha256 === plan.inputs['umbrellaPlan' + n].fileSha256 &&
                m.receipt.fileSha256 === plan.inputs['umbrellaReceipt' + n].fileSha256,
              'umbrella_manifest_input_pins',
            ),
          )
          const joined = joinUmbrellaDiagnosticFrames(
            response,
            manifest,
            batches,
            spec.identity,
            analysisAtUtc,
          )
          check(
            joined.points.every(
              (p) =>
                p.sharesRaw === spec.fullSharesRaw &&
                p.cooldownCoveredSharesRaw === spec.cooldownSharesRaw,
            ),
            'umbrella_canonical_S_CS',
          )
          return [
            {
              ...spec.identity,
              studyKind: 'native_funding_quote_diagnostic_not_holder_sized_exit_study' as const,
              scope:
                'same_S_CS_native_GHO_quote_cash_upper_bound_with_unknown_holder_eligibility' as const,
              input: plan.inputs.umbrella,
              provenance: joined.provenance,
              actualHolderEligibility: null,
              actualHolderExitAbilityRaw: null,
              holderAmountErrorDenominator: 0,
              folds: scoreUmbrellaFundingQuoteHistory(joined.points, analysisAtUtc),
            },
          ]
        })()
      : []
  const fundingByKey = new Map(funding.historyResults.map((h) => [identityKey(h.identity), h]))
  check(
    fundingByKey.size === 64 && Object.keys(audit.histories).length === 64,
    'cash_history_counts',
  )
  const exclusions = new Map(
    coverage.groups
      .flatMap((g) => g.destinations)
      .filter((d) => d.exclusion)
      .map((d) => [identityKey(d.identity), d.exclusion]),
  )
  const row = (identity: Identity) => {
    const key = identityKey(identity),
      f = fundingByKey.get(key),
      cash = audit.histories[key],
      study = studies.find((s) => identityKey(s) === key),
      diagnostic = fundingQuoteDiagnostics.find((s) => identityKey(s) === key)
    if (f) {
      check(
        cash &&
          f.historyKey === key &&
          JSON.stringify(f.identity) === JSON.stringify(cash.identity) &&
          JSON.stringify(f.witness) === JSON.stringify(cash.witness),
        'cash_identity_pin',
      )
      check(
        f.acquisitionAtUtc === cash.witness.availableAt &&
          researchClock(f.acquisitionAtUtc) <= analysis &&
          f.pointCount === cash.points.length,
        'cash_clock_or_count',
      )
      check(identity.assetDecimals === f.identity.assetDecimals, 'cash_unit')
    } else check(exclusions.has(key), 'cash_exclusion')
    return {
      identity,
      nativeSizedStudy: study ?? null,
      nativeFundingQuoteDiagnostic: diagnostic ?? null,
      fundingDiagnostic: f
        ? {
            scope: 'native_cash_only_not_holder_target',
            actualAcquisitionAtUtc: f.acquisitionAtUtc,
            sourceWindow: { first: cash.points[0][3], last: cash.points.at(-1)![3] },
            pointCount: f.pointCount,
            horizons: f.horizons.map((h) => ({
              horizonHours: h.horizonHours,
              scoredFolds: h.scoredFolds,
              censoredFolds: h.censoredFolds,
              censorReasons: h.censorReasons,
              absoluteErrorRaw: h.absoluteErrorSumByChannel.cash,
              persistenceAbsoluteErrorRaw: h.persistenceAbsoluteErrorSumByChannel.cash,
              empiricalBandHits: h.bandContainsActualFolds,
              errorsArePerThisNativeAsset: true,
              holderQ: false,
            })),
            MRaw: null,
          }
        : null,
      finalOriginalAssetCashExclusion: exclusions.get(key) ?? null,
      notProvidedToThisStudy: study
        ? [
            'native_execution_at_historical_hypothetical_S',
            'future_mined_payment_for_hypothetical_position',
          ]
        : diagnostic
          ? [
              'historical_owner_balance_at_fixed_S_CS',
              'historical_staker_cooldown_snapshot_and_maxRedeem',
              'future_mined_holder_delivery',
            ]
          : [
              'fixed_S_native_entitlement_frames',
              'native_exit_policy_and_capacity_frames',
              'matching_fixed_Q_future_native_exit_targets',
            ],
      retainedNativeEpisodesElsewhere:
        'not_selected_by_this_immutable_plan_no_claim_that_they_do_not_exist',
      calibratedProbability: false,
      holderExecutableExit: false,
      historicalOwnership: false,
      MRaw: null,
    }
  }
  const core = plan.roster.map(row),
    supplemental = plan.supplementalRoster.map(row),
    receiptPayments = scoreApyReceiptPayments(
      joinApyPaymentRows(escrow, payouts),
      plan.paymentHorizonsDays,
    )
  check(
    receiptPayments.trainingVisiblePayments === 3 &&
      receiptPayments.trainRequests === 48 &&
      receiptPayments.holdoutRequests === 48,
    'APY_split_actual_counts',
  )
  const body = {
    schema: version === 3 ? 'native_holder_sized_holdout_v3' : 'native_holder_sized_holdout_v2',
    ...RESEARCH_ONLY,
    analysisAtUtc,
    scope: 'retrospective_causal_source_frame_reconstruction_separate_from_live_issued_forecasts',
    inputPlan: {
      path: version === 3 ? NATIVE_HOLDER_V3_PLAN_PATH : NATIVE_HOLDER_PLAN_PATH,
      fileSha256: version === 3 ? NATIVE_HOLDER_V3_PLAN_SHA256 : NATIVE_HOLDER_PLAN_SHA256,
    },
    inputs: plan.inputs,
    measurementSourcePins: plan.measurementSourcePins,
    studyImplementationSourcePins,
    implementationSourceObservation:
      'local file bytes at analysis, not proof of loaded compiled modules or original private issuance',
    runtimeProvenance,
    nativeConstraintCoverage: studies.map((study) => {
      const bindings = study.folds.flatMap((fold) =>
        'nativeProngBindings' in fold ? [fold.nativeProngBindings] : [],
      )
      return {
        routeKey: study.routeKey,
        foldsWithNativeProngValues: bindings.length,
        baselineQuoteEntitlementBoundFolds: bindings.filter(
          (b) => b.baseline.quoteEntitlementBinding,
        ).length,
        outcomeQuoteEntitlementBoundFolds: bindings.filter(
          (b) => b.outcome?.quoteEntitlementBinding,
        ).length,
        baselineNativeFundingBoundFolds: bindings.filter((b) => b.baseline.nativeFundingBinding)
          .length,
        outcomeNativeFundingBoundFolds: bindings.filter((b) => b.outcome?.nativeFundingBinding)
          .length,
        countsReuseNativeEndpointsAcrossFolds: true,
        independentNativeEndpointCount: null,
        observedQuoteBoundCasesProveCashSensitivity: false,
      }
    }),
    counts: {
      coreGroups: 25,
      coreDestinations: 67,
      supplementalGroups: 1,
      supplementalDestinations: 1,
      coreCashDiagnosticGroups: new Set(
        core.filter((r) => r.fundingDiagnostic).map((r) => r.identity.routeKey),
      ).size,
      coreCashDiagnosticDestinations: core.filter((r) => r.fundingDiagnostic).length,
      nativeSizedStudyGroups: studies.length,
      nativeSizedStudyDestinations: studies.length,
      chronologicalSizedFolds: studies.reduce((s, g) => s + g.folds.length, 0),
      completeAmountComparisons: studies.reduce(
        (s, g) => s + g.folds.reduce((a, f) => a + f.amountErrorDenominator, 0),
        0,
      ),
      correlatedQCases: studies.reduce(
        (s, g) => s + g.folds.reduce((a, f) => a + f.QCases.length, 0),
        0,
      ),
      nativeFundingQuoteDiagnosticGroups: fundingQuoteDiagnostics.length,
      nativeFundingQuoteDiagnosticDestinations: fundingQuoteDiagnostics.length,
      diagnosticChronologicalFolds: fundingQuoteDiagnostics.reduce((s, g) => s + g.folds.length, 0),
      diagnosticCorrelatedDonorEdgeAttempts: fundingQuoteDiagnostics.reduce(
        (s, g) => s + g.folds.reduce((a, f) => a + f.attemptedScenarios, 0),
        0,
      ),
      diagnosticUpperBoundAmountComparisons: fundingQuoteDiagnostics.reduce(
        (s, g) => s + g.folds.reduce((a, f) => a + f.upperBoundAmountErrorDenominator, 0),
        0,
      ),
      diagnosticFundingAmountComparisons: fundingQuoteDiagnostics.reduce(
        (s, g) =>
          s + g.folds.reduce((a, f) => a + f.nativeGhoCashDiagnostic.amountErrorDenominator, 0),
        0,
      ),
      diagnosticCorrelatedQCases: fundingQuoteDiagnostics.reduce(
        (s, g) => s + g.folds.reduce((a, f) => a + f.QCases.length, 0),
        0,
      ),
      diagnosticHolderAbilityComparisons: 0,
      independentSampleCount: null,
      nativeAcquisitionsThisRun: 0,
    },
    core,
    supplemental,
    receiptPayments,
    nativeFundingQuoteDiagnostics: fundingQuoteDiagnostics,
    methodology: {
      NETAppliedOnce: true,
      QSubtractedOnce: true,
      nativeErrorsPooledAcrossAssets: false,
      sameEngineMeasurements:
        'unchanged USD3 and Fluid joint engines; exact APY integer quote fee and asset withdrawal cash budget',
      originalAcquisitionAndRetentionClocksPreserved: true,
      sourceAge:
        'declared hypothetical zero-lag source-time benchmark, not an observed finalized issue; exact native endpoints only',
      historicallyFinalizedIssueAvailabilityEstablished: false,
      nearestDayOrInterpolatedLabels: false,
      endpointLossRecoveryOnly: true,
      continuousAvailabilityKnown: false,
      overlappingFolds: true,
      reusedDonors: true,
      oldNFT881UsedAsHistoricalOwnership: false,
      APYPartialInitiationQuoteIsExecution: false,
      rawCashThresholdsAreHolderExits: false,
      umbrellaHistoricalHolderEligibilityKnown: false,
      umbrellaCurrentHolderWindowTransplanted: false,
      umbrellaDiagnosticUpperBoundIsHolderAbility: false,
      umbrellaMaxSlashableAppliedAsFeeReserveOrLoss: false,
      receiptPaymentsAndNativeGetterTargetsAreSeparate: true,
    },
  }
  check(
    body.counts.coreCashDiagnosticGroups === 21 &&
      body.counts.coreCashDiagnosticDestinations === 63,
    'all_roster_cash_counts',
  )
  const report = freeze({ ...body, bodySha256: hash(JSON.stringify(body)) })
  reports.add(report)
  return report
}
export function writeNativeHolderSizedHoldout(
  path: string,
  report: ReturnType<typeof buildNativeHolderSizedHoldout>,
) {
  check(reports.has(report), 'original_built_report')
  verifySeal(report, 'bodySha256')
  const text = JSON.stringify(report) + '\n',
    bytes = Buffer.byteLength(text),
    full = resolve(path),
    dir = dirname(full)
  check(bytes <= 2 * MB && !/https?:\/\//i.test(text), 'report_size_or_URL')
  check(
    dir === resolve(ROOT, 'data/research/venue-signals') &&
      full.endsWith('.json') &&
      full !== resolve(ROOT, NATIVE_HOLDER_PLAN_PATH) &&
      full !== resolve(ROOT, NATIVE_HOLDER_V3_PLAN_PATH),
    'output_directory',
  )
  const ds = lstatSync(dir)
  check(ds.isDirectory() && !ds.isSymbolicLink(), 'output_directory_identity')
  const disk = statfsSync(dir, { bigint: true })
  check(disk.bavail * disk.bsize >= 256n * 1024n * 1024n + BigInt(bytes), 'write_reserve')
  const fd = openSync(
    full,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const st = fstatSync(fd)
    check(st.isFile() && st.nlink === 1 && (st.mode & 0o777) === 0o600, 'output_private_regular')
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const dfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(dfd)
  } finally {
    closeSync(dfd)
  }
  return {
    path: full,
    bytes,
    fileSha256: hash(text),
    bodySha256: report.bodySha256,
    counts: report.counts,
  }
}
export function main(args = process.argv.slice(2)) {
  check(args.length === 4 && args[0] === '--plan' && args[2] === '--out', 'usage_plan_out')
  const disk = statfsSync(ROOT, { bigint: true })
  check(disk.bavail * disk.bsize >= 288n * 1024n * 1024n, 'prejob_reserve')
  return writeNativeHolderSizedHoldout(
    args[3],
    buildNativeHolderSizedHoldout(new Date().toISOString(), resolve(args[1])),
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(main()) + '\n')
  } catch (error) {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n')
    process.exitCode = 1
  }
}
