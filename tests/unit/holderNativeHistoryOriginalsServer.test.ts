import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  beginHolderNativeHistoryOriginalSeries,
  finishHolderNativeHistoryOriginalSeries,
  getLastHolderNativeHistoryOriginalRetentionStatus,
  recordHolderNativeHistoryOriginalBatch,
  type HolderNativeHistoryOriginalSeries,
} from '@/lib/carry/holderNativeHistoryOriginals.server'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    statfsSync: vi.fn(fs.statfsSync),
    writeFileSync: vi.fn(fs.writeFileSync),
    fsyncSync: vi.fn(fs.fsyncSync),
  }
})
const fluidFiles = [
  'scripts/research/carry-depth-quote-provider-policy.json',
  'components/Carry/fixtures.ts',
  'components/Carry/types.ts',
  'lib/carry/conditionalGrossFlowHeadroom.ts',
  'lib/carry/conditionalSampledCashPathProjection.ts',
  'lib/carry/directSupplyMarketConstants.ts',
  'lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts',
  'lib/carry/fluidExitCapacity.ts',
  'lib/carry/fluidUsdcBridgeJointHistoricalEvidence.server.ts',
  'lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec.ts',
  'lib/carry/fluidUsdcBridgeJointTrustedProfile.ts',
  'lib/carry/fluidUsdcBridgeNativeAbi.ts',
  'lib/carry/fluidUsdcBridgeNativeCapacity.ts',
  'lib/carry/forecastRegistry.ts',
  'lib/carry/forecastRegistryMarkets.ts',
  'lib/carry/historicalCompetingFlowEstimate.ts',
  'lib/carry/historicalFlowDuration.ts',
  'lib/carry/holderExitCapacity.ts',
  'lib/carry/holderExitMechanisms.ts',
  'lib/carry/holderExitSubjectRegistry.ts',
  'lib/carry/holderNativeHistoryOriginals.server.ts',
  'lib/carry/holderOriginCode.ts',
  'lib/carry/morpho-v2-asset-identities.json',
  'lib/carry/other-vault-asset-identities.json',
  'lib/carry/usd3ExitQuote.ts',
  'scripts/lib/boundedLocalReceiptFile.mjs',
  'scripts/lib/depth-identity.mjs',
  'scripts/lib/depthCurve.mjs',
  'scripts/lib/historicalDepthQuoteStore.mjs',
  'scripts/lib/venue-reads.mjs',
  'scripts/research/carry-depth-quote-archive.mjs',
  'scripts/research/carry-fluid-capacity-prongs.mjs',
  'scripts/research/conditional-cash-time-holdout.mjs',
  'scripts/research/fluid-bridge-usdc-hypothetical-history-capture.mjs',
  'scripts/research/fluid-usdt-bridge-capacity-history-capture.mjs',
  'scripts/research/fluid-usdt-full-position-history-capture.mjs',
  'scripts/research/fluid-usdt-historical-conversion-capture.mjs',
  'scripts/research/fluid-usdt-whole-position-path-capture.mjs',
  'scripts/route-cohort/aug-2026-ab-vault-seed.json',
  'tools/venue-recorder.config.json',
]
const fluidUsdtCurrentFiles = [
  'lib/carry/conditionalGrossFlowHeadroom.ts',
  'lib/carry/conditionalSampledCashPathProjection.ts',
  'lib/carry/fluidBridgeUsdcJointHistoricalProcess.ts',
  'lib/carry/fluidUsdcBridgeJointTrustedProfile.ts',
  'lib/carry/fluidUsdcBridgeNativeAbi.ts',
  'lib/carry/fluidUsdcBridgeNativeCapacity.ts',
  'lib/carry/fluidUsdtBridgeNativeCapacity.server.ts',
  'lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec.ts',
  'lib/carry/historicalCashContext.ts',
  'lib/carry/historicalCompetingFlowEstimate.ts',
  'lib/carry/historicalFlowDuration.ts',
  'lib/carry/historicalGrossFlowStress.ts',
  'lib/carry/historicalSampledCashPaths.ts',
  'lib/carry/holderNativeHistoryOriginals.server.ts',
  'lib/carry/localHistoricalSampledCashTimeline.ts',
  'scripts/lib/boundedLocalReceiptFile.mjs',
  'scripts/lib/depth-identity.mjs',
  'scripts/lib/depthCurve.mjs',
  'scripts/lib/historicalDepthQuoteStore.mjs',
  'scripts/lib/venue-reads.mjs',
  'scripts/research/carry-depth-quote-archive.mjs',
  'scripts/research/carry-depth-quote-provider-policy.json',
  'scripts/research/conditional-cash-time-holdout.mjs',
  'scripts/research/usd3-hypothetical-history-capture.mjs',
  'tools/venue-recorder.config.json',
]
const fluidUsdtHistoryFiles = [
  ...fluidUsdtCurrentFiles,
  'lib/carry/fluidUsdtBridgeJointHistoricalEvidence.server.ts',
  'lib/carry/fluidUsdtBridgeJointComposedHistoricalEvidenceCodec.ts',
  'lib/carry/fluidUsdcBridgeJointNativeEvidenceCodec.ts',
].sort()
const umbrellaFiles = [
  'lib/carry/aggregateCashQHoldout.ts',
  'lib/carry/conditionalGrossFlowHeadroom.ts',
  'lib/carry/conditionalSampledCashPathProjection.ts',
  'lib/carry/historicalCashContext.ts',
  'lib/carry/historicalCashProjection.ts',
  'lib/carry/historicalCompetingFlowEstimate.ts',
  'lib/carry/historicalFlowDuration.ts',
  'lib/carry/historicalGrossFlowStress.ts',
  'lib/carry/historicalSampledCashPaths.ts',
  'lib/carry/holderNativeHistoryOriginals.server.ts',
  'lib/carry/holderOriginCode.ts',
  'lib/carry/localHistoricalCashScenario.ts',
  'lib/carry/localHistoricalSampledCashTimeline.ts',
  'lib/carry/umbrellaGhoExit.ts',
  'lib/carry/umbrellaGhoNativeCapacity.server.ts',
  'lib/carry/umbrellaGhoNativeCapacity.ts',
  'lib/forecast/exitImpactForecast.ts',
  'scripts/lib/boundedLocalReceiptFile.mjs',
  'scripts/lib/depth-identity.mjs',
  'scripts/lib/depthCurve.mjs',
  'scripts/lib/historicalDepthQuoteStore.mjs',
  'scripts/lib/venue-reads.mjs',
  'scripts/research/carry-depth-quote-archive.mjs',
  'scripts/research/carry-depth-quote-provider-policy.json',
  'scripts/research/conditional-cash-time-holdout.mjs',
  'scripts/research/usd3-hypothetical-history-capture.mjs',
  'scripts/route-cohort/aug-2026-ab-vault-seed.json',
  'tools/venue-recorder.config.json',
]
const umbrellaHistoryFiles = [
  ...umbrellaFiles,
  'scripts/research/umbrella-gho-joint-history-capture.mjs',
  'lib/carry/umbrellaGhoJointHistoricalEvidence.server.ts',
  'lib/carry/umbrellaGhoJointNativeHistory.ts',
  'lib/carry/umbrellaGhoJointStockProjection.ts',
].sort()
const apyFiles = [
  ...umbrellaFiles.filter((p) => !p.includes('umbrella')),
  ...[
    'lib/carry/apyUsdFeeOutlook.ts',
    'lib/carry/apyUsdJointNativeEvidence.server.ts',
    'lib/carry/apyUsdJointNativeEvidence.ts',
    'lib/carry/apyUsdJointStockProjection.ts',
    'lib/carry/usd3JointNativeEvidenceCodec.ts',
    'lib/carry/usd3JointTrustedProfile.ts',
    'scripts/research/apyusd-joint-native-history-capture.mjs',
  ],
].sort()
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
let root: string
const S = '3000000000000000000'
const begin = () =>
  beginHolderNativeHistoryOriginalSeries({ kind: 'fluid_usdc_bridge', sharesRaw: S })
function batch(index = 0, accepted = true) {
  // Synthetic archival control fixture, never native-original acquisition authority.
  const body = {
    schema: 'synthetic_archival_control_not_native_capture',
    startedAtUtc: '2026-10-08T12:00:00.000Z',
    availableAtUtc: '2026-10-08T12:00:01.000Z',
    elapsedMs: 1000.125,
    physicalStarts: 2,
    ledger: [
      {
        physicalId: 1,
        enteredElapsedMs: 0.125,
        responseBodyBase64: Buffer.from('{"result":"0x1"}').toString('base64'),
      },
    ],
  }
  return {
    batchIndex: index,
    plan: { subject: { sharesRaw: S }, anchors: [108, 109, 110, 111] },
    receipt: { ...body, sha256: sha(JSON.stringify(body)) },
    capturedAccepted: accepted,
  }
}
const qualified = (n = 1) => ({
  qualification: true,
  reason: 'qualified' as const,
  batchQualifications: Array(n).fill(true),
})
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'holder-original-recorder-test-')))
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'data/research/venue-signals'), { recursive: true })
  for (const file of new Set([
    ...fluidFiles,
    ...fluidUsdtCurrentFiles,
    ...fluidUsdtHistoryFiles,
    ...umbrellaFiles,
    ...umbrellaHistoryFiles,
    ...apyFiles,
  ])) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(
      join(root, file),
      '/* synthetic source snapshot fixture: no provider credentials */\n',
    )
  }
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  vi.mocked(statfsSync).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('local holder native-history original recorder', () => {
  it('retains composed USDT dynamic history separately with positive native S and two batches', () => {
    const handle = beginHolderNativeHistoryOriginalSeries({
      kind: 'fluid_usdt_bridge_history',
      sharesRaw: S,
    })
    recordHolderNativeHistoryOriginalBatch(handle, batch(0))
    recordHolderNativeHistoryOriginalBatch(handle, batch(1))
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified(2))
    expect(status.status).toBe('retained')
    const manifest = JSON.parse(
      readFileSync(join(status.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    expect(manifest.sourceSnapshots.map((s: any) => s.source)).toEqual(fluidUsdtHistoryFiles)
    expect(manifest.sharesRaw).toBe(S)
    expect(status.recordedBatches).toBe(2)
    expect(status.sourceClosureSha256).toBe(sha(JSON.stringify(manifest.sourceSnapshots)))
    expect(status.originalAuthority).toBe(false)
    expect(status.historicalOwnership).toBe(false)
  })
  it.each([null, '0'])(
    'does not admit unknown/zero S to composed USDT history: %s',
    (sharesRaw) => {
      const handle = beginHolderNativeHistoryOriginalSeries({
        kind: 'fluid_usdt_bridge_history',
        sharesRaw,
      })
      const status = finishHolderNativeHistoryOriginalSeries(handle, {
        qualification: false,
        reason: 'plan_rejected',
        batchQualifications: [],
      })
      expect(status.reason).toBe('invalid_input')
      expect(status.producerReplayQualification).toBe(false)
    },
  )
  it('rejects changed composed USDT codec before qualification while retaining its exact before source', () => {
    const source = 'lib/carry/fluidUsdtBridgeJointComposedHistoricalEvidenceCodec.ts'
    const handle = beginHolderNativeHistoryOriginalSeries({
      kind: 'fluid_usdt_bridge_history',
      sharesRaw: S,
    })
    const recorded = recordHolderNativeHistoryOriginalBatch(handle, batch())
    writeFileSync(join(root, source), 'changed synthetic composition dependency')
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(status.reason).toBe('source_changed')
    expect(status.producerReplayQualification).toBe(false)
    const manifest = JSON.parse(
      readFileSync(join(recorded.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    const index = manifest.sourceSnapshots.findIndex((s: any) => s.source === source)
    expect(index).toBeGreaterThanOrEqual(0)
    expect(
      readFileSync(
        join(
          recorded.artifactDirectory!,
          'source-' + String(index).padStart(2, '0') + '-' + source.split('/').at(-1),
        ),
        'utf8',
      ),
    ).toBe('/* synthetic source snapshot fixture: no provider credentials */\n')
  })

  it('retains unknown-current USDT S with a closed native quote/funding source inventory and false authority', () => {
    const handle = beginHolderNativeHistoryOriginalSeries({
      kind: 'fluid_usdt_bridge_current',
      sharesRaw: null,
    })
    recordHolderNativeHistoryOriginalBatch(handle, batch())
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(status.status).toBe('retained')
    const manifest = JSON.parse(
      readFileSync(join(status.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    expect(manifest.kind).toBe('fluid_usdt_bridge_current')
    expect(manifest.sharesRaw).toBeNull()
    expect(manifest.sourceSnapshots.map((s: any) => s.source)).toEqual(fluidUsdtCurrentFiles)
    expect(status.sourceClosureSha256).toBe(sha(JSON.stringify(manifest.sourceSnapshots)))
    expect(manifest.sourceClosureSha256).toBe(status.sourceClosureSha256)
    expect(status.originalAuthority).toBe(false)
    expect(status.authenticated).toBe(false)
    expect(status.executionQualified).toBe(false)
    expect(status.historicalOwnership).toBe(false)
  })
  it.each([
    'lib/carry/fluidUsdtBridgeNativeCapacity.server.ts',
    'lib/carry/fluidUsdtBridgeNativeQuoteEvidenceCodec.ts',
    'lib/carry/fluidUsdcBridgeJointTrustedProfile.ts',
    'scripts/research/usd3-hypothetical-history-capture.mjs',
  ])('rejects post-begin USDT native dependency drift in %s', (source) => {
    const handle = beginHolderNativeHistoryOriginalSeries({
      kind: 'fluid_usdt_bridge_current',
      sharesRaw: null,
    })
    const recorded = recordHolderNativeHistoryOriginalBatch(handle, batch())
    writeFileSync(join(root, source), 'changed synthetic dependency after acquisition began')
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(status.reason).toBe('source_changed')
    expect(status.producerReplayQualification).toBe(false)
    expect(status.originalAuthority).toBe(false)
    const manifest = JSON.parse(
      readFileSync(join(recorded.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    const index = fluidUsdtCurrentFiles.indexOf(source)
    expect(manifest.sourceSnapshots[index].source).toBe(source)
    expect(
      readFileSync(
        join(
          recorded.artifactDirectory!,
          'source-' + String(index).padStart(2, '0') + '-' + source.split('/').at(-1),
        ),
        'utf8',
      ),
    ).toContain('synthetic source snapshot')
  })
  it('binds APY unknown-current/zero-history to actual identical source closures without granting authority', () => {
    const statuses = (['apy_usd_current', 'apy_usd_history'] as const).map((kind) => {
      const handle = beginHolderNativeHistoryOriginalSeries({
        kind,
        sharesRaw: kind === 'apy_usd_current' ? null : '0',
      })
      recordHolderNativeHistoryOriginalBatch(handle, batch())
      const status = finishHolderNativeHistoryOriginalSeries(handle, qualified())
      expect(status.status).toBe('retained')
      const manifest = JSON.parse(
        readFileSync(join(status.artifactDirectory!, 'manifest.json'), 'utf8'),
      )
      expect(manifest.sourceSnapshots.map((s: any) => s.source)).toEqual(apyFiles)
      expect(status.sourceClosureSha256).toBe(sha(JSON.stringify(manifest.sourceSnapshots)))
      expect(manifest.sourceClosureSha256).toBe(status.sourceClosureSha256)
      expect(status.originalAuthority).toBe(false)
      return status
    })
    expect(statuses[0].sourceClosureSha256).toBe(statuses[1].sourceClosureSha256)
    writeFileSync(
      join(root, 'lib/carry/apyUsdJointNativeEvidence.ts'),
      'changed synthetic executing codec',
    )
    const next = beginHolderNativeHistoryOriginalSeries({
      kind: 'apy_usd_current',
      sharesRaw: null,
    })
    recordHolderNativeHistoryOriginalBatch(next, batch())
    expect(finishHolderNativeHistoryOriginalSeries(next, qualified()).sourceClosureSha256).not.toBe(
      statuses[0].sourceClosureSha256,
    )
  })
  it('permits truthful unknown S only for the current Umbrella kind, retaining no authority', () => {
    const handle = beginHolderNativeHistoryOriginalSeries({
      kind: 'umbrella_gho_current',
      sharesRaw: null,
    })
    recordHolderNativeHistoryOriginalBatch(handle, batch())
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(status.status).toBe('retained')
    const manifest = JSON.parse(
      readFileSync(join(status.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    expect(manifest.kind).toBe('umbrella_gho_current')
    expect(manifest.sharesRaw).toBeNull()
    expect(manifest.sourceSnapshots.map((s: any) => s.source)).toEqual(umbrellaFiles)
    expect(manifest.originalAuthority).toBe(false)
    for (const kind of ['usd3', 'fluid_usdc_bridge', 'umbrella_gho_history'] as const) {
      const invalid = beginHolderNativeHistoryOriginalSeries({ kind, sharesRaw: null })
      expect(
        finishHolderNativeHistoryOriginalSeries(invalid, {
          qualification: false,
          reason: 'invalid_input',
          batchQualifications: [],
        }).reason,
      ).toBe('invalid_input')
    }
  })
  it('retains a positive full-S Umbrella historical series with the fixed execution closure and false authority', () => {
    const handle = beginHolderNativeHistoryOriginalSeries({
      kind: 'umbrella_gho_history',
      sharesRaw: S,
    })
    const input = batch()
    recordHolderNativeHistoryOriginalBatch(handle, input)
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(status.status).toBe('retained')
    const manifest = JSON.parse(
      readFileSync(join(status.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    expect(manifest.kind).toBe('umbrella_gho_history')
    expect(manifest.sharesRaw).toBe(S)
    expect(manifest.sourceSnapshots.map((source: any) => source.source)).toEqual(
      umbrellaHistoryFiles,
    )
    expect(manifest.originalAuthority).toBe(false)
    expect(manifest.authenticated).toBe(false)
    expect(manifest.historicalOwnership).toBe(false)
    expect(manifest.executionQualified).toBe(false)
    expect(
      JSON.parse(
        readFileSync(join(status.artifactDirectory!, 'batch-0-prepared-plan.json'), 'utf8'),
      ),
    ).toEqual(input.plan)
  })
  it.each(['0', '00', '-1', '1.0', (1n << 256n).toString()])(
    'rejects historical nonpositive/noncanonical full S %s',
    (sharesRaw) => {
      const handle = beginHolderNativeHistoryOriginalSeries({
        kind: 'umbrella_gho_history',
        sharesRaw,
      })
      expect(
        finishHolderNativeHistoryOriginalSeries(handle, {
          qualification: false,
          reason: 'invalid_input',
          batchQualifications: [],
        }).reason,
      ).toBe('invalid_input')
    },
  )
  it('retains original plan/receipt bytes, source snapshots and both unkeyed manifest seals without authority', () => {
    const handle = begin(),
      input = batch()
    const pending = recordHolderNativeHistoryOriginalBatch(handle, input)
    expect(pending.producerReplayQualification).toBe(false)
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(status.status).toBe('retained')
    expect(Object.isFrozen(status)).toBe(true)
    const directory = status.artifactDirectory!,
      manifestBytes = readFileSync(join(directory, 'manifest.json'))
    const manifest = JSON.parse(manifestBytes.toString()),
      { sha256, ...body } = manifest
    expect(sha(manifestBytes)).toBe(status.manifestFileSha256)
    expect(sha(JSON.stringify(body))).toBe(sha256)
    expect(sha256).toBe(status.manifestBodySha256)
    expect(body.originalAuthority).toBe(false)
    expect(body.authenticated).toBe(false)
    expect(body.executionQualified).toBe(false)
    expect(body.historicalOwnership).toBe(false)
    expect(body.batches[0].capturedAccepted).toBe(true)
    expect(body.batches[0].receiptDeclaredBodySha256).toBe(input.receipt.sha256)
    expect(readFileSync(join(directory, 'batch-0-original-receipt.json'), 'utf8')).toBe(
      JSON.stringify(input.receipt) + '\n',
    )
    expect(readFileSync(join(directory, 'batch-0-prepared-plan.json'), 'utf8')).toBe(
      JSON.stringify(input.plan) + '\n',
    )
    expect(body.sourceSnapshots).toHaveLength(fluidFiles.length)
    expect(status.sourceClosureSha256).toBe(sha(JSON.stringify(body.sourceSnapshots)))
    for (const name of readdirSync(directory)) {
      const s = lstatSync(join(directory, name))
      expect(s.mode & 0o777).toBe(0o600)
      expect(s.nlink).toBe(1)
    }
  })
  it('preserves rejected original raw data and immutable rejection reason before a failed native replay', () => {
    const handle = begin()
    recordHolderNativeHistoryOriginalBatch(handle, batch(0, false))
    const status = finishHolderNativeHistoryOriginalSeries(handle, {
      qualification: false,
      reason: 'replay_rejected',
      batchQualifications: [],
    })
    const manifest = JSON.parse(
      readFileSync(join(status.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    expect(status.status).toBe('partial')
    expect(status.reason).toBe('replay_rejected')
    expect(manifest.batches[0].capturedAccepted).toBe(false)
    expect(manifest.batchQualifications).toEqual([false])
    expect(manifest.producerReplayQualification).toBe(false)
    const original = readFileSync(join(status.artifactDirectory!, 'manifest.json'))
    expect(finishHolderNativeHistoryOriginalSeries(handle, qualified())).toBe(status)
    expect(readFileSync(join(status.artifactDirectory!, 'manifest.json'))).toEqual(original)
  })
  it('allows three sequential batches and seals distinct physical originals without another RPC', () => {
    const handle = begin()
    for (let n = 0; n < 3; n++)
      expect(recordHolderNativeHistoryOriginalBatch(handle, batch(n)).recordedBatches).toBe(n + 1)
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified(3))
    expect(status.recordedBatches).toBe(3)
    expect(getLastHolderNativeHistoryOriginalRetentionStatus()).toBe(status)
  })
  it('cannot turn a rejected capture or incomplete batch qualification into accepted archival status', () => {
    const rejected = begin()
    recordHolderNativeHistoryOriginalBatch(rejected, batch(0, false))
    expect(
      finishHolderNativeHistoryOriginalSeries(rejected, qualified()).producerReplayQualification,
    ).toBe(false)
    const incomplete = begin()
    recordHolderNativeHistoryOriginalBatch(incomplete, batch())
    expect(finishHolderNativeHistoryOriginalSeries(incomplete, qualified(0)).reason).toBe(
      'invalid_input',
    )
  })
  it('rejects duplicate batches, a fourth batch and sparse input without overwriting previous files', () => {
    for (const variant of ['duplicate', 'fourth', 'sparse']) {
      const handle = begin(),
        first = recordHolderNativeHistoryOriginalBatch(handle, batch())
      const original = readFileSync(join(first.artifactDirectory!, 'batch-0-original-receipt.json'))
      const input = batch(variant === 'fourth' ? 3 : 0) as any
      if (variant === 'sparse') {
        input.batchIndex = 1
        input.plan.anchors = new Array(2)
      }
      expect(recordHolderNativeHistoryOriginalBatch(handle, input).reason).toBe('invalid_input')
      const final = finishHolderNativeHistoryOriginalSeries(handle, {
        qualification: false,
        reason: 'capture_unavailable',
        batchQualifications: [],
      })
      expect(final.producerReplayQualification).toBe(false)
      expect(readFileSync(join(first.artifactDirectory!, 'batch-0-original-receipt.json'))).toEqual(
        original,
      )
    }
  })
  it('never invokes accessors and rejects cycles while accepting acyclic aliases and isolating mutations', () => {
    const handle = begin(),
      input: any = batch(),
      shared = { value: 'retained' }
    input.plan.sharedA = shared
    input.plan.sharedB = shared
    const status = recordHolderNativeHistoryOriginalBatch(handle, input)
    shared.value = 'changed'
    input.receipt.ledger[0].responseBodyBase64 = 'mutated'
    finishHolderNativeHistoryOriginalSeries(handle, qualified())
    const plan = JSON.parse(
      readFileSync(join(status.artifactDirectory!, 'batch-0-prepared-plan.json'), 'utf8'),
    )
    expect(plan.sharedA.value).toBe('retained')
    expect(plan.sharedB.value).toBe('retained')
    let reads = 0
    const accessor = batch() as any
    Object.defineProperty(accessor, 'receipt', {
      enumerable: true,
      get: () => {
        reads++
        return {}
      },
    })
    expect(recordHolderNativeHistoryOriginalBatch(begin(), accessor).reason).toBe('invalid_input')
    expect(reads).toBe(0)
    const cycle = batch() as any
    cycle.receipt.self = cycle.receipt
    expect(recordHolderNativeHistoryOriginalBatch(begin(), cycle).reason).toBe('invalid_input')
    const beginAccessor = { sharesRaw: S } as any
    Object.defineProperty(beginAccessor, 'kind', {
      enumerable: true,
      get: () => {
        reads++
        return 'fluid_usdc_bridge'
      },
    })
    beginHolderNativeHistoryOriginalSeries(beginAccessor)
    expect(getLastHolderNativeHistoryOriginalRetentionStatus()?.reason).toBe('invalid_input')
    expect(reads).toBe(0)
  })
  it('rejects cloned/serialized handles and extra caller paths/fs/clock hooks', () => {
    const handle = begin()
    expect(
      recordHolderNativeHistoryOriginalBatch(JSON.parse(JSON.stringify(handle)), batch()).reason,
    ).toBe('invalid_input')
    for (const extra of ['root', 'sourcePaths', 'now', 'fetcher']) {
      beginHolderNativeHistoryOriginalSeries({
        kind: 'fluid_usdc_bridge',
        sharesRaw: S,
        [extra]: 'untrusted',
      } as any)
      expect(getLastHolderNativeHistoryOriginalRetentionStatus()?.reason).toBe('invalid_input')
    }
    expect(
      finishHolderNativeHistoryOriginalSeries(
        { ...handle } as HolderNativeHistoryOriginalSeries,
        qualified(),
      ).originalAuthority,
    ).toBe(false)
  })
  it('fails source drift closed for archival qualification while retaining the pre-await snapshot', () => {
    const handle = begin(),
      status = recordHolderNativeHistoryOriginalBatch(handle, batch())
    const source = 'lib/carry/fluidExitCapacity.ts'
    writeFileSync(join(root, source), 'changed after acquisition began')
    const final = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(final.reason).toBe('source_changed')
    expect(final.producerReplayQualification).toBe(false)
    const manifest = JSON.parse(
      readFileSync(join(status.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    const index = manifest.sourceSnapshots.findIndex((s: any) => s.source === source)
    expect(index).toBe(fluidFiles.indexOf(source))
    expect(
      readFileSync(
        join(
          status.artifactDirectory!,
          'source-' + String(index).padStart(2, '0') + '-fluidExitCapacity.ts',
        ),
        'utf8',
      ),
    ).toContain('synthetic source snapshot')
  })
  it.each(['source', 'artifact'])(
    'does not mask later %s drift behind an earlier fsync failure',
    (variant) => {
      const handle = begin()
      const directory = getLastHolderNativeHistoryOriginalRetentionStatus()!.artifactDirectory!
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw Error('synthetic_fsync_failure')
      })
      const failed = recordHolderNativeHistoryOriginalBatch(handle, batch())
      expect(failed.reason).toBe('filesystem_unavailable')
      if (variant === 'source')
        writeFileSync(
          join(root, 'lib/carry/fluidExitCapacity.ts'),
          'changed source after failed receipt retention',
        )
      else writeFileSync(join(directory, 'source-00-carry-depth-quote-provider-policy.json'), '{}')
      const final = finishHolderNativeHistoryOriginalSeries(handle, {
        qualification: false,
        reason: 'capture_unavailable',
        batchQualifications: [],
      })
      expect(final.reason).toBe(variant === 'source' ? 'source_changed' : 'artifact_changed')
      expect(final.producerReplayQualification).toBe(false)
      expect(final.originalAuthority).toBe(false)
    },
  )
  it('detects copied artifact mutation, hard links and changed modes before sealing', () => {
    for (const variant of ['mutation', 'link', 'mode']) {
      const handle = begin(),
        status = recordHolderNativeHistoryOriginalBatch(handle, batch())
      const path = join(status.artifactDirectory!, 'batch-0-original-receipt.json')
      if (variant === 'mutation') writeFileSync(path, '{}')
      if (variant === 'link') linkSync(path, join(root, 'linked-' + variant))
      if (variant === 'mode') chmodSync(path, 0o644)
      const final = finishHolderNativeHistoryOriginalSeries(handle, qualified())
      expect(final.reason).toBe('artifact_changed')
      expect(final.producerReplayQualification).toBe(false)
    }
  })
  it('does not follow a source symlink or an existing output-directory symlink', () => {
    rmSync(join(root, fluidFiles[0]))
    symlinkSync(join(root, fluidFiles[1]), join(root, fluidFiles[0]))
    begin()
    expect(getLastHolderNativeHistoryOriginalRetentionStatus()?.status).toBe('unavailable')
    expect(
      existsSync(join(root, 'data/research/venue-signals/holder-native-history-originals')),
    ).toBe(false)
    rmSync(join(root, fluidFiles[0]))
    writeFileSync(join(root, fluidFiles[0]), 'restored')
    symlinkSync(
      join(root, 'lib'),
      join(root, 'data/research/venue-signals/holder-native-history-originals'),
    )
    begin()
    expect(getLastHolderNativeHistoryOriginalRetentionStatus()?.reason).toBe('not_local_repository')
  })
  it('returns explicit remote/filesystem-disabled status and cannot approve invented archives', () => {
    rmSync(join(root, '.git'), { recursive: true })
    const handle = begin()
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(status.status).toBe('unavailable')
    expect(status.producerReplayQualification).toBe(false)
    expect(status.originalAuthority).toBe(false)
    expect(status.authenticated).toBe(false)
  })
  it('enforces response-derived file cap and the256MiB disk reserve without partial approval', () => {
    const handle = begin(),
      huge = batch() as any
    huge.receipt.large = 'x'.repeat(8 * 1024 * 1024)
    expect(recordHolderNativeHistoryOriginalBatch(handle, huge).reason).toBe('artifact_bound')
    const stats = statfsSync(root)
    vi.mocked(statfsSync).mockReturnValueOnce({ ...stats, bavail: 0 } as ReturnType<
      typeof statfsSync
    >)
    begin()
    expect(getLastHolderNativeHistoryOriginalRetentionStatus()?.reason).toBe('disk_reserve')
  })
  it('seals a partial manifest with the exact sink failure when receipt writing fails after its plan', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const handle = begin()
    vi.mocked(writeFileSync)
      .mockImplementationOnce(actual.writeFileSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('controlled_write_failure'), { code: 'EIO' })
      })
    const pending = recordHolderNativeHistoryOriginalBatch(handle, batch())
    expect(pending.reason).toBe('filesystem_unavailable')
    expect(pending.recordedBatches).toBe(0)
    expect(existsSync(join(pending.artifactDirectory!, 'batch-0-prepared-plan.json'))).toBe(true)
    const status = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(status.reason).toBe('filesystem_unavailable')
    expect(status.producerReplayQualification).toBe(false)
    const manifest = JSON.parse(
      readFileSync(join(status.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    expect(manifest.reason).toBe('filesystem_unavailable')
    expect(manifest.producerReportedQualification).toBe(true)
    expect(manifest.producerReportedBatchQualifications).toEqual([true])
    expect(manifest.producerReplayQualification).toBe(false)
    expect(manifest.incompleteFiles).toContain('batch-0-original-receipt.json')
    expect(manifest.files.some((f: any) => f.file === 'batch-0-prepared-plan.json')).toBe(true)
    expect(manifest.originalAuthority).toBe(false)
  })
  it('charges a fully written file before a failed fsync and includes that reservation in the physical series bound', () => {
    const handle = begin(),
      input = batch() as any
    input.plan.large = 'x'.repeat(7 * 1024 * 1024)
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('controlled_fsync_failure'), { code: 'EIO' })
    })
    const pending = recordHolderNativeHistoryOriginalBatch(handle, input)
    const path = join(pending.artifactDirectory!, 'batch-0-prepared-plan.json')
    const failedFileBytes = lstatSync(path).size
    expect(failedFileBytes).toBeGreaterThan(7 * 1024 * 1024)
    expect(pending.accountedSeriesBytes).toBeGreaterThanOrEqual(failedFileBytes)
    const final = finishHolderNativeHistoryOriginalSeries(handle, qualified())
    expect(final.reason).toBe('filesystem_unavailable')
    const manifest = JSON.parse(
      readFileSync(join(final.artifactDirectory!, 'manifest.json'), 'utf8'),
    )
    expect(manifest.incompleteFileReservations).toContainEqual({
      file: 'batch-0-prepared-plan.json',
      reservedBytes: failedFileBytes,
    })
    expect(manifest.accountedSeriesBytesBeforeManifest).toBeGreaterThanOrEqual(failedFileBytes)
    const physicalBytes = readdirSync(final.artifactDirectory!).reduce(
      (n, name) => n + lstatSync(join(final.artifactDirectory!, name)).size,
      0,
    )
    expect(final.accountedSeriesBytes).toBeGreaterThanOrEqual(physicalBytes)
    expect(final.accountedSeriesBytes).toBeLessThanOrEqual(32 * 1024 * 1024)
    expect(final.producerReplayQualification).toBe(false)
  })
})
