// Offline replay of a locally published RFC 3161 sidecar. The sidecar is
// untrusted input: only separately supplied trust material can reach the
// token verifier, and even a successful result is under that supplied pin.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { verifyRfc3161Witness } from './holder-exit-rfc3161-witness.mjs'

const SHA256 = /^[a-f\d]{64}$/
const POLICY = /^\d+(?:\.\d+)+$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const LIMITS = Object.freeze({
  artifact: 64 * 1024 * 1024,
  sidecar: 1536 * 1024,
  query: 64 * 1024,
  response: 1024 * 1024,
  pem: 512 * 1024,
})

class ReplayFailure extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

function fail(reason) {
  throw new ReplayFailure(reason)
}

function requireTrue(condition, reason) {
  if (!condition) fail(reason)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function exactKeys(value, names, reason) {
  requireTrue(value !== null && typeof value === 'object' && !Array.isArray(value), reason)
  requireTrue(
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name)),
    reason,
  )
}

function readExact(path, maximum, label, allowEmpty = false) {
  let fd
  try {
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      fail(error?.code === 'ENOENT' ? `${label}_missing` : `${label}_open_failed`)
    }
    const before = fstatSync(fd, { bigint: true })
    requireTrue(before.isFile(), `${label}_not_regular`)
    requireTrue(before.size <= BigInt(maximum) && (allowEmpty || before.size > 0n), `${label}_size`)
    const bytes = Buffer.alloc(Number(before.size))
    for (let offset = 0; offset < bytes.length; ) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      requireTrue(count > 0, `${label}_changed`)
      offset += count
    }
    requireTrue(readSync(fd, Buffer.alloc(1), 0, 1, null) === 0, `${label}_changed`)
    const after = fstatSync(fd, { bigint: true })
    requireTrue(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
      `${label}_changed`,
    )
    return bytes
  } catch (error) {
    if (error instanceof ReplayFailure) throw error
    fail(`${label}_read_failed`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function canonicalSidecar(bytes) {
  let record
  try {
    record = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('sidecar_json')
  }
  requireTrue(bytes.equals(Buffer.from(`${JSON.stringify(record)}\n`)), 'sidecar_not_canonical')
  exactKeys(
    record,
    ['schema', 'status', 'trustedUtc', 'localClockStatus', 'artifact', 'request', 'response'],
    'sidecar_shape',
  )
  requireTrue(
    record.schema === 'holder_exit_rfc3161_publication_v1' &&
      record.status === 'pending_trust_root' &&
      record.trustedUtc === null,
    'sidecar_claim_invalid',
  )
  exactKeys(record.artifact, ['filename', 'byteLength', 'sha256'], 'artifact_fields')
  exactKeys(
    record.request,
    ['tsaUrl', 'policyOid', 'contentType', 'sentAtLocalUtc', 'derBase64', 'sha256'],
    'request_fields',
  )
  exactKeys(
    record.response,
    ['contentType', 'receivedAtLocalUtc', 'derBase64', 'sha256'],
    'response_fields',
  )
  requireTrue(
    record.request.contentType === 'application/timestamp-query' &&
      record.response.contentType === 'application/timestamp-reply' &&
      typeof record.request.tsaUrl === 'string' &&
      record.request.tsaUrl.length > 0 &&
      record.request.tsaUrl.length <= 2048,
    'sidecar_protocol_fields',
  )
  const sent = localTime(record.request.sentAtLocalUtc)
  const received = localTime(record.response.receivedAtLocalUtc)
  const clockStatus =
    sent === null || received === null
      ? 'unavailable'
      : received < sent
        ? 'regressed'
        : 'observed_untrusted'
  requireTrue(record.localClockStatus === clockStatus, 'sidecar_local_clock_fields')
  return record
}

function localTime(value) {
  if (value === null) return null
  requireTrue(typeof value === 'string', 'sidecar_local_clock_fields')
  const time = Date.parse(value)
  requireTrue(
    Number.isFinite(time) && new Date(time).toISOString() === value,
    'sidecar_local_clock_fields',
  )
  return value
}

function decodeDer(value, expectedSha256, maximum, label) {
  requireTrue(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= Math.ceil(maximum / 3) * 4 &&
      BASE64.test(value),
    `${label}_base64`,
  )
  const bytes = Buffer.from(value, 'base64')
  requireTrue(
    bytes.length > 0 && bytes.length <= maximum && bytes.toString('base64') === value,
    `${label}_base64`,
  )
  requireTrue(
    SHA256.test(expectedSha256 ?? '') && sha256(bytes) === expectedSha256,
    `${label}_sha256`,
  )
  return bytes
}

function callerTrust({ expectedPolicyOid, rootPem, chainPem, expectedRootSha256 }) {
  requireTrue(
    typeof expectedPolicyOid === 'string' &&
      expectedPolicyOid.length <= 128 &&
      POLICY.test(expectedPolicyOid),
    'expected_policy_missing',
  )
  requireTrue(
    typeof rootPem === 'string' && rootPem.length > 0 && Buffer.byteLength(rootPem) <= LIMITS.pem,
    'root_pem_missing',
  )
  requireTrue(
    typeof chainPem === 'string' &&
      chainPem.length > 0 &&
      Buffer.byteLength(chainPem) <= LIMITS.pem,
    'chain_pem_missing',
  )
  requireTrue(
    typeof expectedRootSha256 === 'string' &&
      (/^[a-f\d]{64}$/i.test(expectedRootSha256) ||
        /^(?:[a-f\d]{2}:){31}[a-f\d]{2}$/i.test(expectedRootSha256)),
    'root_pin_missing',
  )
  return expectedRootSha256.replaceAll(':', '').toLowerCase()
}

function utcNanoseconds(value) {
  const match =
    typeof value === 'string'
      ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value)
      : null
  requireTrue(Boolean(match), 'verifier_result_invalid')
  const milliseconds = Date.parse(`${match[1]}Z`)
  requireTrue(
    Number.isSafeInteger(milliseconds) &&
      new Date(milliseconds).toISOString().slice(0, 19) === match[1],
    'verifier_result_invalid',
  )
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0') || '0')
}

function verifiedResult(result, actualSha256, rootPin, policyOid) {
  requireTrue(result?.status === 'verified_under_supplied_pin', 'verifier_result_invalid')
  requireTrue(
    result.artifactSha256 === actualSha256 &&
      result.rootSha256 === rootPin &&
      result.policyOid === policyOid &&
      typeof result.genTimeUtc === 'string' &&
      Number.isSafeInteger(result.accuracyMicros) &&
      result.accuracyMicros >= 0 &&
      result.accuracyMicros <= 86_400_999_999 &&
      typeof result.intervalUtc?.earliest === 'string' &&
      typeof result.intervalUtc?.latest === 'string',
    'verifier_result_invalid',
  )
  const signedTime = utcNanoseconds(result.genTimeUtc)
  const earliest = utcNanoseconds(result.intervalUtc.earliest)
  const latest = utcNanoseconds(result.intervalUtc.latest)
  const accuracy = BigInt(result.accuracyMicros) * 1_000n
  requireTrue(
    earliest === signedTime - accuracy && latest === signedTime + accuracy,
    'verifier_result_invalid',
  )
  return {
    status: 'verified_under_supplied_pin',
    artifactSha256: actualSha256,
    rootSha256: rootPin,
    policyOid,
    genTimeUtc: result.genTimeUtc,
    accuracyMicros: result.accuracyMicros,
    intervalUtc: {
      earliest: result.intervalUtc.earliest,
      latest: result.intervalUtc.latest,
    },
  }
}

/**
 * Reopens both exact files and calls the token verifier with caller-supplied
 * trust material only. A supplied-pin result is not an independent clock.
 */
export async function replayRfc3161Sidecar(
  { artifactPath, sidecarPath, expectedPolicyOid, rootPem, chainPem, expectedRootSha256 } = {},
  { verify = verifyRfc3161Witness } = {},
) {
  try {
    requireTrue(
      typeof artifactPath === 'string' && artifactPath.length > 0,
      'artifact_path_missing',
    )
    const artifactPathResolved = resolve(artifactPath)
    const sidecarPathResolved = sidecarPath
      ? resolve(sidecarPath)
      : `${artifactPathResolved}.rfc3161-witness`
    const rootPin = callerTrust({ expectedPolicyOid, rootPem, chainPem, expectedRootSha256 })
    const artifactBytes = readExact(artifactPathResolved, LIMITS.artifact, 'artifact', true)
    const sidecarBytes = readExact(sidecarPathResolved, LIMITS.sidecar, 'sidecar')
    const record = canonicalSidecar(sidecarBytes)
    const artifactSha256 = sha256(artifactBytes)
    requireTrue(
      record.artifact.filename === basename(artifactPathResolved) &&
        record.artifact.byteLength === artifactBytes.length &&
        SHA256.test(record.artifact.sha256 ?? '') &&
        record.artifact.sha256 === artifactSha256,
      'artifact_binding_mismatch',
    )
    requireTrue(record.request.policyOid === expectedPolicyOid, 'policy_mismatch')
    const queryDer = decodeDer(
      record.request.derBase64,
      record.request.sha256,
      LIMITS.query,
      'query',
    )
    const responseDer = decodeDer(
      record.response.derBase64,
      record.response.sha256,
      LIMITS.response,
      'response',
    )
    const result = await verify({
      artifactBytes,
      queryDer,
      responseDer,
      chainPem,
      rootPem,
      expectedRootSha256,
      expectedPolicyOid,
    })
    if (result?.status === 'unverified') {
      const reason = result.reason
      fail(
        typeof reason === 'string' && /^[a-z][a-z\d_]{0,63}$/.test(reason)
          ? reason
          : 'token_unverified',
      )
    }
    const verified = verifiedResult(result, artifactSha256, rootPin, expectedPolicyOid)
    // A verifier may take seconds. Before returning its result, require the
    // current path bytes to still match the bytes that were submitted to it.
    requireTrue(
      readExact(artifactPathResolved, LIMITS.artifact, 'artifact', true).equals(artifactBytes) &&
        readExact(sidecarPathResolved, LIMITS.sidecar, 'sidecar').equals(sidecarBytes),
      'files_changed_during_replay',
    )
    return verified
  } catch (error) {
    return {
      status: 'unverified',
      reason: error instanceof ReplayFailure ? error.reason : 'replay_error',
    }
  }
}
