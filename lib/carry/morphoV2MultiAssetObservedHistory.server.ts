/** Server-only immutable native archive verification. Import only during explicit
 * finite prewarm; this module has no RPC, startup work, cache, jobs or holder Ea. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  approveReviewedMorphoV2ProtocolHistory,
  reviewedMorphoV2ProtocolHistory,
  type ReviewedMorphoV2ProtocolHistory,
} from './morphoV2ReviewedProtocolHistories'
import {
  isAppOwnedMorphoV2TrustedProfile,
  type MorphoV2TrustedProfile,
} from './morphoV2TrustedProfiles'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 24 * 1024 * 1024
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const PARENT_AUDIT = Object.freeze({
  path: 'data/research/venue-signals/morpho-five-asset-native-audit-2026-10-09-4df3c249-5acb-4360-b979-7f18521a6c3b/parent-data-audit.json',
  sha256: 'a745fb2bb0213433267c0ab695e4e734826b3377f61cd922fdc7832068969482',
})
const PARENT_CLOCKS = Object.freeze({
  path: 'data/research/venue-signals/morpho-three-asset-post-retention-clocks-2026-10-09-cbf7eceb-6c76-4ae5-80ca-923081e94e4c/manifest.json',
  sha256: 'f5585442befa8a8150584071c7c315070f08f2ba72cf449299668b324435b5bd',
})
export const MORPHO_V2_MULTI_ASSET_OBSERVED_HISTORY_PINS: Readonly<
  Record<
    string,
    {
      candidate: string
      directory: string
      terminalSha256: string
      parentClockPath: string
    }
  >
> = freeze({
  morpho_v2_ausd_observed_protocol_history: {
    candidate: '08',
    directory:
      'data/research/venue-signals/morpho-multi-asset-native-history-2026-10-09T09-36-22.676Z-f8517bef-7e86-4355-babd-8c021ea1a7cc',
    terminalSha256: '621788775937cc70d47553c5b53423da3b00576c2d439c813ab06344e246df33',
    parentClockPath:
      'data/research/venue-signals/morpho-three-asset-post-retention-clocks-2026-10-09-cbf7eceb-6c76-4ae5-80ca-923081e94e4c/ausd-parent-capture-proof.json',
  },
  morpho_v2_eurcv_observed_protocol_history: {
    candidate: '32',
    directory:
      'data/research/venue-signals/morpho-multi-asset-native-history-2026-10-09T09-38-00.486Z-ee04b265-c871-4ccb-8a65-0bf41213ffe3',
    terminalSha256: 'cb3f0cc5f7a822688308e98611b390a96bfd03d12e86853710a868e0e6b3d849',
    parentClockPath:
      'data/research/venue-signals/morpho-three-asset-post-retention-clocks-2026-10-09-cbf7eceb-6c76-4ae5-80ca-923081e94e4c/eurcv-parent-capture-proof.json',
  },
  morpho_v2_link_observed_protocol_history: {
    candidate: '14',
    directory:
      'data/research/venue-signals/morpho-multi-asset-native-history-2026-10-09T09-39-38.016Z-82cf6157-b3ca-41ad-bda0-9f361dd17339',
    terminalSha256: '69c685278d3d4b2eff6b34f75b7b1d04f33fef908dca510037a71e264679b766',
    parentClockPath:
      'data/research/venue-signals/morpho-three-asset-post-retention-clocks-2026-10-09-cbf7eceb-6c76-4ae5-80ca-923081e94e4c/link-parent-capture-proof.json',
  },
})
export const MORPHO_V2_MULTI_ASSET_OBSERVED_PARENT_PINS = Object.freeze({
  audit: PARENT_AUDIT,
  clocks: PARENT_CLOCKS,
})
export type MorphoV2MultiAssetObservedArchiveTexts = {
  terminalText: string
  inputPlanText: string
  parentAuditText: string
  parentClockManifestText: string
  parentClockProofText: string
  points: { factsText: string; originalsText: string }[]
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function check(condition: unknown): asserts condition {
  if (!condition) throw Error('morpho_observed_history_invalid')
}
function parse(text: string, sha256?: string): any {
  check(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_FILE_BYTES)
  if (sha256 !== undefined) check(digest(text) === sha256)
  const value = JSON.parse(text)
  check(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value
}
function sealed(text: string, sha256?: string): any {
  const value = parse(text, sha256)
  const { sha256: bodySha256, ...body } = value
  check(typeof bodySha256 === 'string' && digest(JSON.stringify(body)) === bodySha256)
  return value
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}
const authorityFlags = [
  'profileApproval',
  'authenticated',
  'originalIssuanceAuthority',
  'sourceImplementationEquivalence',
  'forecastAuthority',
  'executionAuthority',
  'historicalOwnership',
  'calibratedProbability',
  'coveragePromotion',
] as const
function researchOnly(value: any) {
  check(value.researchOnly === true && value.MRaw === null)
  for (const key of authorityFlags) check(value[key] === false)
}
export function isMorphoV2MultiAssetObservedProfile(
  profile: unknown,
): profile is MorphoV2TrustedProfile {
  return (
    isAppOwnedMorphoV2TrustedProfile(profile) &&
    Object.hasOwn(MORPHO_V2_MULTI_ASSET_OBSERVED_HISTORY_PINS, profile.id)
  )
}

/** Validate descriptors before any property read can execute caller code. */
function snapshotArchiveTexts(value: unknown): MorphoV2MultiAssetObservedArchiveTexts {
  const fields = [
    'terminalText',
    'inputPlanText',
    'parentAuditText',
    'parentClockManifestText',
    'parentClockProofText',
    'points',
  ]
  const plain = (candidate: unknown, keys: string[]) => {
    check(candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate))
    check(
      Object.getPrototypeOf(candidate) === Object.prototype ||
        Object.getPrototypeOf(candidate) === null,
    )
    const own = Reflect.ownKeys(candidate)
    check(
      own.length === keys.length &&
        own.every((key) => typeof key === 'string' && keys.includes(key)),
    )
    const descriptors = Object.getOwnPropertyDescriptors(candidate)
    for (const key of keys)
      check(
        descriptors[key] && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable,
      )
    return descriptors
  }
  const descriptors = plain(value, fields)
  const points = descriptors.points.value
  check(
    Array.isArray(points) &&
      Object.getPrototypeOf(points) === Array.prototype &&
      points.length === 3,
  )
  check(
    Reflect.ownKeys(points).length === 4 &&
      ['0', '1', '2'].every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(points, key)
        return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable
      }),
  )
  let bytes = 0
  const string = (candidate: unknown) => {
    check(typeof candidate === 'string')
    const length = Buffer.byteLength(candidate, 'utf8')
    check(length <= MAX_FILE_BYTES && bytes + length <= MAX_TOTAL_BYTES)
    bytes += length
    return candidate
  }
  return freeze({
    terminalText: string(descriptors.terminalText.value),
    inputPlanText: string(descriptors.inputPlanText.value),
    parentAuditText: string(descriptors.parentAuditText.value),
    parentClockManifestText: string(descriptors.parentClockManifestText.value),
    parentClockProofText: string(descriptors.parentClockProofText.value),
    points: points.map((point) => {
      const row = plain(point, ['factsText', 'originalsText'])
      return {
        factsText: string(row.factsText.value),
        originalsText: string(row.originalsText.value),
      }
    }),
  })
}

/** Exact externally audited bytes plus parent-observed post-retention clocks.
 * This returns the compiled protocol frame only after deriving it independently
 * from the immutable facts. Fixed-S research redemption values never enter it. */
export function replayMorphoV2MultiAssetObservedProtocolHistory(
  profile: MorphoV2TrustedProfile,
  suppliedTexts: MorphoV2MultiAssetObservedArchiveTexts,
): ReviewedMorphoV2ProtocolHistory | null {
  try {
    check(isMorphoV2MultiAssetObservedProfile(profile))
    const texts = snapshotArchiveTexts(suppliedTexts)
    const pin = MORPHO_V2_MULTI_ASSET_OBSERVED_HISTORY_PINS[profile.id]
    const terminal = sealed(texts.terminalText, pin.terminalSha256)
    researchOnly(terminal)
    check(terminal.schema === 'morpho_multi_asset_native_history_terminal_v1')
    check(terminal.captureStatus === 'native_points_retained' && terminal.failure === null)
    check(terminal.candidate === pin.candidate && terminal.pointCount === 3)
    check(
      terminal.subject.vault === profile.subject.destination &&
        terminal.subject.asset === profile.subject.asset,
    )
    check(
      terminal.currentOwnerSharesRaw === '0' && terminal.fullSharesRaw === '1000000000000000000',
    )
    check(
      terminal.hypotheticalSharesRaw === terminal.fullSharesRaw &&
        terminal.shareBasis === 'explicit_hypothetical_research_S',
    )
    check(terminal.postTerminalRetentionQualified === false)
    const audit = parse(texts.parentAuditText, PARENT_AUDIT.sha256)
    check(audit.parentAudit === 'passed' && audit.scope === 'retained_native_research_data_only')
    check(
      audit.forecastCoveragePromotion === false &&
        audit.authenticated === false &&
        audit.calibrated === false &&
        audit.MRaw === null,
    )
    const cohorts = audit.cohorts.filter((row: any) => row.candidate === pin.candidate)
    check(cohorts.length === 1)
    const cohort = cohorts[0]
    check(
      cohort.terminalSha256 === pin.terminalSha256 &&
        cohort.points === 3 &&
        cohort.failure === null,
    )
    check(cohort.directory.endsWith('/' + pin.directory))
    check(
      cohort.currentOwnerSharesRaw === '0' &&
        cohort.fullSharesRaw === terminal.fullSharesRaw &&
        cohort.shareBasis === terminal.shareBasis,
    )
    const clocks = parse(texts.parentClockManifestText, PARENT_CLOCKS.sha256)
    check(clocks.scope === 'parent_observed_after_terminal_retention_research_clocks_only')
    check(
      clocks.sourceClockIsHistoricalAvailability === false &&
        clocks.authenticatesHistoricalOwnership === false,
    )
    check(
      clocks.sourceImplementationEquivalence === false &&
        clocks.calibrated === false &&
        clocks.forecastCoveragePromotion === false,
    )
    const clockRows = clocks.records.filter((row: any) => row.path === pin.parentClockPath)
    check(clockRows.length === 1)
    const clock = clockRows[0]
    check(
      clock.capturedDirectory === cohort.directory &&
        clock.bytes === Buffer.byteLength(texts.parentClockProofText, 'utf8'),
    )
    const proof = parse(texts.parentClockProofText, clock.sha256)
    check(proof.exitCode === 0 && proof.stopReason === null && same(proof.pinDrift, []))
    const retained = proof.result
    researchOnly(retained)
    check(
      retained.directory === cohort.directory &&
        retained.status === 'research_capture_complete' &&
        retained.failure === null,
    )
    check(
      retained.postRetentionWithinDeadline === true &&
        retained.availableAtUtc === clock.availableAtUtc &&
        retained.pointCount === 3,
    )
    check(retained.physicalStarts === terminal.physicalStarts)
    check(
      Date.parse(retained.availableAtUtc) >
        Date.parse(terminal.qualificationClockBeforeTerminalFsync),
    )
    const inventory = (name: string) => {
      const rows = terminal.files.filter((row: any) => row.file === name)
      check(rows.length === 1)
      return rows[0]
    }
    const readPinned = (name: string, text: string, bodySeal = true) => {
      const row = inventory(name)
      check(Buffer.byteLength(text, 'utf8') === row.bytes)
      return bodySeal ? sealed(text, row.fileSha256) : parse(text, row.fileSha256)
    }
    const plan = readPinned('input-plan.json', texts.inputPlanText, false)
    check(
      plan.sourcePins.length === 20 &&
        plan.allAuthorityFlagsFalse === true &&
        plan.historicalOwnership === false &&
        plan.MRaw === null,
    )
    check(texts.points.length === 3 && Object.keys(texts.points).length === 3)
    const facts = texts.points.map((point, index) => {
      const f = readPinned(`point_${index}-facts.json`, point.factsText)
      const original = readPinned(`point_${index}-originals.json`, point.originalsText)
      researchOnly(f)
      researchOnly(original)
      check(
        original.schema === 'morpho_multi_asset_control_originals_v1' &&
          original.receipt.failure === null &&
          original.receipt.pendingSettlements === 0,
      )
      check(Date.parse(f.availableAtUtc) >= Date.parse(original.receipt.availableAtUtc))
      check(
        Date.parse(f.acquiredAtUtc) <= Date.parse(f.availableAtUtc) &&
          Date.parse(f.availableAtUtc) < Date.parse(retained.availableAtUtc),
      )
      check(
        f.fixedSharesRaw === terminal.fullSharesRaw &&
          f.shareBasis === terminal.shareBasis &&
          f.observedRuntimeMatches === true,
      )
      check(
        index === 0
          ? f.currentOwnerSharesRaw === '0'
          : f.owner === null && f.currentOwnerSharesRaw === null,
      )
      check(
        f.assetDecimals === profile.subject.assetDecimals &&
          f.shareDecimals === profile.subject.shareDecimals,
      )
      const n = f.nativeFacts
      check(
        n.vault_asset.toLowerCase() === profile.subject.asset &&
          n.adapter_asset.toLowerCase() === profile.subject.asset,
      )
      check(n.parentVault.toLowerCase() === profile.subject.destination && n.isAdapter === true)
      check(
        same(
          {
            adapter: n.liquidityAdapter.toLowerCase(),
            morpho: n.morpho.toLowerCase(),
            irm: n.adaptiveCurveIrm.toLowerCase(),
            marketId: f.marketId,
            liquidityData: n.liquidityData,
            allocationIds: f.allocationIds,
          },
          profile.configured,
        ),
      )
      for (const identity of profile.runtimeIdentities)
        check(f.runtimes['code_' + identity.key] === identity.codeHash)
      return f
    })
    const selected = reviewedMorphoV2ProtocolHistory(profile)
    check(selected !== null && !selected.nativeQualification && selected.protocolOnlyQualification)
    const projected: ReviewedMorphoV2ProtocolHistory = {
      subject: structuredClone(profile.subject),
      configured: structuredClone(
        profile.configured,
      ) as ReviewedMorphoV2ProtocolHistory['configured'],
      runtimeIdentities: structuredClone(
        profile.runtimeIdentities,
      ) as ReviewedMorphoV2ProtocolHistory['runtimeIdentities'],
      sourceImplementationEquivalence: false,
      captureReceiptSha256: terminal.sha256,
      knowledgeCutoff: retained.availableAtUtc,
      history: {
        points: facts.slice(1).map((f) => {
          const n = f.nativeFacts
          return {
            source: structuredClone(f.source),
            status: 'two_origin_conditional_configured_adapter_prongs',
            prongs: {
              idleCashRaw: n.idle,
              blueCashRaw: n.blueCash,
              market: [...n.market],
              internalSharesRaw: n.internalSupplyShares,
              actualSharesRaw: n.position[0],
              allowanceRaw: n.adapterAllowance,
              allocationsRaw: [0, 1, 2].map((i) => n['allocation' + i]),
              borrowRateRaw: n.borrowRate,
              feeRecipient: n.feeRecipient.toLowerCase(),
            },
          }
        }),
        elapsedSeconds: [
          (Date.parse(facts[2].source.blockTime) - Date.parse(facts[1].source.blockTime)) / 1000,
        ],
      },
      protocolOnlyQualification: {
        semantics: 'protocol_prongs_only_research_S_is_not_holder_entitlement',
        researchSharesRaw: terminal.fullSharesRaw,
        capturedCurrentOwnerSharesRaw: '0',
        historicalOwner: null,
        historicalPastOwnershipProven: false,
        arbitraryShareScalingApproved: false,
        currentHolderEntitlementApproved: false,
        MRaw: null,
        authenticated: false,
        executionValidated: false,
        calibratedProbability: false,
        forecastValidated: false,
        coveragePromotion: false,
        knowledgeCutoffSemantics: 'parent_observed_post_terminal_retention',
        originalTerminalPostRetentionQualified: false,
        parentObservedPostRetentionWithinDeadline: true,
      },
    }
    check(approveReviewedMorphoV2ProtocolHistory(profile, projected, digest))
    check(same(projected, selected))
    return projected
  } catch {
    return null
  }
}

/** Fixed paths only, with no-follow private regular-file checks and byte limits.
 * Do not call from request-time cold reads; explicitly prewarm and then reuse the
 * existing settled-history cache. A missing archive fails closed. */
export async function loadMorphoV2MultiAssetObservedProtocolHistory(
  profile: MorphoV2TrustedProfile,
): Promise<ReviewedMorphoV2ProtocolHistory | null> {
  try {
    check(isMorphoV2MultiAssetObservedProfile(profile))
    const pin = MORPHO_V2_MULTI_ASSET_OBSERVED_HISTORY_PINS[profile.id]
    let total = 0
    const read = async (relative: string) => {
      const path = resolve(process.cwd(), relative)
      check((await realpath(path)) === path)
      const directory = await lstat(dirname(path))
      check(
        directory.isDirectory() &&
          !directory.isSymbolicLink() &&
          (directory.mode & 0o777) === 0o700,
      )
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await file.stat()
        check(
          before.isFile() &&
            before.nlink === 1 &&
            (before.mode & 0o777) === 0o600 &&
            before.size <= MAX_FILE_BYTES &&
            before.size >= 0,
        )
        check(total + before.size <= MAX_TOTAL_BYTES)
        // Read at most the admitted size plus one sentinel byte, even if the file grows.
        const buffer = Buffer.alloc(before.size + 1)
        let length = 0
        while (length < buffer.length) {
          const result = await file.read(buffer, length, buffer.length - length, length)
          if (result.bytesRead === 0) break
          length += result.bytesRead
        }
        const after = await file.stat()
        const named = await lstat(path)
        const sameFile = (candidate: typeof before) =>
          candidate.isFile() &&
          candidate.nlink === 1 &&
          candidate.dev === before.dev &&
          candidate.ino === before.ino &&
          candidate.size === before.size &&
          candidate.mtimeMs === before.mtimeMs &&
          candidate.ctimeMs === before.ctimeMs &&
          candidate.mode === before.mode
        check(
          length === before.size && sameFile(after) && sameFile(named) && !named.isSymbolicLink(),
        )
        check((await realpath(path)) === path)
        total += length
        return buffer.subarray(0, length).toString('utf8')
      } finally {
        await file.close()
      }
    }
    const terminalText = await read(pin.directory + '/terminal.json')
    // Verify the external terminal pin before its inventory can influence reads.
    sealed(terminalText, pin.terminalSha256)
    const inputPlanText = await read(pin.directory + '/input-plan.json')
    const parentAuditText = await read(PARENT_AUDIT.path)
    const parentClockManifestText = await read(PARENT_CLOCKS.path)
    const parentClockProofText = await read(pin.parentClockPath)
    const points = []
    for (let index = 0; index < 3; index++)
      points.push({
        factsText: await read(pin.directory + `/point_${index}-facts.json`),
        originalsText: await read(pin.directory + `/point_${index}-originals.json`),
      })
    return replayMorphoV2MultiAssetObservedProtocolHistory(profile, {
      terminalText,
      inputPlanText,
      parentAuditText,
      parentClockManifestText,
      parentClockProofText,
      points,
    })
  } catch {
    return null
  }
}
