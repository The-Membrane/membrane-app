// Offline, versioned extraction. The existing browser trust table is deliberately unchanged.
import { createHash } from 'node:crypto'
import {
  openSync,
  closeSync,
  fstatSync,
  readdirSync,
  lstatSync,
  statfsSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boundedReceiptBudget, readBoundedReceiptFile } from '../lib/boundedLocalReceiptFile.mjs'
import { buildSubjectManifest } from '../record-carry-cash-issues.mjs'
import {
  verifyLocalCarryCash,
  localCarryCashObservationsFromVerified,
} from '../lib/localCarryCashStore.mjs'
import {
  buildSupplementalAaveUsdeCashManifest,
  verifyLocalSupplementalAaveUsdeCash,
  localSupplementalAaveUsdeCashObservationsFromVerified,
} from '../lib/localSupplementalAaveUsdeCashStore.mjs'
import * as timelineModule from '../../lib/carry/localHistoricalSampledCashTimeline.ts'
import * as projectionModule from '../../lib/carry/conditionalSampledCashPathProjection.ts'
import * as registryModule from '../../lib/carry/holderExitSubjectRegistry.ts'
const pick = (module, key) => module[key] ?? module.default?.[key]
const timeline = pick(timelineModule, 'localHistoricalSampledCashTimeline')
const historyFrom = pick(projectionModule, 'conditionalSampledCashHistoryFromVerifiedTimeline')
const nativeIdentity = pick(projectionModule, 'registeredConditionalSampledCashIdentity')
const resolveSubject = pick(registryModule, 'resolveHolderExitSubject')
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const hash = (s) => createHash('sha256').update(s).digest('hex')
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
export const PROFILE = deepFreeze({
  cohort: 'frozen-aug2026-plus-aave-usde-v1',
  version: 1,
  lanes: [
    {
      name: 'core',
      root: 'data/research/venue-signals/local-carry-cash-v1',
      manifestSha256: '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3',
      prefixCount: 237,
      prefixHeadSha256: 'a2fb28ab9edc1adc01d9295ee15713f6dfe360a0d58c6db98382f9c90f7feaf2',
      anchorEnd: '2026-10-03T00:00:00.000Z',
      recordBytes: 128 * 1024,
    },
    {
      name: 'supplemental',
      root: 'data/research/venue-signals/local-carry-supplemental-aave-usde-cash-v1',
      manifestSha256: '11647d6e15a5f6d18d96d016e5522b1dcbf452b45022992dd139c2fa9a0d6ede',
      prefixCount: 120,
      prefixHeadSha256: '368163df8a8b7b518caee9fe049f7664f4ef09d0e860c1333ec354e4f219cf2e',
      anchorEnd: '2026-10-04T00:00:00.000Z',
      recordBytes: 32 * 1024,
    },
  ],
})
export const LIMITS = deepFreeze({
  receiptsPerLane: 512,
  combinedBytes: 96 * 1024 * 1024,
  artifactBytes: 2 * 1024 * 1024,
  reserveBytes: 1.25 * 1024 ** 3,
})
const BASE = 'data/research/venue-signals/conditional-sampled-cash-history-v1'
export const OUTPUTS = deepFreeze({ pins: `${BASE}.pins.json`, audit: `${BASE}.audit.json` })
/** File preflight is not a receipt verifier or a trust issuer. */
export function preflightDirectory(root, recordBytes) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw Error('pins_root_invalid')
  const files = readdirSync(root).sort()
  if (files.length > LIMITS.receiptsPerLane) throw Error('pins_count_limit')
  let bytes = 0
  for (const [i, name] of files.entries()) {
    if (name !== `${String(i + 1).padStart(12, '0')}.json`) throw Error('pins_filename_sequence')
    const stat = lstatSync(resolve(root, name))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > recordBytes)
      throw Error('pins_file_invalid_or_oversize')
    bytes += stat.size
    if (bytes > LIMITS.combinedBytes) throw Error('pins_combined_bytes')
  }
  return bytes
}
export function frozenPrefix(verified, lane) {
  if (
    verified.count < lane.prefixCount ||
    verified.records[lane.prefixCount - 1]?.sha256 !== lane.prefixHeadSha256
  )
    throw Error('pins_prefix_mismatch')
  const records = verified.records.slice(0, lane.prefixCount)
  return {
    ...verified,
    count: records.length,
    last: records.at(-1),
    records,
    keys: new Set(records.map((r) => `${r.collectionMode}\0${r.anchorAt}`)),
  }
}
export async function generateSampledCashHistoryArtifacts() {
  // All imports used here are local readers. This command never creates a provider.
  let bytes = 0
  for (const lane of PROFILE.lanes)
    bytes += preflightDirectory(resolve(ROOT, lane.root), lane.recordBytes)
  if (bytes > LIMITS.combinedBytes) throw Error('pins_combined_bytes')
  const manifest = await buildSubjectManifest()
  const supplemental = await buildSupplementalAaveUsdeCashManifest({ issueManifest: manifest })
  let remainingBytes = LIMITS.combinedBytes
  const pins = {},
    histories = {},
    exclusions = []
  for (const [i, m] of [manifest, supplemental].entries()) {
    const lane = PROFILE.lanes[i]
    if (m.sha256 !== lane.manifestSha256) throw Error('pins_manifest_mismatch')
    const root = resolve(ROOT, lane.root)
    const verified =
      i === 0
        ? verifyLocalCarryCash(m, root, {
            maxRecords: LIMITS.receiptsPerLane,
            maxTotalBytes: remainingBytes,
          })
        : verifyLocalSupplementalAaveUsdeCash(m, root, {
            maxRecords: LIMITS.receiptsPerLane,
            maxTotalBytes: remainingBytes,
          })
    remainingBytes -= verified.totalBytes
    const prefix = frozenPrefix(verified, lane)
    const observations = (
      i === 0
        ? localCarryCashObservationsFromVerified(prefix)
        : localSupplementalAaveUsdeCashObservationsFromVerified(prefix)
    ).filter((o) => o.collectionMode === 'retrospective' && o.anchorAt <= lane.anchorEnd)
    for (const subject of m.subjects) {
      const view = timeline(observations, subject)
      const resolved = resolveSubject(subject.route_key, subject.destination)
      if (resolved.payoutAsset.toLowerCase() !== subject.asset.toLowerCase()) {
        exclusions.push({
          routeKey: subject.route_key,
          destination: subject.destination,
          reason: 'foreign_final_payout',
        })
        continue
      }
      if (view.status !== 'sampled_timeline') throw Error('pins_native_history_unavailable')
      const history = historyFrom(observations, view)
      if (
        !history ||
        JSON.stringify(history.identity) !==
          JSON.stringify(nativeIdentity(subject.route_key, subject.destination))
      )
        throw Error('pins_native_identity_mismatch')
      if (pins[view.subjectKey]) throw Error('pins_duplicate_subject')
      pins[view.subjectKey] = {
        assetDecimals: history.identity.assetDecimals,
        compactSha256: hash(JSON.stringify(history)),
        ...history.witness,
      }
      histories[view.subjectKey] = history
    }
  }
  if (
    Object.keys(pins).length !== 64 ||
    exclusions.length !== 4 ||
    new Set(Object.values(histories).map((h) => h.identity.routeKey)).size !== 22
  )
    throw Error('pins_dimensions_mismatch')
  const sorted = (value) =>
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const body = { schemaVersion: 1, profile: PROFILE, pins: sorted(pins) }
  const pinArtifact = { ...body, sha256: hash(JSON.stringify(body)) }
  const auditBody = {
    schemaVersion: 1,
    profile: PROFILE,
    pinArtifactSha256: pinArtifact.sha256,
    exclusions,
    histories: sorted(histories),
  }
  return deepFreeze({
    pins: pinArtifact,
    audit: { ...auditBody, sha256: hash(JSON.stringify(auditBody)) },
  })
}
export function serializedArtifacts(artifacts) {
  const result = Object.fromEntries(
    Object.entries(artifacts).map(([k, v]) => [
      k,
      `${JSON.stringify(v, null, k === 'pins' ? 2 : undefined)}\n`,
    ]),
  )
  if (Object.values(result).some((s) => Buffer.byteLength(s) > LIMITS.artifactBytes))
    throw Error('pins_artifact_oversize')
  return result
}
/** Exclusive paired writer; check mode never calls it. Paths are internal, not CLI inputs. */
export function writeArtifacts(files, paths, freeBytes, writeOwnedFile = writeFileSync) {
  if (Object.values(paths).some((p) => existsSync(p))) throw Error('pins_output_exists')
  const total = Object.values(files).reduce((n, s) => n + Buffer.byteLength(s), 0)
  if (Object.values(files).some((s) => Buffer.byteLength(s) > LIMITS.artifactBytes))
    throw Error('pins_artifact_oversize')
  if (!Number.isSafeInteger(freeBytes) || freeBytes - total < LIMITS.reserveBytes)
    throw Error('pins_disk_reserve')
  const created = []
  try {
    for (const key of ['pins', 'audit']) {
      const fd = openSync(paths[key], 'wx')
      try {
        const owned = fstatSync(fd, { bigint: true })
        created.push({ path: paths[key], dev: owned.dev, ino: owned.ino })
        writeOwnedFile(fd, files[key])
      } finally {
        closeSync(fd)
      }
    }
  } catch (e) {
    // Preserve paths whose observed identity is missing or no longer ours.
    // This is an ownership check, not hostile-filesystem atomicity.
    for (const owned of created) {
      try {
        const current = lstatSync(owned.path, { bigint: true })
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === owned.dev &&
          current.ino === owned.ino
        )
          unlinkSync(owned.path)
      } catch {
        /* Missing or uninspectable paths are preserved. */
      }
    }
    throw e
  }
}
/** Read only: the actual opened artifact bytes share a 4 MiB budget. */
export function checkArtifacts(files, paths, readIo = {}) {
  const budget = boundedReceiptBudget(
    { maxRecords: 2, maxTotalBytes: 2 * LIMITS.artifactBytes },
    2,
    LIMITS.artifactBytes,
  )
  for (const key of ['pins', 'audit']) {
    if (readBoundedReceiptFile(paths[key], budget, readIo) !== files[key])
      throw Error('pins_committed_artifact_mismatch')
  }
}
export function parseArguments(args) {
  if (
    args.length !== 5 ||
    !['generate', 'check'].includes(args[0]) ||
    args[1] !== '--cohort' ||
    args[2] !== PROFILE.cohort ||
    args[3] !== '--version' ||
    args[4] !== '1'
  )
    throw Error('pins_unregistered_profile_or_arguments')
  return args[0]
}
export async function main(args = process.argv.slice(2)) {
  const mode = parseArguments(args)
  globalThis.fetch = async () => {
    throw Error('pins_network_forbidden')
  }
  const files = serializedArtifacts(await generateSampledCashHistoryArtifacts())
  const paths = Object.fromEntries(Object.entries(OUTPUTS).map(([k, p]) => [k, resolve(ROOT, p)]))
  if (mode === 'check') {
    checkArtifacts(files, paths)
  } else {
    const disk = statfsSync(dirname(paths.pins))
    writeArtifacts(files, paths, Number(disk.bavail) * Number(disk.bsize))
  }
  console.log(
    JSON.stringify({
      status: mode === 'check' ? 'checked' : 'generated',
      subjects: 64,
      groups: 22,
      pinSha256: JSON.parse(files.pins).sha256,
      bytes: Object.fromEntries(Object.entries(files).map(([k, s]) => [k, Buffer.byteLength(s)])),
    }),
  )
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
