// Read-only RFC 3161 evidence overlay. A supplied root pin proves only what
// the caller supplied; it does not make a clock independently authenticated.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

import { replayRfc3161Sidecar } from './holder-exit-rfc3161-sidecar-replay.mjs'

const SHA = /^[0-9a-f]{64}$/
const MAX_PROOFS = 50_000
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const PIN_CLOCK = 'rfc3161_verified_under_supplied_pin'
const LOCAL_CLOCK = 'local_operator_clock_unwitnessed'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const normalizedPin = (value) =>
  typeof value === 'string' ? value.replaceAll(':', '').toLowerCase() : null
const subjectKey = (route, destination, asset) =>
  `${route}\0${destination.toLowerCase()}\0${asset.toLowerCase()}`

function utcNanos(value) {
  const match =
    typeof value === 'string'
      ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value)
      : null
  if (!match) return null
  const ms = Date.parse(`${match[1]}Z`)
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) return null
  return BigInt(ms) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0') || '0')
}

async function exactSealedRecord(path, expectedArtifactSha256) {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_ARTIFACT_BYTES))
      return null
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      hash(bytes) !== expectedArtifactSha256
    )
      return null
    const record = JSON.parse(bytes.toString('utf8'))
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      !bytes.equals(Buffer.from(`${JSON.stringify(record)}\n`)) ||
      !SHA.test(record.sha256 ?? '')
    )
      return null
    const { sha256, ...body } = record
    return hash(JSON.stringify(body)) === sha256 ? record : null
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

function proofKey({ kind, recordSha256, subject, stageScope, targetAtUtc }) {
  return JSON.stringify([kind, recordSha256, subject, stageScope, targetAtUtc])
}

function boundToRow(proof, record, row) {
  if (
    typeof record.routeKey !== 'string' ||
    typeof record.destination !== 'string' ||
    typeof (record.originalAsset ?? record.asset) !== 'string'
  )
    return false
  if (
    proof.subject !== row.subject ||
    proof.stageScope !== row.stageScope ||
    proof.targetAtUtc !== row.targetAtUtc ||
    subjectKey(record.routeKey, record.destination, record.originalAsset ?? record.asset) !==
      row.subject
  )
    return false
  if (proof.kind === 'issue')
    return (
      record.sha256 === row.issueSha256 &&
      Array.isArray(record.targets) &&
      record.targets.some((target) => target?.targetAtUtc === row.targetAtUtc)
    )
  return (
    proof.kind === 'score' &&
    record.sha256 === row.scoreSha256 &&
    record.issueSha256 === row.issueSha256 &&
    record.targetAtUtc === row.targetAtUtc
  )
}

function inWindow(proof, row, nowMs) {
  const earliest = utcNanos(proof.intervalUtc?.earliest)
  const latest = utcNanos(proof.intervalUtc?.latest)
  const issued = utcNanos(row.issueAtUtc)
  const labelAvailable = utcNanos(row.labelAvailableAtUtc ?? row.scoreAtUtc)
  const target = utcNanos(row.targetAtUtc)
  const deadline = utcNanos(row.deadlineAtUtc)
  const observed = utcNanos(row.observedAtUtc)
  const now = BigInt(nowMs) * 1_000_000n
  if (earliest === null || latest === null || target === null || deadline === null) return false
  if (earliest > latest || latest > now) return false
  if (proof.kind === 'issue') return issued !== null && latest >= issued && latest < target
  return (
    observed !== null &&
    labelAvailable !== null &&
    earliest >= observed &&
    latest >= labelAvailable &&
    latest <= deadline
  )
}

/**
 * Each descriptor binds one sealed issue or score to one exact subject, stage,
 * and planned target. Duplicate descriptors invalidate that key. No network
 * calls occur here; replayRfc3161Sidecar only reopens local files.
 */
export async function applyHolderExitClockProofOverlay(
  panel,
  proofs = [],
  { replay = replayRfc3161Sidecar, nowMs = Date.now() } = {},
) {
  if (!Array.isArray(proofs) || proofs.length > MAX_PROOFS || !Number.isSafeInteger(nowMs))
    throw Error('holder_clock_proofs_invalid')
  const candidates = new Map()
  for (const proof of proofs) {
    if (
      !['issue', 'score'].includes(proof?.kind) ||
      !SHA.test(proof.recordSha256 ?? '') ||
      typeof proof.subject !== 'string' ||
      typeof proof.stageScope !== 'string' ||
      typeof proof.targetAtUtc !== 'string'
    )
      continue
    const key = proofKey(proof)
    candidates.set(key, candidates.has(key) ? null : proof)
  }
  const resolved = new Map()
  for (const [key, descriptor] of candidates) {
    if (!descriptor) continue
    let result
    try {
      result = await replay(descriptor)
    } catch {
      continue
    }
    if (
      result?.status !== 'verified_under_supplied_pin' ||
      !SHA.test(result.artifactSha256 ?? '') ||
      !SHA.test(normalizedPin(descriptor.expectedRootSha256) ?? '') ||
      result.rootSha256 !== normalizedPin(descriptor.expectedRootSha256) ||
      result.policyOid !== descriptor.expectedPolicyOid
    )
      continue
    const record = await exactSealedRecord(descriptor.artifactPath, result.artifactSha256)
    if (record?.sha256 !== descriptor.recordSha256) continue
    resolved.set(key, { ...result, record })
  }
  let witnessedIssueRows = 0
  let witnessedScoreRows = 0
  const subjects = panel.subjects.map((subject) => ({
    ...subject,
    episodes: subject.episodes.map((row) => {
      let next = row
      for (const kind of ['issue', 'score']) {
        const recordSha256 = kind === 'issue' ? row.issueSha256 : row.scoreSha256
        if (!SHA.test(recordSha256 ?? '')) continue
        const proof = resolved.get(
          proofKey({
            kind,
            recordSha256,
            subject: row.subject,
            stageScope: row.stageScope,
            targetAtUtc: row.targetAtUtc,
          }),
        )
        if (
          !proof ||
          !boundToRow(
            {
              kind,
              subject: row.subject,
              stageScope: row.stageScope,
              targetAtUtc: row.targetAtUtc,
            },
            proof.record,
            row,
          ) ||
          !inWindow({ ...proof, kind }, row, nowMs)
        )
          continue
        const witnessedAvailabilityAtUtc = proof.intervalUtc.latest
        const evidence = {
          basis: 'rfc3161_digest_existence_under_supplied_pin',
          artifactSha256: proof.artifactSha256,
          rootSha256: proof.rootSha256,
          policyOid: proof.policyOid,
          intervalUtc: proof.intervalUtc,
          rootProvenance: 'caller_supplied_unverified',
        }
        next =
          kind === 'issue'
            ? {
                ...next,
                issueClock: PIN_CLOCK,
                issueWitnessedAvailabilityAtUtc: witnessedAvailabilityAtUtc,
                issueClockProof: evidence,
              }
            : {
                ...next,
                scoreClock: PIN_CLOCK,
                scoreWitnessedAvailabilityAtUtc: witnessedAvailabilityAtUtc,
                scoreClockProof: evidence,
              }
        if (kind === 'issue') witnessedIssueRows++
        else witnessedScoreRows++
      }
      return {
        ...next,
        issueClock: next.issueClock ?? LOCAL_CLOCK,
        scoreClock: next.scoreClock ?? LOCAL_CLOCK,
        featureAvailabilityClock: row.featureAvailabilityClock,
      }
    }),
  }))
  return {
    ...panel,
    subjects,
    clockProofOverlay: {
      submitted: proofs.length,
      duplicateKeys: [...candidates.values()].filter((entry) => entry === null).length,
      verifiedKeys: resolved.size,
      witnessedIssueRows,
      witnessedScoreRows,
      independentUtcWitnesses: 0,
    },
  }
}
