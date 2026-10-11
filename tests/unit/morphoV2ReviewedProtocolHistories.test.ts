import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256, stringToHex } from 'viem'
import {
  MORPHO_V2_USDT_REVIEWED_PROTOCOL_HISTORY_PIN as PIN,
  approveReviewedMorphoV2ProtocolHistory,
  reviewedMorphoV2ProtocolHistory,
  type ReviewedMorphoV2ProtocolHistory,
} from '@/lib/carry/morphoV2ReviewedProtocolHistories'
import {
  approveMorphoV2PinnedProtocolHistory,
  morphoV2PinnedProtocolHistory,
} from '@/lib/carry/morphoV2ProtocolCapacityHistoryPins'
import {
  resolveMorphoV2TrustedProfile,
  type MorphoV2TrustedProfile,
} from '@/lib/carry/morphoV2TrustedProfiles'

const nodeSha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const browserSha = (text: string) => sha256(stringToHex(text)).slice(2)
const read = (path: string) => readFileSync(resolve(path), 'utf8')
const usdc = resolveMorphoV2TrustedProfile(
  'USDC → VaultV2 [USDC]',
  '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
)!
const usdt = resolveMorphoV2TrustedProfile(
  'USDT → VaultV2 [USDT]',
  '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
  '0xdac17f958d2ee523a2206206994597c13d831ec7',
)!
function history() {
  const value = reviewedMorphoV2ProtocolHistory(usdt)
  if (!value?.nativeQualification) throw new Error('reviewed USDT history missing')
  return value as ReviewedMorphoV2ProtocolHistory & {
    nativeQualification: NonNullable<ReviewedMorphoV2ProtocolHistory['nativeQualification']>
  }
}

describe('app-owned reviewed protocol histories', () => {
  it('keeps USDC exactly on its original getter and fixed full-frame approval', () => {
    expect(reviewedMorphoV2ProtocolHistory(usdc)).toEqual(morphoV2PinnedProtocolHistory())
    for (const digest of [nodeSha, browserSha, () => '0'.repeat(64)]) {
      const candidate = morphoV2PinnedProtocolHistory()
      expect(approveReviewedMorphoV2ProtocolHistory(usdc, candidate, digest)).toBe(
        approveMorphoV2PinnedProtocolHistory(candidate, digest),
      )
    }
    expect(reviewedMorphoV2ProtocolHistory(usdc)?.nativeQualification).toBeUndefined()
  })

  it('requires the private selected profile instance, never a payload profile or clone', () => {
    for (const candidate of [
      structuredClone(usdt),
      { ...usdt },
      { ...usdt, subject: usdc.subject },
      { ...usdt, id: usdc.id },
      null,
      undefined,
    ]) {
      const profile = candidate as MorphoV2TrustedProfile
      expect(reviewedMorphoV2ProtocolHistory(profile)).toBeNull()
      expect(approveReviewedMorphoV2ProtocolHistory(profile, history(), nodeSha)).toBe(false)
    }
    expect(approveReviewedMorphoV2ProtocolHistory(usdc, history(), nodeSha)).toBe(false)
    expect(
      approveReviewedMorphoV2ProtocolHistory(usdt, morphoV2PinnedProtocolHistory(), nodeSha),
    ).toBe(false)
  })

  it('requires the external literal digest and complete frame equality', () => {
    const frame = history()
    const text = read(PIN.framePath)
    expect(text).toBe(JSON.stringify(frame))
    expect(nodeSha(text)).toBe(PIN.frameSha256)
    expect(browserSha(text)).toBe(PIN.frameSha256)
    expect(approveReviewedMorphoV2ProtocolHistory(usdt, frame, nodeSha)).toBe(true)
    expect(approveReviewedMorphoV2ProtocolHistory(usdt, frame, browserSha)).toBe(true)
    expect(approveReviewedMorphoV2ProtocolHistory(usdt, frame, () => '0'.repeat(64))).toBe(false)
    expect(
      approveReviewedMorphoV2ProtocolHistory(usdt, frame, () => {
        throw new Error('hash unavailable')
      }),
    ).toBe(false)
    frame.history.points[0].prongs.blueCashRaw = '0'
    expect(approveReviewedMorphoV2ProtocolHistory(usdt, frame, () => PIN.frameSha256)).toBe(false)
    expect(approveReviewedMorphoV2ProtocolHistory(usdt, history(), nodeSha)).toBe(true)
  })

  const mutations: [string, (frame: ReturnType<typeof history>) => void][] = [
    ['route', (f) => (f.subject.routeKey = usdc.subject.routeKey)],
    ['destination', (f) => (f.subject.destination = usdc.subject.destination)],
    ['asset', (f) => (f.subject.asset = usdc.subject.asset)],
    ['asset units', (f) => (f.subject.assetDecimals = 18)],
    ['share units', (f) => (f.subject.shareDecimals = 6)],
    ['adapter', (f) => (f.configured.adapter = usdc.configured.adapter)],
    ['market id', (f) => (f.configured.marketId = usdc.configured.marketId)],
    ['liquidity data', (f) => (f.configured.liquidityData = usdc.configured.liquidityData)],
    ['allocation ids', (f) => f.configured.allocationIds.reverse()],
    ['runtime code', (f) => (f.runtimeIdentities[0].codeHash = usdc.runtimeIdentities[0].codeHash)],
    ['runtime proxy', (f) => (f.runtimeIdentities[0].proxyInspection = 'source_equivalent')],
    ['omitted runtime', (f) => f.runtimeIdentities.pop()],
    ['idle cash', (f) => (f.history.points[0].prongs.idleCashRaw = '1')],
    ['Blue cash', (f) => (f.history.points[0].prongs.blueCashRaw = '0')],
    ['internal shares', (f) => (f.history.points[0].prongs.internalSharesRaw = '0')],
    ['actual shares', (f) => (f.history.points[0].prongs.actualSharesRaw = '0')],
    ['allowance', (f) => (f.history.points[0].prongs.allowanceRaw = '0')],
    ['rate', (f) => (f.history.points[0].prongs.borrowRateRaw = '0')],
    ['market stock', (f) => (f.history.points[0].prongs.market[0] = '0')],
    ['market fee', (f) => (f.history.points[0].prongs.market[5] = '1')],
    ['allocation stock', (f) => (f.history.points[0].prongs.allocationsRaw[0] = '0')],
    ['fee recipient', (f) => (f.history.points[0].prongs.feeRecipient = usdt.subject.destination)],
    ['source hash', (f) => (f.history.points[0].source.blockHash = `0x${'0'.repeat(64)}`)],
    ['source block', (f) => (f.history.points[0].source.blockNumber = '25828484')],
    ['source time', (f) => (f.history.points[0].source.blockTime = '2026-08-24T23:59:58.000Z')],
    ['source clock', (f) => (f.knowledgeCutoff = '2026-08-30T23:59:59.000Z')],
    ['donor duration', (f) => (f.history.elapsedSeconds[0] = 86399)],
    ['point ordering', (f) => f.history.points.reverse()],
    ['missing point', (f) => f.history.points.pop()],
    ['aggregate identity', (f) => (f.captureReceiptSha256 = '0'.repeat(64))],
    ['source equivalence', (f) => Object.assign(f, { sourceImplementationEquivalence: true })],
    ['full Ea', (f) => (f.nativeQualification.points[0].fixedShareEntitlement.assetsRaw = '1')],
    ['arbitrary S', (f) => (f.nativeQualification.points[0].fixedShareEntitlement.sharesRaw = '1')],
    [
      'native Ea row',
      (f) => (f.nativeQualification.points[0].origins[0].fixedOriginalSourceEa.value = '1'),
    ],
    ['past ownership', (f) => (f.nativeQualification.olderPastOwnerProven = true)],
    ['gross flow claim', (f) => (f.nativeQualification.donorSemantics = 'gross_competing_flow')],
    ['invented M', (f) => Object.assign(f.nativeQualification, { queuedCompetingMRaw: '1' })],
    ['native auth', (f) => (f.nativeQualification.authenticated = true)],
    ['execution claim', (f) => (f.nativeQualification.executionValidated = true)],
    ['calibration claim', (f) => (f.nativeQualification.calibratedProbability = true)],
    ['live claim', (f) => (f.nativeQualification.liveAttached = true)],
    [
      'header hash',
      (f) => (f.nativeQualification.points[0].origins[0].headerBeforeSha256 = '0'.repeat(64)),
    ],
    [
      'capture clock',
      (f) => (f.nativeQualification.points[0].origins[0].completedAtUtc = f.knowledgeCutoff),
    ],
    ['extra approval flag', (f) => Object.assign(f, { approved: true })],
    ['stripped qualification', (f) => Reflect.deleteProperty(f, 'nativeQualification')],
  ]
  it.each(mutations)('rejects altered %s even with a copied fixed digest', (_, mutate) => {
    const candidate = history()
    mutate(candidate)
    expect(approveReviewedMorphoV2ProtocolHistory(usdt, candidate, nodeSha)).toBe(false)
    expect(approveReviewedMorphoV2ProtocolHistory(usdt, candidate, () => PIN.frameSha256)).toBe(
      false,
    )
  })

  const sparseArrays: [string, (frame: ReturnType<typeof history>) => unknown[]][] = [
    ['protocol points', (f) => f.history.points],
    ['qualification points', (f) => f.nativeQualification.points],
    ['native origins', (f) => f.nativeQualification.points[0].origins],
    ['market stocks', (f) => f.history.points[0].prongs.market],
    ['allocation stocks', (f) => f.history.points[0].prongs.allocationsRaw],
    ['donor timing', (f) => f.history.elapsedSeconds],
  ]
  it.each(sparseArrays)('rejects same-length sparse %s', (_, select) => {
    const candidate = history()
    const values = select(candidate),
      before = values.length
    expect(Reflect.deleteProperty(values, '0')).toBe(true)
    expect(values).toHaveLength(before)
    expect(approveReviewedMorphoV2ProtocolHistory(usdt, candidate, nodeSha)).toBe(false)
  })

  it('rejects sparse USDC arrays and extra enumerable array properties', () => {
    for (const field of ['points', 'elapsedSeconds'] as const) {
      const candidate = morphoV2PinnedProtocolHistory()
      Reflect.deleteProperty(candidate.history[field], '0')
      expect(approveReviewedMorphoV2ProtocolHistory(usdc, candidate, nodeSha)).toBe(false)
    }
    const candidate = history()
    Object.assign(candidate.history.points, { forged: true })
    expect(approveReviewedMorphoV2ProtocolHistory(usdt, candidate, nodeSha)).toBe(false)
  })

  it('retains exactly seven sorted August anchors and six daily NET donors, excluding holdout', () => {
    const frame = history()
    const points = frame.history.points
    expect(points.map((p) => p.source.blockTime)).toEqual(
      [24, 25, 26, 27, 28, 29, 30].map((day) => `2026-08-${day}T23:59:59.000Z`),
    )
    expect(frame.history.elapsedSeconds).toEqual(Array(6).fill(86400))
    expect(
      points.every(
        (p, i) => !i || BigInt(p.source.blockNumber) > BigInt(points[i - 1].source.blockNumber),
      ),
    ).toBe(true)
    expect(frame.nativeQualification.dailyNetDonorCount).toBe(6)
    expect(frame.nativeQualification.donorSemantics).toBe(
      'daily_NET_protocol_stock_differences_not_gross_competing_flow',
    )
    const replay = JSON.parse(read(PIN.combinedReplay.path))
    expect(replay.frames).toHaveLength(9)
    expect(frame.nativeQualification.points.map((p) => p.source)).toEqual(
      replay.frames.slice(0, 7).map((p: { source: unknown }) => p.source),
    )
    for (const holdout of replay.frames.slice(7)) {
      const candidate = history()
      candidate.history.points.push({ ...candidate.history.points[0], source: holdout.source })
      expect(approveReviewedMorphoV2ProtocolHistory(usdt, candidate, nodeSha)).toBe(false)
    }
  })

  it('matches byte-pinned original native files, quotes, prongs, headers and capture clocks', () => {
    const frame = history()
    const qualification = frame.nativeQualification
    for (const reference of qualification.provenance.references) {
      expect(nodeSha(read(reference.path))).toBe(reference.sha256)
    }
    expect(qualification.provenance.references).toEqual([
      PIN.index,
      { path: PIN.combinedReplay.path, sha256: PIN.combinedReplay.sha256 },
      PIN.parentArchiveVerification,
    ])
    const replay = JSON.parse(read(PIN.combinedReplay.path))
    expect(replay.bodySha256).toBe(PIN.combinedReplay.bodySha256)
    expect(frame.captureReceiptSha256).toBe(replay.bodySha256)
    expect(qualification.captureReceiptSemantics).toBe(PIN.captureReceiptSemantics)
    expect(frame.subject).toEqual(usdt.subject)
    expect(frame.configured).toEqual(usdt.configured)
    expect(frame.runtimeIdentities).toEqual(usdt.runtimeIdentities)
    expect(qualification.provenance.captureReceipts).toHaveLength(4)
    for (const receipt of qualification.provenance.captureReceipts) {
      const text = read(receipt.path)
      expect(nodeSha(text)).toBe(receipt.sha256)
      const capture = JSON.parse(text)
      expect(capture.bodySha256).toBe(receipt.bodySha256)
      expect(capture.startedAtUtc).toBe(receipt.startedAtUtc)
      expect(capture.completedAtUtc).toBe(receipt.completedAtUtc)
      const { bodySha256, ...body } = capture
      expect(nodeSha(JSON.stringify(body))).toBe(bodySha256)
    }
    expect(frame.knowledgeCutoff).toBe(
      qualification.provenance.captureReceipts
        .map((r) => r.completedAtUtc)
        .sort()
        .at(-1),
    )
    qualification.points.forEach((point, index) => {
      const replayPoint = replay.frames[index]
      expect(point.source).toEqual(replayPoint.source)
      expect(point.regime).toEqual(replayPoint.regime)
      expect(point.fixedShareEntitlement).toEqual(replayPoint.fixedShareEntitlement)
      expect(point.fixedShareEntitlement.sharesRaw).toBe(PIN.fixedSharesRaw)
      expect(point.origins).toHaveLength(2)
      for (const origin of point.origins) {
        const capture = JSON.parse(read(origin.captureReceiptPath))
        const native = capture.observations.frames.find(
          (f: { origin: string; anchor: { blockNumber: number } }) =>
            f.origin === origin.origin && String(f.anchor.blockNumber) === point.source.blockNumber,
        )
        const rows = Object.fromEntries(native.rows.map((row: { key: string }) => [row.key, row]))
        expect(origin.headerBeforeSha256).toBe(rows.header_before.value)
        expect(origin.headerAfterSha256).toBe(rows.header_after.value)
        expect(origin.fixedOriginalSourceEa).toEqual(rows.fixedOriginalSourceEa)
        const anchorIndex = capture.plan.anchors.findIndex(
          (anchor: { blockNumber: number }) =>
            String(anchor.blockNumber) === point.source.blockNumber,
        )
        const originIndex = capture.plan.providerHosts.indexOf(origin.origin)
        const start = 1 + originIndex * (1 + capture.plan.anchors.length * 32) + anchorIndex * 32
        expect(origin.startedAtUtc).toBe(capture.traces[start].startedAtUtc)
        expect(origin.completedAtUtc).toBe(capture.traces[start + 31].completedAtUtc)
        const values = native.assessment.values
        expect(frame.history.points[index].prongs).toEqual({
          ...replayPoint.prongs,
          feeRecipient: values.feeRecipient,
        })
        expect(frame.history.points[index].prongs).toEqual({
          idleCashRaw: values.idleCash,
          blueCashRaw: values.blueCash,
          market: values.market,
          internalSharesRaw: values.adapterSupplyShares,
          actualSharesRaw: values.position[0],
          allowanceRaw: values.adapterAllowance,
          allocationsRaw: [values.allocation0, values.allocation1, values.allocation2],
          borrowRateRaw: values.borrowRate,
          feeRecipient: values.feeRecipient,
        })
        expect(values.fixedOriginalSourceEa).toBe(point.fixedShareEntitlement.assetsRaw)
      }
    })
    expect(qualification.historyProngCount).toBe(32)
    expect(qualification.currentProtocolProngCount).toBe(31)
    expect(qualification.semantics).toBe(PIN.semantics)
    expect(qualification.olderPastOwnerProven).toBe(false)
    expect(qualification.arbitraryShareScalingApproved).toBe(false)
    expect(qualification.currentHolderEntitlementApproved).toBe(false)
    expect(qualification.queuedCompetingMRaw).toBeNull()
    expect(qualification.authenticated).toBe(false)
    expect(qualification.executionValidated).toBe(false)
    expect(qualification.sourceImplementationEquivalence).toBe(false)
    expect(qualification.forecastValidated).toBe(false)
    expect(qualification.calibratedProbability).toBe(false)
    expect(qualification.liveAttached).toBe(false)
  })
})
