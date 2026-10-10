import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import * as historyModule from '../../lib/carry/susdeJointHistoryEvidenceSet.ts'
const { susdePinnedJointHistoryEvidenceSet } = historyModule.default ?? historyModule

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const check = (condition, label) => {
  if (!condition) throw Error('susde_evidence_set_' + label)
}
function verifySeal(value, expected) {
  const { bodySha256, ...body } = value
  check(bodySha256 === expected && sha(JSON.stringify(body)) === expected, 'body_hash')
}
/** Offline byte/provenance verification. Native read replay remains the separate acquisition gate. */
export function verifySusdeHistoryEvidenceSetFiles({ compositionFile, archiveFile } = {}) {
  const pin = susdePinnedJointHistoryEvidenceSet()
  const compositionBytes = readFileSync(compositionFile ?? pin.composition.file)
  const archiveBytes = readFileSync(archiveFile ?? pin.archive.file)
  check(compositionBytes.length === 50080 && archiveBytes.length === 3468431, 'file_sizes')
  check(sha(compositionBytes) === pin.composition.fileSha256, 'composition_file_hash')
  check(sha(archiveBytes) === pin.archive.fileSha256, 'archive_file_hash')
  const composition = JSON.parse(compositionBytes),
    archive = JSON.parse(archiveBytes)
  verifySeal(composition, pin.composition.bodySha256)
  verifySeal(archive, pin.archive.bodySha256)
  check(
    composition.archiveFileSha256 === pin.archive.fileSha256 &&
      composition.archiveBodySha256 === pin.archive.bodySha256,
    'archive_binding',
  )
  check(
    composition.evidenceSetSha256 === pin.evidenceSetSha256 &&
      sha(
        JSON.stringify(
          pin.sources.map((s) => ({
            id: s.id,
            fileSha256: s.fileSha256,
            captureFileSha256: s.captureFileSha256,
            nativePlanSha256: s.nativePlanSha256,
          })),
        ),
      ) === pin.evidenceSetSha256,
    'evidence_set_hash',
  )
  check(
    composition.inputManifestSha256 === pin.inputManifestSha256 &&
      archive.inputManifestSha256 === pin.inputManifestSha256 &&
      composition.qualifiedHistorySha256 === pin.qualifiedHistorySha256,
    'source_bindings',
  )
  check(
    composition.compositionAtUtc === pin.compositionAtUtc &&
      pin.availableAtUtc === pin.compositionAtUtc &&
      isDeepStrictEqual(composition.rows, pin.rows) &&
      isDeepStrictEqual(composition.missingIndices, pin.missingIndices) &&
      isDeepStrictEqual(composition.gaps, pin.gaps),
    'canonical_subset',
  )
  check(archive.members.length === pin.sources.length, 'archive_members')
  let decodedBytes = 0
  for (const [i, source] of pin.sources.entries()) {
    const member = archive.members[i],
      gzip = Buffer.from(member.gzipBase64, 'base64')
    check(
      member.inputId === source.id &&
        member.originalFileSha256 === source.fileSha256 &&
        gzip.length === member.gzipBytes &&
        sha(gzip) === member.gzipSha256,
      'member_hash',
    )
    const bytes = gunzipSync(gzip, { maxOutputLength: 8 * 1024 * 1024 })
    decodedBytes += bytes.length
    check(
      decodedBytes <= 16 * 1024 * 1024 &&
        bytes.length === source.fileBytes &&
        bytes.length === member.uncompressedBytes &&
        sha(bytes) === source.fileSha256,
      'source_file_hash',
    )
    const original = JSON.parse(bytes)
    verifySeal(original, source.bodySha256)
    check(
      sha(JSON.stringify(original.capture) + '\n') === source.captureFileSha256 &&
        original.captureFileSha256 === source.captureFileSha256 &&
        original.plan.sha256 === source.nativePlanSha256 &&
        original.driverSha256 === source.driverSha256 &&
        original.capture.startedAt === source.startedAt &&
        original.capture.availableAt === source.availableAt,
      'original_authority',
    )
    const expectedRows = original.observation.rows.map((row, j) => ({
      ...row,
      provenance: {
        inputId: source.id,
        originalFileSha256: source.fileSha256,
        originalCaptureFileSha256: source.captureFileSha256,
        originalNativePlanSha256: source.nativePlanSha256,
        withinCaptureIndex: j,
      },
      acquisitionByOrigin: original.capture.hosts.map((host) => ({
        origin: host.origin,
        startedAt: host.traces[j][0].startedAt,
        completedAt: host.traces[j].at(-1).completedAt,
      })),
    }))
    check(
      isDeepStrictEqual(
        expectedRows.map((r) => r.index),
        source.indices,
      ) &&
        isDeepStrictEqual(
          expectedRows,
          pin.rows.filter((r) => r.provenance.inputId === source.id),
        ),
      'row_provenance',
    )
  }
  const donors = []
  for (let i = 1; i < pin.rows.length; i++) {
    const a = pin.rows[i - 1],
      b = pin.rows[i]
    const elapsedSeconds = (Date.parse(b.sourceAt) - Date.parse(a.sourceAt)) / 1000
    check((b.index - a.index) * 86400 === elapsedSeconds, 'index_time_consistency')
    check(Date.parse(pin.availableAtUtc) >= Date.parse(b.availableAt), 'composition_availability')
    if (elapsedSeconds !== 86400) continue
    donors.push({
      fromIndex: a.index,
      toIndex: b.index,
      elapsedSeconds,
      vaultNetUsdeRaw: String(BigInt(b.vaultUsdeRaw) - BigInt(a.vaultUsdeRaw)),
      siloNetUsdeRaw: String(BigInt(b.siloUsdeRaw) - BigInt(a.siloUsdeRaw)),
      availableAt: new Date(
        Math.max(Date.parse(a.availableAt), Date.parse(b.availableAt)),
      ).toISOString(),
      endpointProvenance: [a.provenance, b.provenance],
    })
  }
  check(
    donors.length === 22 && isDeepStrictEqual(donors, composition.changes),
    'exact_daily_donors',
  )
  return {
    evidenceSetSha256: pin.evidenceSetSha256,
    rows: pin.rows.length,
    dailyDonors: donors.length,
    sources: pin.sources.length,
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  check(process.execArgv.includes('--max-old-space-size=384'), 'heap')
  check(process.argv.length === 2, 'arguments')
  console.log(JSON.stringify(verifySusdeHistoryEvidenceSetFiles()))
}
