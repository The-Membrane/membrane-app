/**
 * Offline extraction from ONE parent-accepted replay archive. No network, native
 * reinspection, approval brands, background work or output writes occur here.
 * The fixed manifest commits the exact copied inputs; it is preservation evidence,
 * not an independent grant of native authority. Original native replay remains the
 * separately retained parent's evidence, including the five superseded partials.
 */
import { createHash } from 'node:crypto'
import { constants, fstatSync, lstatSync, openSync, closeSync, readFileSync, readdirSync, type BigIntStats } from 'node:fs'
import {
  MORPHO_V2_IDLE_COMPACT120_MAX_BYTES, MORPHO_V2_IDLE_COMPACT120_SCHEMA,
  type MorphoV2IdleCompact120Panel, type MorphoV2IdleCompactEndpointTuple,
  type MorphoV2IdleCompactCohortTuple, type MorphoV2IdleCompactPairTuple,
  type MorphoV2IdleCompactRegime, type MorphoV2IdleCompactScore,
} from '@/lib/carry/morphoV2IdleCompact120Panel'

export const MORPHO_V2_IDLE_COMPACT120_SOURCE =
  '/Users/EBmic/membrane-app/data/research/venue-signals/morpho-v2-idle-header-replaced60-parent-backtest-2026-10-10-60391e52-2a76-4aae-b234-9cbaaf62cd77'
export const MORPHO_V2_IDLE_COMPACT120_MANIFEST_SHA256 = '519b89e907ea5b33ca9d0d057c842e0d20908aae73321775afd3334383659e2d'
export type MorphoV2IdleCompact120SourceCopies = Readonly<{
  manifestBytes: Uint8Array; copies: ReadonlyMap<string, Uint8Array>
}>
const MAX_SOURCE = 8 * 1024 * 1024
const UINT256 = (1n << 256n) - 1n
const S = '352805058661206444'
const OWNER = '0xf181e2cc93a47cb4903ac71c23ecb873726dc668'
const VAULT = '0xb576765fb15505433af24fee2c0325895c559fb2'
const ASSET = '0x6c3ea9036406852006290770bedfcaba0e23a0e8'
const ZERO = '0x0000000000000000000000000000000000000000'
const OLD_ADAPTER = '0x80126555b170957dfed67a3bfbb7893e20fe4fc0'
const VCODE = '0xd40a644ba3984c98bcffa15709271ecedf2ff7632d763fad84d7f924bd4f6acd'
const ACODE = '0xbc22d0b1173d9ff26383e64a50a807afa931a2809a7b6bae3b051723a1a9ebe1'
const OCODE = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
const REPLACED = [10, 15, 24, 33, 34]
type Json = Record<string, any>
function need(condition: unknown): asserts condition {
  if (!condition) throw new Error('morpho_v2_idle_compact120_source_mismatch')
}
function hash(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex') }
function digest(value: unknown): string { need(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); return value }
function raw(value: unknown): string {
  need(typeof value === 'string' && value.length > 0 && value.length <= 78 && !/[^0-9]/.test(value)
    && (value.length === 1 || value[0] !== '0') && BigInt(value) <= UINT256)
  return value
}
function time(value: unknown): string {
  need(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  return value
}
function basename(value: unknown): string {
  need(typeof value === 'string')
  const relative = value.replace(/^\/Users\/EBmic\/membrane-app\//, '')
  need(/^data\/research\/venue-signals\/[A-Za-z0-9_.-]+$/.test(relative))
  return relative.split('/').pop()!
}
function parse(bytes: Uint8Array): Json { return JSON.parse(Buffer.from(bytes).toString('utf8')) }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function manifest(bytes: Uint8Array): Json {
  need(bytes.byteLength === 81085 && hash(bytes) === MORPHO_V2_IDLE_COMPACT120_MANIFEST_SHA256)
  const m = parse(bytes)
  need(m.schema === 'morpho_v2_idle_header_replaced60_parent_retention_v1' && m.entries.length === 96
    && m.copiedLeaves === 96 && m.copiedBytes + bytes.byteLength === 4265270)
  need(new Set(m.entries.map((x: Json) => x.copyName)).size === 96)
  return m
}

/** Fixed-path offline reader. Reads only the closed 97-leaf, 4.27 MB accepted archive. */
export function loadMorphoV2IdleCompact120SourceCopies(): MorphoV2IdleCompact120SourceCopies {
  const state = (s: BigIntStats) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink].join(':')
  const dir = lstatSync(MORPHO_V2_IDLE_COMPACT120_SOURCE, { bigint: true })
  need(dir.isDirectory() && (dir.mode & 0o777n) === 0o700n)
  function read(name: string): Uint8Array {
    need(/^[A-Za-z0-9_.-]{1,140}$/.test(name))
    const path = `${MORPHO_V2_IDLE_COMPACT120_SOURCE}/${name}`
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const a = fstatSync(fd, { bigint: true })
      need(a.isFile() && a.nlink === 1n && (a.mode & 0o777n) === 0o600n && a.size <= BigInt(MAX_SOURCE))
      const data = readFileSync(fd)
      need(state(a) === state(fstatSync(fd, { bigint: true })) && state(a) === state(lstatSync(path, { bigint: true })))
      return data
    } finally { closeSync(fd) }
  }
  const manifestBytes = read('manifest.json'), m = manifest(manifestBytes)
  const names = ['manifest.json', ...m.entries.map((x: Json) => x.copyName)].sort()
  need(JSON.stringify(readdirSync(MORPHO_V2_IDLE_COMPACT120_SOURCE).sort()) === JSON.stringify(names))
  const copies = new Map<string, Uint8Array>()
  for (const entry of m.entries) copies.set(entry.copyName, read(entry.copyName))
  need(state(dir) === state(lstatSync(MORPHO_V2_IDLE_COMPACT120_SOURCE, { bigint: true })))
  need(JSON.stringify(readdirSync(MORPHO_V2_IDLE_COMPACT120_SOURCE).sort()) === JSON.stringify(names))
  return { manifestBytes, copies }
}

/** Returns canonical compact bytes only when every fixed copied input matches its pin. */
export function buildMorphoV2IdleCompact120Panel(source: MorphoV2IdleCompact120SourceCopies) {
  try {
    need(source && source.manifestBytes instanceof Uint8Array && source.copies instanceof Map)
    const m = manifest(source.manifestBytes), pins = new Map<string, Json>()
    need(source.copies.size === 96)
    let bytes = source.manifestBytes.byteLength
    for (const entry of m.entries) {
      need(/^[A-Za-z0-9_.-]{1,140}$/.test(entry.copyName))
      const copy = source.copies.get(entry.copyName)
      need(copy instanceof Uint8Array && copy.byteLength === entry.bytes && hash(copy) === entry.sha256)
      bytes += copy.byteLength; pins.set(entry.copyName, entry)
    }
    need(bytes === 4265270 && bytes <= MAX_SOURCE)
    const get = (name: string) => { const b = source.copies.get(name); need(b); return parse(b) }
    const fileHash = (name: string) => digest(pins.get(name)?.sha256)
    const score = get('result__backtest-header-replaced60.json'), replay = get('result__header-replay.json')
    const proof = get('root-score-proof.json')
    need(proof.exitCode === 0 && proof.pinDrift.length === 0 && proof.result.outputDirectory === '/private/tmp/morpho-v2-idle-actual60-header-result-c96868b0-44c7-4f76-ab4f-99be74022b02')
    need(proof.result.terminalFileSha256 === fileHash('result__terminal.json') && proof.result.fetchTrapCalls === 0)
    need(score.identity.profileId === 'morpho_v2_pyusd_b576_observed_idle_history' && score.identity.routeKey === 'PYUSD → VaultV2 [PYUSD]'
      && score.identity.destination === VAULT && score.identity.asset === ASSET && score.identity.assetDecimals === 6 && score.identity.shareDecimals === 18)
    need(score.policy.sharesRaw === S && score.policy.requestedRaw === '500000' && score.policy.horizonMs === 86400000 && score.policy.competingMRaw === null)
    need(score.endpoints.length === 120 && score.pairs.length === 60 && score.plannedEndpoints === 120
      && score.measuredEndpoints === 108 && score.censoredEndpoints === 12 && score.scoredPairs === 53 && score.censoredPairs === 7)
    need(JSON.stringify([...replay.selectedPairs].sort((a: number, b: number) => a-b)) === JSON.stringify(REPLACED))
    const replacements = new Map<number, Json>()
    for (const e of replay.executions) if (e.selectedReplacement) { need(!replacements.has(e.pairIndex)); replacements.set(e.pairIndex, e) }
    need(replacements.size === 5)
    const archives: { directoryBasename: string; manifestFileSha256: string }[] = []
    const archive = (directory: string, sha: string) => {
      const item = { directoryBasename: basename(directory), manifestFileSha256: digest(sha) }
      const i = archives.findIndex(x => x.directoryBasename === item.directoryBasename)
      if (i >= 0) { need(archives[i].manifestFileSha256 === item.manifestFileSha256); return i }
      archives.push(item); return archives.length - 1
    }
    const headerArchiveIndices = replay.sourceArchives.map((x: Json) => archive(x.directory, x.manifest.fileSha256))
    const regimes: MorphoV2IdleCompactRegime[] = [], censorReasons: string[][] = [[]]
    const endpoints: MorphoV2IdleCompactEndpointTuple[] = [], cohorts: MorphoV2IdleCompactCohortTuple[] = []
    const blockIds = new Set<string>()
    for (let pair = 0; pair < 60; pair++) {
      const copyName = `result__cohort-${String(pair).padStart(2, '0')}.json`, original = get(copyName)
      need(original.pairIndex === pair)
      const e = replacements.get(pair)
      const legacyZeroIndicatorsOmitted = !e && pair === 59 && original.originalInspector === 'legacy_v2'
        && original.directory === 'data/research/venue-signals/pyusd-b576-idle-history-v2-2026-10-10T05-29-29.760Z-b9d9aa95-5eec-4e5d-92af-fd6b4d3d6091'
      const points: Json[] = e ? e.historicalPoints : original.report.points.filter((p: Json) => p.label !== 'current')
      need(points.length === 2 && points[0].label === 'anchor_0' && points[1].label === 'anchor_1')
      const archiveIndices = e ? headerArchiveIndices : [archive(original.sourceCompanion.directory, original.sourceCompanion.manifestFileSha256)]
      // Replacement replay does not embed completion clocks: preserve null rather than infer one.
      const collected = e ? null : time(original.report.nativeAcquisitionCompletedAtUtc)
      cohorts.push([
        basename(e ? e.directory : original.directory),
        digest(e ? e.reportFileSha256 : original.reportFile.fileSha256),
        digest(e ? e.reportBodySha256 : original.report.sha256),
        digest(e ? e.terminalFileSha256 : original.terminalFile.fileSha256),
        digest(e ? e.terminalBodySha256 : original.parentExecutionProof.binding.terminalBodySha256),
        e ? fileHash('result__header-replay.json') : fileHash(copyName), archiveIndices, collected,
      ])
      for (let side = 0; side < 2; side++) {
        const p = points[side], index = pair*2+side, scored = score.endpoints[index], sourceBlock = p.source
        need(scored.index === index && sourceBlock.chainId === 1 && sourceBlock.finalized === true)
        need(p.vault === VAULT && p.asset === ASSET && p.owner === OWNER && p.nativeAsset === ASSET
          && p.assetDecimals === 6 && p.shareDecimals === 18 && p.nativeAssetDecimals === 6 && p.nativeShareDecimals === 18
          && p.cashAssetDecimals === 6 && p.probeEaAssetDecimals === 6 && p.probeShareDecimals === 18
          && p.totalAssetsAssetDecimals === 6 && p.totalSupplyShareDecimals === 18 && p.probeSharesRaw === S)
        need(p.CMeaning === 'asset.balanceOf(exact_vault)_only' && p.cashIsTotalAssets === false && p.cashIsOwnedEntitlement === false
          && p.historicalOwnedEntitlementAssetRaw === null && p.historicalOwnedEntitlementMeasured === false)
        need(p.conversionBasis === 'hypothetical_fixed_current_stock_conversion')
        const b = raw(sourceBlock.blockNumber), h = sourceBlock.blockHash, t = time(sourceBlock.blockTime)
        need(typeof h === 'string' && /^0x[a-f0-9]{64}$/.test(h) && !blockIds.has(b) && !blockIds.has(h))
        blockIds.add(b); blockIds.add(h)
        if (index > 0) need(BigInt(b) > BigInt(endpoints[index-1][0]) && Date.parse(t) > Date.parse(endpoints[index-1][2]))
        need(p.runtimes.vault.runtimeKeccak256 === VCODE && p.runtimes.vault.runtimeByteLength === 21808
          && p.runtimes.asset.runtimeKeccak256 === ACODE && p.runtimes.asset.runtimeByteLength === 1506
          && p.runtimes.owner.runtimeKeccak256 === OCODE && p.runtimes.owner.runtimeByteLength === 0)
        const idle = p.liquidityAdapter === ZERO && p.liquidityData === '0x'
        need(p.liquidityData === '0x' && (idle || p.liquidityAdapter === OLD_ADAPTER))
        need(idle ? scored.status === 'measured' && p.regimeKind === 'zero_liquidity_adapter_empty_data'
          : scored.status === 'censored' && scored.reason === 'configuration_or_runtime_mismatch' && p.regimeKind === 'other_native_configuration')
        const cash = raw(p.CAssetRaw), quote = raw(p.probeEaAssetRaw), ta = raw(p.totalAssetsRaw), ts = raw(p.totalSupplySharesRaw)
        // Only the exact pinned legacy_v2 report omits these flags. Derive them from
        // canonical scalars; panel/header records still require their strict booleans.
        if (legacyZeroIndicatorsOmitted) need(p.measuredZeroCash === undefined && p.measuredZeroEntitlement === undefined)
        const measuredZeroCash = legacyZeroIndicatorsOmitted ? cash === '0' : p.measuredZeroCash
        const measuredZeroEntitlement = legacyZeroIndicatorsOmitted ? quote === '0' : p.measuredZeroEntitlement
        need(measuredZeroCash === (cash === '0') && measuredZeroEntitlement === (quote === '0'))
        if (idle) {
          const q = scored.point.fixedCurrentStockConversion
          need(scored.point.idleCashRaw === cash && q.assetsRaw === quote && q.probeSharesRaw === S
            && JSON.stringify(scored.point.source) === JSON.stringify(sourceBlock) && JSON.stringify(q.source) === JSON.stringify(sourceBlock))
        }
        const rt = (x: Json) => ({ bytes: x.runtimeByteLength, keccak256: x.runtimeKeccak256 })
        const regime: MorphoV2IdleCompactRegime = { nativeRegimeKind: p.regimeKind, liquidityAdapter: p.liquidityAdapter, liquidityData: p.liquidityData,
          vaultRuntime: rt(p.runtimes.vault), assetRuntime: rt(p.runtimes.asset), ownerRuntime: rt(p.runtimes.owner) }
        let ri = regimes.findIndex(x => JSON.stringify(x) === JSON.stringify(regime))
        if (ri < 0) { ri = regimes.length; regimes.push(regime) }
        const reasons = idle ? [] : [...p.qualificationReasons, scored.reason]
        let ci = censorReasons.findIndex(x => JSON.stringify(x) === JSON.stringify(reasons))
        if (ci < 0) { ci = censorReasons.length; censorReasons.push(reasons) }
        endpoints.push([b, h, t, cash, quote, ta, ts, p.actualHistoricalOwnerSharesRaw === null ? null : raw(p.actualHistoricalOwnerSharesRaw), ri, ci])
      }
    }
    need(regimes.length === 2 && endpoints.filter(p => p[9] === 0).length === 108)
    const pairs: MorphoV2IdleCompactPairTuple[] = score.pairs.map((p: Json, index: number) => {
      need(p.pairIndex === index && p.issueIndex === index*2 && p.outcomeIndex === index*2+1 && p.horizonMs === 86400000)
      need(p.simulatedIssueAtUtc === endpoints[index*2][2] && p.exactTargetAtUtc === endpoints[index*2+1][2]
        && Date.parse(p.exactTargetAtUtc)-Date.parse(p.simulatedIssueAtUtc) === 86400000)
      const used = p.donorChoices.filter((d: Json) => d.status === 'used')
      need(used.length === p.usedDonorPairs && used.length === p.nativeEligibleDonorPairs)
      for (const d of used) need(Number.isInteger(d.pairIndex) && d.pairIndex < index && d.pairIndex >= 0
        && Date.parse(endpoints[d.pairIndex*2+1][2]) < Date.parse(p.simulatedIssueAtUtc))
      need(p.status === 'scored' || p.status === 'censored')
      return [p.status, p.censorReason, p.nativeEligibleDonorPairs, p.usedDonorPairs]
    })
    const metric = (v: Json): MorphoV2IdleCompactScore => ({ comparisons: v.scoredPairs,
      availableAbsoluteErrorSumRaw: raw(v.availableAbsoluteErrorSumRaw), shortfallAbsoluteErrorSumRaw: raw(v.shortfallAbsoluteErrorSumRaw),
      endpointInsufficiencyClassificationMatches: v.endpointInsufficiencyClassificationMatches })
    need(score.joint.scoredPairs === 53 && score.matchedPersistence.scoredPairs === 53 && score.persistence.scoredPairs === 54)
    need(BigInt(score.joint.availableAbsoluteErrorSumRaw) >= BigInt(score.matchedPersistence.availableAbsoluteErrorSumRaw)
      && BigInt(score.joint.shortfallAbsoluteErrorSumRaw) >= BigInt(score.matchedPersistence.shortfallAbsoluteErrorSumRaw))
    const panel: MorphoV2IdleCompact120Panel = {
      schema: MORPHO_V2_IDLE_COMPACT120_SCHEMA, identity: { ...score.identity },
      recordedProbe: { owner: OWNER, sharesRaw: S, quoteKind: 'native_preview_redeem_recorded_probe_stock', historicalOwnedEntitlement: null },
      actualAvailabilityAtUtc: time(proof.result.postRetentionCompletedAtUtc),
      sourceCommitments: {
        retentionDirectoryBasename: MORPHO_V2_IDLE_COMPACT120_SOURCE.split('/').pop()!, retentionManifestFileSha256: MORPHO_V2_IDLE_COMPACT120_MANIFEST_SHA256,
        replayTerminalFileSha256: fileHash('result__terminal.json'), rootReplayProofFileSha256: fileHash('root-score-proof.json'),
        referencesFileSha256: fileHash('result__references.json'), selectedScoreFileSha256: fileHash('result__backtest-header-replaced60.json'),
        headerReplayFileSha256: fileHash('result__header-replay.json'), catalogSha256: digest(score.catalogSha256),
        headerExecutionAcceptance: { path: replay.acceptance.path, bytes: replay.acceptance.bytes, fileSha256: digest(replay.acceptance.fileSha256) },
      },
      sourceArchives: archives, endpoints, cohorts, pairs, regimes, censorReasons,
      counts: { plannedEndpoints: 120, usableEndpoints: 108, censoredEndpoints: 12, plannedPairs: 60, nativeEndpointPairs: 54, jointComparisons: 53, censoredJointPairs: 7 },
      retrospectiveScores: { joint: metric(score.joint), matchedPersistence: metric(score.matchedPersistence), allNativePersistence: metric(score.persistence), availableErrorImproved: false, shortfallErrorImproved: false },
      disclosure: { horizonMs: 86400000, requestedRaw: '500000', competingMRaw: null, retrospectivePartitionLabels: ['fit', 'calibration', 'holdout'], pairsPerPartition: 20,
        allCashEndpointsPreviouslyInspected: true, oldOctoberJointEndpointsPreviouslyInspected: true, netCashDeltaAlreadyIncludesCompetingFlow: true,
        additionalCompetingFlowSubtraction: false, observedEndpointsPerPair: 2, dailyEndpointsCertifyContinuousDuration: false,
        modeledSamplesAreNativeOutcomes: false, donorEndMustPrecedeIssue: true },
      claims: { nativeReplayPerformedByBuilder: false, originalAuthority: false, profileApproval: false, live: false, historicalOwnership: false,
        historicalOwnedEntitlementMeasured: false, currentWalletControl: false, sourceImplementationEquivalence: false, arbitrarySharesNativeRepricing: false,
        executionVerified: false, authenticated: false, calibrated: false, calibratedProbability: false, untouchedHoldout: false,
        prospectiveValidation: false, accuracyImprovementClaim: false, coveragePromotion: false },
    }
    const text = JSON.stringify(panel), size = Buffer.byteLength(text)
    need(size <= MORPHO_V2_IDLE_COMPACT120_MAX_BYTES)
    return Object.freeze({ panel: freeze(panel), text, bytes: size, sha256: hash(Buffer.from(text)) })
  } catch { return null }
}
