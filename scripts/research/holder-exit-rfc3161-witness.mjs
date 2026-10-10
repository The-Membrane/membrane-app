// Offline RFC 3161 replay for exact retained bytes. The caller supplies and
// authenticates the trust root; this module never obtains trust or a clock.
import { execFile } from 'node:child_process'
import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const OPENSSL = '/opt/homebrew/bin/openssl'
const SHA256_OID = '2.16.840.1.101.3.4.2.1'
const SIGNED_DATA_OID = '1.2.840.113549.1.7.2'
const TST_INFO_OID = '1.2.840.113549.1.9.16.1.4'
const BILLION = 1_000_000_000n
const LIMITS = Object.freeze({
  artifact: 64 * 1024 * 1024,
  query: 64 * 1024,
  response: 1024 * 1024,
  pem: 512 * 1024,
  certificates: 8,
  accuracySeconds: 86_400,
})

class VerificationFailure extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

function fail(reason) {
  throw new VerificationFailure(reason)
}

function requireTrue(condition, reason) {
  if (!condition) fail(reason)
}

function snapshotBytes(value, name, maximum, allowEmpty = false) {
  requireTrue(Buffer.isBuffer(value) || value instanceof Uint8Array, `invalid_${name}`)
  requireTrue(value.byteLength <= maximum && (allowEmpty || value.byteLength > 0), `${name}_size`)
  return Buffer.from(value)
}

function parsePemCertificates(value, name, minimum, maximum) {
  requireTrue(
    typeof value === 'string' && Buffer.byteLength(value) <= LIMITS.pem,
    `invalid_${name}`,
  )
  const pattern = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g
  const blocks = [...value.matchAll(pattern)]
  requireTrue(blocks.length >= minimum && blocks.length <= maximum, `invalid_${name}`)
  requireTrue(value.replace(pattern, '').trim() === '', `invalid_${name}`)
  try {
    return blocks.map((block) => new X509Certificate(block[0]))
  } catch {
    fail(`invalid_${name}`)
  }
}

function expectedFingerprint(value) {
  requireTrue(
    typeof value === 'string' &&
      (/^[a-f\d]{64}$/i.test(value) || /^(?:[a-f\d]{2}:){31}[a-f\d]{2}$/i.test(value)),
    'invalid_root_fingerprint',
  )
  return Buffer.from(value.replaceAll(':', ''), 'hex')
}

function readTlv(bytes, offset, end) {
  requireTrue(offset + 2 <= end, 'invalid_der')
  const tag = bytes[offset]
  requireTrue((tag & 31) !== 31, 'invalid_der')
  let length = bytes[offset + 1]
  let cursor = offset + 2
  if (length & 0x80) {
    const count = length & 0x7f
    requireTrue(count >= 1 && count <= 4 && cursor + count <= end, 'invalid_der')
    requireTrue(bytes[cursor] !== 0, 'invalid_der')
    length = 0
    for (let i = 0; i < count; i += 1) length = length * 256 + bytes[cursor + i]
    requireTrue(length >= 128, 'invalid_der')
    cursor += count
  }
  requireTrue(cursor + length <= end, 'invalid_der')
  return {
    tag,
    start: offset,
    contentStart: cursor,
    contentEnd: cursor + length,
    end: cursor + length,
  }
}

function rootTlv(bytes, tag) {
  const node = readTlv(bytes, 0, bytes.length)
  requireTrue(node.tag === tag && node.end === bytes.length, 'invalid_der')
  return node
}

function children(bytes, parent) {
  const items = []
  for (let cursor = parent.contentStart; cursor < parent.contentEnd; ) {
    const item = readTlv(bytes, cursor, parent.contentEnd)
    items.push(item)
    cursor = item.end
  }
  return items
}

function isTag(node, tag) {
  return node?.tag === tag
}

function unsignedInteger(bytes, node, maximumLength = 32) {
  requireTrue(isTag(node, 0x02), 'invalid_der')
  const raw = bytes.subarray(node.contentStart, node.contentEnd)
  requireTrue(
    raw.length >= 1 && raw.length <= maximumLength && (raw[0] & 0x80) === 0,
    'invalid_der',
  )
  requireTrue(raw.length === 1 || raw[0] !== 0 || (raw[1] & 0x80) !== 0, 'invalid_der')
  let number = 0n
  for (const byte of raw) number = (number << 8n) | BigInt(byte)
  return number
}

function taggedInteger(bytes, node, tag) {
  requireTrue(isTag(node, tag), 'invalid_accuracy')
  return unsignedInteger(bytes, { ...node, tag: 0x02 }, 4)
}

function oid(bytes, node) {
  requireTrue(isTag(node, 0x06), 'invalid_der')
  const raw = bytes.subarray(node.contentStart, node.contentEnd)
  requireTrue(raw.length >= 1 && raw.length <= 64, 'invalid_der')
  const parts = []
  for (let i = 0; i < raw.length; ) {
    requireTrue(raw[i] !== 0x80, 'invalid_der')
    let number = 0n
    let count = 0
    for (;;) {
      requireTrue(i < raw.length && count < 10, 'invalid_der')
      const byte = raw[i++]
      number = (number << 7n) | BigInt(byte & 0x7f)
      count += 1
      if (!(byte & 0x80)) break
    }
    parts.push(number)
  }
  const first = parts.shift()
  const arc0 = first < 40n ? 0n : first < 80n ? 1n : 2n
  return [arc0, first - arc0 * 40n, ...parts].join('.')
}

function messageImprint(bytes, node) {
  requireTrue(isTag(node, 0x30), 'invalid_der')
  const fields = children(bytes, node)
  requireTrue(
    fields.length === 2 && isTag(fields[0], 0x30) && isTag(fields[1], 0x04),
    'invalid_der',
  )
  const algorithm = children(bytes, fields[0])
  requireTrue(algorithm.length >= 1 && algorithm.length <= 2, 'invalid_der')
  requireTrue(oid(bytes, algorithm[0]) === SHA256_OID, 'non_sha256_imprint')
  if (algorithm.length === 2)
    requireTrue(
      isTag(algorithm[1], 0x05) && algorithm[1].contentStart === algorithm[1].contentEnd,
      'invalid_der',
    )
  const digest = bytes.subarray(fields[1].contentStart, fields[1].contentEnd)
  requireTrue(digest.length === 32, 'invalid_sha256_imprint')
  return Buffer.from(digest)
}

function requireSha256SignerDigest(bytes, node) {
  requireTrue(isTag(node, 0x30), 'invalid_response')
  const algorithm = children(bytes, node)
  requireTrue(algorithm.length >= 1 && algorithm.length <= 2, 'invalid_response')
  requireTrue(oid(bytes, algorithm[0]) === SHA256_OID, 'non_sha256_signature_digest')
  if (algorithm.length === 2)
    requireTrue(
      isTag(algorithm[1], 0x05) && algorithm[1].contentStart === algorithm[1].contentEnd,
      'invalid_response',
    )
}

function parseQuery(bytes) {
  const fields = children(bytes, rootTlv(bytes, 0x30))
  requireTrue(fields.length >= 3 && unsignedInteger(bytes, fields[0], 2) === 1n, 'invalid_query')
  const imprint = messageImprint(bytes, fields[1])
  let cursor = 2
  let policyOid = null
  if (isTag(fields[cursor], 0x06)) policyOid = oid(bytes, fields[cursor++])
  requireTrue(isTag(fields[cursor], 0x02), 'missing_request_nonce')
  const nonce = unsignedInteger(bytes, fields[cursor++])
  requireTrue(nonce > 0n, 'invalid_request_nonce')
  if (isTag(fields[cursor], 0x01)) {
    const boolean = bytes.subarray(fields[cursor].contentStart, fields[cursor].contentEnd)
    requireTrue(boolean.length === 1 && (boolean[0] === 0 || boolean[0] === 0xff), 'invalid_query')
    cursor += 1
  }
  if (isTag(fields[cursor], 0xa0)) cursor += 1
  requireTrue(cursor === fields.length, 'invalid_query')
  return { imprint, nonce, policyOid }
}

function parseAccuracy(bytes, node) {
  const fields = children(bytes, node)
  requireTrue(fields.length >= 1 && fields.length <= 3, 'invalid_accuracy')
  let cursor = 0
  let seconds = 0n
  let millis = 0n
  let micros = 0n
  if (isTag(fields[cursor], 0x02)) seconds = unsignedInteger(bytes, fields[cursor++], 4)
  if (isTag(fields[cursor], 0x80)) millis = taggedInteger(bytes, fields[cursor++], 0x80)
  if (isTag(fields[cursor], 0x81)) micros = taggedInteger(bytes, fields[cursor++], 0x81)
  requireTrue(cursor === fields.length, 'invalid_accuracy')
  requireTrue(seconds <= BigInt(LIMITS.accuracySeconds), 'accuracy_out_of_bounds')
  requireTrue(
    (millis === 0n || millis <= 999n) && (micros === 0n || micros <= 999n),
    'invalid_accuracy',
  )
  // Tagged subsecond fields are constrained to 1..999, not encoded zero.
  if (fields.some((field) => field.tag === 0x80)) requireTrue(millis > 0n, 'invalid_accuracy')
  if (fields.some((field) => field.tag === 0x81)) requireTrue(micros > 0n, 'invalid_accuracy')
  return { seconds: Number(seconds), millis: Number(millis), micros: Number(micros) }
}

function parseGenTime(bytes, node) {
  requireTrue(isTag(node, 0x18), 'invalid_gen_time')
  const encoded = bytes.subarray(node.contentStart, node.contentEnd)
  requireTrue(
    encoded.every((byte) => byte <= 0x7f),
    'invalid_gen_time',
  )
  const raw = encoded.toString('ascii')
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,9}))?Z$/.exec(raw)
  requireTrue(Boolean(match) && (!match[7] || !match[7].endsWith('0')), 'invalid_gen_time')
  const [, y, mo, d, h, mi, s, fraction = ''] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = Number(s)
  requireTrue(year >= 1 && year <= 9999 && second <= 59, 'invalid_gen_time')
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  requireTrue(
    date.getUTCFullYear() === year &&
      date.getUTCMonth() + 1 === month &&
      date.getUTCDate() === day &&
      date.getUTCHours() === hour &&
      date.getUTCMinutes() === minute &&
      date.getUTCSeconds() === second,
    'invalid_gen_time',
  )
  const epochSeconds = BigInt(date.getTime() / 1000)
  return {
    epochSeconds,
    nanoseconds: epochSeconds * BILLION + BigInt(fraction.padEnd(9, '0') || '0'),
  }
}

function parseResponse(bytes) {
  const outer = children(bytes, rootTlv(bytes, 0x30))
  requireTrue(outer.length === 2 && isTag(outer[0], 0x30), 'invalid_response')
  const status = children(bytes, outer[0])
  requireTrue(
    status.length >= 1 && unsignedInteger(bytes, status[0], 2) === 0n,
    'non_granted_status',
  )
  const contentInfo = children(bytes, outer[1])
  requireTrue(isTag(outer[1], 0x30) && contentInfo.length === 2, 'invalid_response')
  requireTrue(
    oid(bytes, contentInfo[0]) === SIGNED_DATA_OID && isTag(contentInfo[1], 0xa0),
    'invalid_response',
  )
  const wrapper = children(bytes, contentInfo[1])
  requireTrue(wrapper.length === 1 && isTag(wrapper[0], 0x30), 'invalid_response')
  const signedData = children(bytes, wrapper[0])
  requireTrue(
    signedData.length >= 4 && isTag(signedData[1], 0x31) && isTag(signedData[2], 0x30),
    'invalid_response',
  )
  const digestAlgorithms = children(bytes, signedData[1])
  requireTrue(digestAlgorithms.length === 1, 'invalid_response')
  requireSha256SignerDigest(bytes, digestAlgorithms[0])
  const signerInfos = signedData.at(-1)
  const signers = isTag(signerInfos, 0x31) ? children(bytes, signerInfos) : []
  requireTrue(signers.length === 1 && isTag(signers[0], 0x30), 'invalid_response')
  const signerInfo = children(bytes, signers[0])
  requireTrue(signerInfo.length >= 5, 'invalid_response')
  requireSha256SignerDigest(bytes, signerInfo[2])
  const content = children(bytes, signedData[2])
  requireTrue(
    content.length === 2 && oid(bytes, content[0]) === TST_INFO_OID && isTag(content[1], 0xa0),
    'invalid_response',
  )
  const encapsulated = children(bytes, content[1])
  requireTrue(encapsulated.length === 1 && isTag(encapsulated[0], 0x04), 'invalid_response')
  const tstBytes = bytes.subarray(encapsulated[0].contentStart, encapsulated[0].contentEnd)
  const fields = children(tstBytes, rootTlv(tstBytes, 0x30))
  requireTrue(
    fields.length >= 6 && unsignedInteger(tstBytes, fields[0], 2) === 1n,
    'invalid_response',
  )
  const policyOid = oid(tstBytes, fields[1])
  const imprint = messageImprint(tstBytes, fields[2])
  requireTrue(unsignedInteger(tstBytes, fields[3]) > 0n, 'invalid_response')
  const genTime = parseGenTime(tstBytes, fields[4])
  let cursor = 5
  requireTrue(isTag(fields[cursor], 0x30), 'missing_accuracy')
  const accuracy = parseAccuracy(tstBytes, fields[cursor++])
  if (isTag(fields[cursor], 0x01)) {
    const boolean = tstBytes.subarray(fields[cursor].contentStart, fields[cursor].contentEnd)
    requireTrue(
      boolean.length === 1 && (boolean[0] === 0 || boolean[0] === 0xff),
      'invalid_response',
    )
    cursor += 1
  }
  requireTrue(isTag(fields[cursor], 0x02), 'missing_token_nonce')
  const nonce = unsignedInteger(tstBytes, fields[cursor++])
  requireTrue(nonce > 0n, 'invalid_token_nonce')
  if (isTag(fields[cursor], 0xa0)) cursor += 1
  if (isTag(fields[cursor], 0xa1)) cursor += 1
  requireTrue(cursor === fields.length, 'invalid_response')
  return { policyOid, imprint, nonce, genTime, accuracy }
}

function formatUtc(nanoseconds) {
  const seconds = nanoseconds >= 0n ? nanoseconds / BILLION : (nanoseconds - BILLION + 1n) / BILLION
  const fraction = String(nanoseconds - seconds * BILLION)
    .padStart(9, '0')
    .replace(/0+$/, '')
  const iso = new Date(Number(seconds * 1000n)).toISOString()
  requireTrue(/^\d{4}-/.test(iso) && !iso.startsWith('0000-'), 'invalid_gen_time')
  const base = iso.slice(0, 19)
  return `${base}${fraction ? `.${fraction}` : ''}Z`
}

async function opensslVerify(args, reason) {
  try {
    await execFileAsync(OPENSSL, args, {
      env: { OPENSSL_CONF: '/dev/null', PATH: '/usr/bin:/bin' },
      shell: false,
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    })
  } catch (error) {
    if (error?.code === 'ETIMEDOUT' || error?.killed) fail('openssl_timeout')
    if (error?.code === 'ENOENT') fail('openssl_unavailable')
    fail(reason)
  }
}

/**
 * Returns only a supplied-pin verification result. Callers must establish the
 * root pin's origin and any independent artifact availability separately.
 */
export async function verifyRfc3161Witness({
  artifactBytes,
  queryDer,
  responseDer,
  chainPem,
  rootPem,
  expectedRootSha256,
  expectedPolicyOid,
} = {}) {
  let directory
  let result
  try {
    // Snapshot caller-owned mutable arrays before the first asynchronous step.
    const artifact = snapshotBytes(artifactBytes, 'artifact', LIMITS.artifact, true)
    const queryBytes = snapshotBytes(queryDer, 'query', LIMITS.query)
    const responseBytes = snapshotBytes(responseDer, 'response', LIMITS.response)
    parsePemCertificates(chainPem, 'chain_pem', 1, LIMITS.certificates)
    const [root] = parsePemCertificates(rootPem, 'root_pem', 1, 1)
    requireTrue(
      root.ca && root.checkIssued(root) && root.verify(root.publicKey),
      'invalid_root_pem',
    )
    const actualRootSha256 = createHash('sha256').update(root.raw).digest()
    requireTrue(
      timingSafeEqual(actualRootSha256, expectedFingerprint(expectedRootSha256)),
      'root_pin_mismatch',
    )
    requireTrue(expectedPolicyOid !== undefined, 'missing_expected_policy')
    requireTrue(
      typeof expectedPolicyOid === 'string' &&
        expectedPolicyOid.length <= 128 &&
        /^\d+(?:\.\d+)+$/.test(expectedPolicyOid),
      'invalid_expected_policy',
    )

    const artifactSha256 = createHash('sha256').update(artifact).digest()
    const query = parseQuery(queryBytes)
    const token = parseResponse(responseBytes)
    requireTrue(timingSafeEqual(query.imprint, artifactSha256), 'artifact_imprint_mismatch')
    requireTrue(timingSafeEqual(token.imprint, artifactSha256), 'token_imprint_mismatch')
    requireTrue(query.policyOid !== null, 'missing_request_policy')
    requireTrue(
      query.policyOid === expectedPolicyOid && token.policyOid === expectedPolicyOid,
      'policy_mismatch',
    )
    requireTrue(query.nonce === token.nonce, 'nonce_mismatch')

    directory = await mkdtemp(join(tmpdir(), 'holder-exit-rfc3161-'))
    const paths = Object.fromEntries(
      ['artifact', 'query', 'response', 'chain', 'root'].map((name) => [
        name,
        join(directory, name),
      ]),
    )
    // Serialize writes so a failed write cannot race the cleanup of this directory.
    for (const [name, bytes] of [
      ['artifact', artifact],
      ['query', queryBytes],
      ['response', responseBytes],
      ['chain', chainPem],
      ['root', rootPem],
    ]) {
      await writeFile(paths[name], bytes, { flag: 'wx', mode: 0o600 })
    }
    const common = [
      'ts',
      '-verify',
      '-in',
      paths.response,
      '-CAfile',
      paths.root,
      '-untrusted',
      paths.chain,
      '-verify_depth',
      String(LIMITS.certificates),
      '-auth_level',
      '2',
      '-attime',
      String(token.genTime.epochSeconds),
    ]
    await opensslVerify([...common, '-queryfile', paths.query], 'query_verification_failed')
    await opensslVerify([...common, '-data', paths.artifact], 'data_verification_failed')

    const accuracyMicros =
      token.accuracy.seconds * 1_000_000 + token.accuracy.millis * 1_000 + token.accuracy.micros
    const deviation = BigInt(accuracyMicros) * 1_000n
    result = {
      status: 'verified_under_supplied_pin',
      artifactSha256: artifactSha256.toString('hex'),
      rootSha256: actualRootSha256.toString('hex'),
      policyOid: token.policyOid,
      genTimeUtc: formatUtc(token.genTime.nanoseconds),
      accuracyMicros,
      intervalUtc: {
        earliest: formatUtc(token.genTime.nanoseconds - deviation),
        latest: formatUtc(token.genTime.nanoseconds + deviation),
      },
    }
  } catch (error) {
    result = {
      status: 'unverified',
      reason: error instanceof VerificationFailure ? error.reason : 'verification_error',
    }
  }
  if (directory) {
    try {
      await rm(directory, { recursive: true, force: true })
    } catch {
      return { status: 'unverified', reason: 'cleanup_failed' }
    }
  }
  return result
}
