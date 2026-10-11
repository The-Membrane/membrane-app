// Offline adapter for two immutable actual captures. Importing performs no reads or writes.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => {
  if (!ok) throw Error('fluid_joint_replay_' + code)
}
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
export const FLUID_JOINT_CAPTURE_PINS = freeze({
  native: {
    path: 'data/research/venue-signals/fluid-usdt-bridge-capacity-history-2026-10-07T20-30.json',
    bytes: 666979,
    fileSha256: 'bb5c04193d08e833542ca638a5a73944ff740758120faff1fe88238ae181d11b',
    bodySha256: 'ded702880804cbf6dddfa886af5dd7a12df28a89d999c4d9c0d693d0fdb0e5dc',
  },
  fixed: {
    path: 'data/research/venue-signals/fluid-usdt-fixed-output-history-2026-10-07T21-35.json',
    bytes: 297606,
    fileSha256: 'f4cd88b1586f5ddc6a7488ca25c756427c92e4cd4ad2ad21bde4a5c1b2989dd8',
    bodySha256: '686aaa1d380e89b74764d85f8e9c2cef4acccdb55981ee376f57613dff36f8a2',
  },
})
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const HELPER = resolve(REPO, 'lib/carry/fluidUsdtBridgeJointHistoricalProcess.ts')
export const FLUID_JOINT_HELPER_SHA256 =
  '879c886627043b8dbb6ed5572721459a07a03948a32059d4c2c7523f6e6a6f08'
let modulesPromise
const plans = new Map()
async function modules() {
  if (!modulesPromise)
    modulesPromise = (async () => {
      // Register both TS module formats, as the existing CommonJS project requires.
      await import('tsx')
      const [native, fixed, conversion, helper] = await Promise.all([
        import('./fluid-usdt-bridge-capacity-history-capture.mjs'),
        import('./fluid-usdt-fixed-output-history-capture.mjs'),
        import('./fluid-usdt-historical-conversion-capture.mjs'),
        import(pathToFileURL(HELPER).href),
      ])
      return { native, fixed, conversion, helper: helper.default ?? helper }
    })()
  return modulesPromise
}
function pinned(text, pin) {
  check(
    typeof text === 'string' &&
      Buffer.byteLength(text) === pin.bytes &&
      sha(text) === pin.fileSha256,
    'immutable_file_pin',
  )
  const value = JSON.parse(text)
  const { sha256, ...body } = value
  check(
    sha256 === pin.bodySha256 && sha(JSON.stringify(body)) === pin.bodySha256,
    'immutable_body_pin',
  )
  return value
}
function read(root, pin) {
  return readBoundedReceiptFile(resolve(root, pin.path), {
    maxFileBytes: pin.bytes,
    maxTotalBytes: pin.bytes,
    totalBytes: 0,
  })
}
/** Bytes are checked before preparing plans or loading any decoder. No supplied derived facts. */
export async function replayFluidUsdtBridgeJointHistory(texts, { root = REPO } = {}) {
  check(
    texts &&
      Object.keys(texts).length === 2 &&
      Object.hasOwn(texts, 'native') &&
      Object.hasOwn(texts, 'fixed'),
    'exact_inputs',
  )
  const nativeRaw = pinned(texts.native, FLUID_JOINT_CAPTURE_PINS.native)
  pinned(texts.fixed, FLUID_JOINT_CAPTURE_PINS.fixed)
  const helperText = readBoundedReceiptFile(HELPER, {
    maxFileBytes: 20000,
    maxTotalBytes: 20000,
    totalBytes: 0,
  })
  check(sha(helperText) === FLUID_JOINT_HELPER_SHA256, 'helper_source_pin')
  const m = await modules()
  const base = resolve(root)
  if (!plans.has(base))
    plans.set(base, {
      native: m.native.prepareFluidBridgeCapacityHistoryPlan({ root: base }),
      fixed: m.fixed.prepareFluidFixedOutputHistoryPlan({ root: base }),
    })
  const plan = plans.get(base)
  const native = m.native.replayFluidBridgeCapacityHistory(nativeRaw, plan.native)
  const fixed = m.fixed.replayPinnedLegacyFluidFixedOutputHistory(texts.fixed, plan.fixed)
  check(
    native.physicalStarts === 112 &&
      fixed.physicalStarts === 12 &&
      native.points.length === 2 &&
      fixed.points.length === 2,
    'actual_read_counts',
  )
  const issues = m.fixed.FLUID_FIXED_OUTPUT_INPUT_PINS.slice(0, 2).map((pin) =>
    pinned(read(base, pin), pin),
  )
  const availableAtUtc = [native.availableAtUtc, fixed.availableAtUtc].sort().at(-1)
  const history = native.points.map((point, index) => {
    const quote = fixed.points[index],
      origin = plan.fixed.anchors[index],
      issue = issues[index]
    const target = issue.targets.find((row) => row.horizonHours === 24)
    check(
      isDeepStrictEqual(point.source, quote.source) &&
        isDeepStrictEqual(point.source, origin.source) &&
        point.holderSharesRaw === quote.holderSharesRaw &&
        point.fullPreviewRedeemNetFeeRaw === quote.nativeFullPositionEntitlementRaw &&
        point.withdrawalsPaused === false &&
        point.feeBpsRaw === '5' &&
        point.wrapperSourceBinding === 'reviewed_lite_runtime_bound' &&
        point.proxySourceEquivalence === 'reviewed_proxy_runtime_bound' &&
        quote.status === 'conditional_exact_output_quote' &&
        quote.requiredUsdcRaw === '10144' &&
        quote.inputDecimals === 6 &&
        quote.outputDecimals === 6 &&
        quote.fixedFinalUsdtOutputRaw === '10145' &&
        quote.questionBinding === 'unassessed' &&
        quote.originalFinalUsdtRequestedRaw === null &&
        target,
      'joined_facts',
    )
    const p = point.underlyingProtocolProngs,
      contracts = m.conversion.CONTRACTS
    check(p && p.fTokenReportedSupplyRaw === p.resolverSupplyRaw, 'protocol_supply_agreement')
    const runtimeCodeHashes = {
      [plan.fixed.subject.destination]: point.proxyCodeKeccak256,
      [point.implementation]: point.implementationCodeKeccak256,
      [point.observedFUSDC]: point.fusdcCodeKeccak256,
      [contracts.factory]: quote.reusedQuoteIdentity.runtimeCodeHashes.factory,
      [contracts.quoter]: quote.reusedQuoteIdentity.runtimeCodeHashes.quoter,
      [quote.reusedQuoteIdentity.pool]: quote.reusedQuoteIdentity.runtimeCodeHashes.pool,
    }
    return {
      source: point.source,
      originalIssue: {
        issueId: origin.issueFile,
        issueAtUtc: issue.issuedAtUtc,
        targetAtUtc: target.targetAtUtc,
        horizonHours: target.horizonHours,
      },
      availableAtUtc,
      provenanceRef: `native:${nativeRaw.sha256};fixed:${FLUID_JOINT_CAPTURE_PINS.fixed.bodySha256};anchor:${index}`,
      runtimeCodeHashes,
      owner: quote.owner,
      holderSharesRaw: point.holderSharesRaw,
      regime: `lite:${point.implementation}:fee5bps:unpaused`,
      paused: false,
      withdrawalFeeBps: Number(point.feeBpsRaw),
      fullHolderNetUsdcRaw: point.fullPreviewRedeemNetFeeRaw,
      nativeProngs: {
        bridgeFunding: point.fusdcMaxWithdrawBridgeRaw,
        bankCash: p.sharedLiquidityCashRaw,
        bankSupply: p.fTokenReportedSupplyRaw,
        bankWithdrawableUntilLimit: p.withdrawableUntilLimitRaw,
        bankResolverWithdrawable: p.resolverReportedWithdrawableRaw,
      },
      conversion: {
        inputAsset: quote.inputAsset,
        outputAsset: quote.outputAsset,
        inputDecimals: quote.inputDecimals,
        outputDecimals: quote.outputDecimals,
        fixedFinalUsdtOutputRaw: quote.fixedFinalUsdtOutputRaw,
        requiredNetUsdcRaw: quote.requiredUsdcRaw,
        method: 'quoteExactOutputSingle',
      },
    }
  })
  // Canonical joined input is private to the approval closure; caller mutations never authorize facts.
  const canonical = freeze({
    mode: 'dated_captured_projection',
    routeKey: plan.fixed.subject.routeKey,
    destination: plan.fixed.subject.destination,
    owner: plan.fixed.subject.owner,
    issueAtUtc: availableAtUtc,
    horizonHours: 24,
    requestedFinalUsdtRaw: fixed.fixedFinalUsdtOutputRaw,
    originalQuestion: {
      firstLegUsdcRequestedRaw: fixed.originalFirstLegUsdcRequestedRaw,
      finalUsdtRequestedRaw: null,
      questionBinding: 'unassessed',
      targetSelection: 'research_selected_numeric_reuse_not_conversion',
    },
    history,
    baseline: history.at(-1),
    maxHistoricalGapSeconds: 3600,
  })
  const approve = (kind, candidate) => kind === 'history' && isDeepStrictEqual(candidate, canonical)
  const process = m.helper.buildFluidUsdtBridgeJointHistoricalProcess(canonical, approve)
  check(
    process && process.descriptiveHistoricalOnly && process.prospectiveProcess === null,
    'dated_process',
  )
  return {
    input: structuredClone(canonical),
    approve,
    process: freeze(process),
    report: freeze({
      schema: 'fluid_usdt_joint_native_historical_replay_v1',
      capturePins: FLUID_JOINT_CAPTURE_PINS,
      helperSha256: FLUID_JOINT_HELPER_SHA256,
      captureAvailability: { native: native.availableAtUtc, fixed: fixed.availableAtUtc },
      actualReads: { native: 112, fixed: 12 },
      originalIssues: issues.map((i) => ({
        sequence: i.sequence,
        issuedAtUtc: i.issuedAtUtc,
        targets: i.targets,
        payoutAssessment: i.payoutAssessment,
      })),
      provenanceCorrection: fixed.provenanceCorrection,
      originalQuestionResolved: false,
      process,
    }),
  }
}
export async function loadFluidUsdtBridgeJointHistory({ root = REPO } = {}) {
  return replayFluidUsdtBridgeJointHistory(
    Object.fromEntries(
      Object.entries(FLUID_JOINT_CAPTURE_PINS).map(([key, pin]) => [key, read(root, pin)]),
    ),
    { root },
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 3 && process.argv[2] === '--replay', 'offline_mode')
    globalThis.fetch = async () => {
      throw Error('fluid_joint_replay_network_forbidden')
    }
    const result = await loadFluidUsdtBridgeJointHistory()
    // Explicit CLI mode returns JSON only; saving is a caller decision.
    console.log(JSON.stringify(result.report))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
