// Opt-in RFC 3161 publication of an already-durable artifact's exact bytes.
// This sidecar is untrusted evidence until an independent root and token replay
// establish a clock. Never use its local timestamps as verified UTC.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import https from 'node:https'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const OPENSSL = '/opt/homebrew/bin/openssl'
const SHA256_OID = '2.16.840.1.101.3.4.2.1'
const SIGNED_DATA_OID = '1.2.840.113549.1.7.2'
const CONTENT_TYPE_QUERY = 'application/timestamp-query'
const CONTENT_TYPE_REPLY = 'application/timestamp-reply'
const RESERVE_BYTES = 1024n * 1024n * 1024n
const LIMITS = Object.freeze({
  artifactBytes: 64 * 1024 * 1024,
  queryBytes: 64 * 1024,
  responseBytes: 1024 * 1024,
  sidecarBytes: 1536 * 1024,
  timeoutMs: 15_000,
})

export class Rfc3161PublicationError extends Error {
  constructor(code, sidecarStatus = 'absent') {
    super(code)
    this.name = 'Rfc3161PublicationError'
    this.code = code
    this.artifactUnaffected = true
    this.sidecarStatus = sidecarStatus
  }
}

function fail(code, sidecarStatus) {
  throw new Rfc3161PublicationError(code, sidecarStatus)
}

function requireTrue(condition, code) {
  if (!condition) fail(code)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function snapshotBytes(value, maximum, label) {
  requireTrue(Buffer.isBuffer(value) || value instanceof Uint8Array, `${label}_invalid`)
  requireTrue(value.byteLength > 0 && value.byteLength <= maximum, `${label}_size`)
  return Buffer.from(value)
}

function readNode(bytes, offset, end) {
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
  return { tag, contentStart: cursor, contentEnd: cursor + length, end: cursor + length }
}

function fields(bytes, node) {
  const out = []
  for (let cursor = node.contentStart; cursor < node.contentEnd; ) {
    const child = readNode(bytes, cursor, node.contentEnd)
    out.push(child)
    cursor = child.end
  }
  return out
}

function sequence(bytes) {
  const root = readNode(bytes, 0, bytes.length)
  requireTrue(root.tag === 0x30 && root.end === bytes.length, 'invalid_der')
  return fields(bytes, root)
}

function integer(bytes, node, maximum = 32) {
  requireTrue(node?.tag === 0x02, 'invalid_der')
  const raw = bytes.subarray(node.contentStart, node.contentEnd)
  requireTrue(raw.length > 0 && raw.length <= maximum && !(raw[0] & 0x80), 'invalid_der')
  requireTrue(raw.length === 1 || raw[0] !== 0 || Boolean(raw[1] & 0x80), 'invalid_der')
  let value = 0n
  for (const byte of raw) value = (value << 8n) | BigInt(byte)
  return value
}

function oid(bytes, node) {
  requireTrue(node?.tag === 0x06, 'invalid_der')
  const raw = bytes.subarray(node.contentStart, node.contentEnd)
  requireTrue(raw.length > 0 && raw.length <= 64, 'invalid_der')
  const arcs = []
  for (let i = 0; i < raw.length; ) {
    requireTrue(raw[i] !== 0x80, 'invalid_der')
    let arc = 0n
    let count = 0
    for (;;) {
      requireTrue(i < raw.length && count < 10, 'invalid_der')
      const byte = raw[i++]
      arc = (arc << 7n) | BigInt(byte & 0x7f)
      count += 1
      if (!(byte & 0x80)) break
    }
    arcs.push(arc)
  }
  const first = arcs.shift()
  const major = first < 40n ? 0n : first < 80n ? 1n : 2n
  return [major, first - major * 40n, ...arcs].join('.')
}

function inspectQuery(bytes, artifactSha256, policyOid) {
  const query = sequence(bytes)
  requireTrue(query.length === 5 && integer(bytes, query[0], 2) === 1n, 'invalid_query')
  requireTrue(query[1].tag === 0x30, 'invalid_query')
  const imprint = fields(bytes, query[1])
  requireTrue(imprint.length === 2 && imprint[0].tag === 0x30, 'invalid_query')
  const algorithm = fields(bytes, imprint[0])
  requireTrue(algorithm.length >= 1 && algorithm.length <= 2, 'invalid_query')
  requireTrue(oid(bytes, algorithm[0]) === SHA256_OID, 'query_digest_algorithm')
  if (algorithm.length === 2)
    requireTrue(
      algorithm[1].tag === 0x05 && algorithm[1].contentStart === algorithm[1].contentEnd,
      'invalid_query',
    )
  const hash = imprint[1]
  requireTrue(hash.tag === 0x04 && hash.contentEnd - hash.contentStart === 32, 'invalid_query')
  requireTrue(
    bytes.subarray(hash.contentStart, hash.contentEnd).toString('hex') === artifactSha256,
    'query_imprint_mismatch',
  )
  requireTrue(oid(bytes, query[2]) === policyOid, 'query_policy_mismatch')
  requireTrue(integer(bytes, query[3]) > 0n, 'query_nonce_missing')
  requireTrue(
    query[4].tag === 0x01 &&
      query[4].contentEnd - query[4].contentStart === 1 &&
      bytes[query[4].contentStart] === 0xff,
    'query_certificate_request_missing',
  )
}

function inspectResponseEnvelope(bytes) {
  const response = sequence(bytes)
  requireTrue(
    response.length >= 1 && response.length <= 2 && response[0].tag === 0x30,
    'invalid_response',
  )
  const status = fields(bytes, response[0])
  requireTrue(status.length >= 1 && integer(bytes, status[0], 2) === 0n, 'tsa_not_granted')
  requireTrue(response.length === 2, 'invalid_response')
  requireTrue(response[1].tag === 0x30, 'invalid_response')
  const content = fields(bytes, response[1])
  requireTrue(
    content.length === 2 && oid(bytes, content[0]) === SIGNED_DATA_OID && content[1].tag === 0xa0,
    'invalid_response',
  )
  requireTrue(content[1].contentEnd > content[1].contentStart, 'invalid_response')
}

function tsaEndpoint(value) {
  requireTrue(typeof value === 'string' && value.length <= 2048, 'tsa_url_invalid')
  let url
  try {
    url = new URL(value)
  } catch {
    fail('tsa_url_invalid')
  }
  // No credentials or opaque query material can enter the sidecar or request.
  requireTrue(
    url.protocol === 'https:' &&
      url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'tsa_url_invalid',
  )
  return url
}

function validatePolicy(value) {
  requireTrue(
    typeof value === 'string' && value.length <= 128 && /^[012]\.\d+(?:\.\d+)+$/.test(value),
    'policy_invalid',
  )
  return value
}

function readDurableArtifact(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = fstatSync(fd, { bigint: true })
    requireTrue(before.isFile(), 'artifact_not_regular')
    requireTrue(before.size <= BigInt(LIMITS.artifactBytes), 'artifact_oversize')
    fsyncSync(fd)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let remaining = Number(before.size)
    while (remaining > 0) {
      const read = readSync(fd, buffer, 0, Math.min(remaining, buffer.length), null)
      requireTrue(read > 0, 'artifact_changed')
      hash.update(buffer.subarray(0, read))
      remaining -= read
    }
    requireTrue(readSync(fd, buffer, 0, 1, null) === 0, 'artifact_changed')
    const after = fstatSync(fd, { bigint: true })
    requireTrue(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
      'artifact_changed',
    )
    return { byteLength: Number(before.size), sha256: hash.digest('hex') }
  } catch (error) {
    if (error instanceof Rfc3161PublicationError) throw error
    fail('artifact_read_failed')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function sidecarExists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    fail('sidecar_preflight_failed')
  }
}

function requireDiskReserve(directory, writeBytes) {
  try {
    const disk = statfsSync(directory, { bigint: true })
    requireTrue(disk.bavail * disk.bsize - BigInt(writeBytes) >= RESERVE_BYTES, 'disk_reserve')
  } catch (error) {
    if (error instanceof Rfc3161PublicationError) throw error
    fail('disk_check_failed')
  }
}

async function defaultOpenSslQuery({ artifactSha256, policyOid }) {
  try {
    const { stdout } = await execFileAsync(
      OPENSSL,
      ['ts', '-query', '-digest', artifactSha256, '-sha256', '-tspolicy', policyOid, '-cert'],
      {
        env: { OPENSSL_CONF: '/dev/null', PATH: '/usr/bin:/bin' },
        encoding: 'buffer',
        shell: false,
        timeout: 10_000,
        maxBuffer: LIMITS.queryBytes,
        windowsHide: true,
      },
    )
    return stdout
  } catch {
    fail('openssl_query_failed')
  }
}

function defaultTransport({ url, queryDer, timeoutMs, maxBytes, httpsRequest = https.request }) {
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false
    const finish = (error, response, request, timer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        request.destroy()
        rejectResponse(new Rfc3161PublicationError(error))
      } else resolveResponse(response)
    }
    const request = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': CONTENT_TYPE_QUERY,
          Accept: CONTENT_TYPE_REPLY,
          'Content-Length': String(queryDer.length),
        },
        maxHeaderSize: 8 * 1024,
      },
      (response) => {
        if (response.statusCode !== 200 && response.statusCode !== 201) {
          finish('tsa_http_status', null, request, timer)
          return
        }
        const contentType = String(response.headers['content-type'] ?? '')
          .split(';', 1)[0]
          .trim()
          .toLowerCase()
        if (contentType !== CONTENT_TYPE_REPLY) {
          finish('tsa_content_type', null, request, timer)
          return
        }
        const chunks = []
        let length = 0
        response.on('data', (chunk) => {
          length += chunk.length
          if (length > maxBytes) {
            finish('tsa_response_oversize', null, request, timer)
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => finish(null, Buffer.concat(chunks), request, timer))
        response.on('error', () => finish('tsa_request_failed', null, request, timer))
      },
    )
    const timer = setTimeout(() => finish('tsa_timeout', null, request, timer), timeoutMs)
    request.on('error', () => finish('tsa_request_failed', null, request, timer))
    request.end(queryDer)
  })
}

function localTime(clock) {
  try {
    const value = clock()
    return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null
  } catch {
    return null
  }
}

function appendSidecar(path, bytes) {
  const directoryPath = dirname(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  let tempCreated = false
  let linked = false
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    tempCreated = true
    try {
      for (let offset = 0; offset < bytes.length; ) offset += writeSync(fd, bytes, offset)
      fchmodSync(fd, 0o444)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    linkSync(temporary, path)
    linked = true
    const directory = openSync(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  } catch (error) {
    if (error?.code === 'EEXIST') fail('sidecar_exists', 'existing')
    fail(
      linked ? 'sidecar_commit_uncertain' : 'sidecar_write_failed',
      linked ? 'uncertain' : 'absent',
    )
  } finally {
    if (tempCreated) {
      try {
        unlinkSync(temporary)
      } catch {
        // A committed sidecar is never repaired or overwritten here.
      }
    }
  }
}

/**
 * Call only after the artifact and its directory were durably published.
 * Failures concern this optional sidecar and never invalidate that artifact.
 */
export async function publishRfc3161Sidecar(
  { artifactPath, sidecarPath, tsaUrl, policyOid },
  {
    opensslQuery = defaultOpenSslQuery,
    transport = defaultTransport,
    httpsRequest = https.request,
    clock = () => new Date(),
    diskReserve = requireDiskReserve,
  } = {},
) {
  requireTrue(typeof artifactPath === 'string' && artifactPath.length > 0, 'artifact_path_invalid')
  const artifact = resolve(artifactPath)
  const sidecar = sidecarPath ? resolve(sidecarPath) : `${artifact}.rfc3161-witness`
  requireTrue(sidecar !== artifact && !sidecar.endsWith('.json'), 'sidecar_path_invalid')
  const endpoint = tsaEndpoint(tsaUrl)
  const policy = validatePolicy(policyOid)
  if (sidecarExists(sidecar)) fail('sidecar_exists', 'existing')
  diskReserve(dirname(sidecar), LIMITS.sidecarBytes)
  const file = readDurableArtifact(artifact)
  let queryDer
  try {
    queryDer = snapshotBytes(
      await opensslQuery({ artifactSha256: file.sha256, policyOid: policy }),
      LIMITS.queryBytes,
      'query',
    )
    inspectQuery(queryDer, file.sha256, policy)
  } catch (error) {
    if (error instanceof Rfc3161PublicationError) throw error
    fail('openssl_query_failed')
  }
  const sentAtLocalUtc = localTime(clock)
  let responseDer
  try {
    responseDer = snapshotBytes(
      await transport({
        url: endpoint,
        queryDer,
        timeoutMs: LIMITS.timeoutMs,
        maxBytes: LIMITS.responseBytes,
        httpsRequest,
      }),
      LIMITS.responseBytes,
      'response',
    )
    inspectResponseEnvelope(responseDer)
  } catch (error) {
    if (error instanceof Rfc3161PublicationError) throw error
    fail('tsa_request_failed')
  }
  const receivedAtLocalUtc = localTime(clock)
  const localClockStatus =
    sentAtLocalUtc === null || receivedAtLocalUtc === null
      ? 'unavailable'
      : receivedAtLocalUtc < sentAtLocalUtc
        ? 'regressed'
        : 'observed_untrusted'
  const record = {
    schema: 'holder_exit_rfc3161_publication_v1',
    status: 'pending_trust_root',
    trustedUtc: null,
    localClockStatus,
    artifact: { filename: basename(artifact), byteLength: file.byteLength, sha256: file.sha256 },
    request: {
      tsaUrl: endpoint.toString(),
      policyOid: policy,
      contentType: CONTENT_TYPE_QUERY,
      sentAtLocalUtc,
      derBase64: queryDer.toString('base64'),
      sha256: sha256(queryDer),
    },
    response: {
      contentType: CONTENT_TYPE_REPLY,
      receivedAtLocalUtc,
      derBase64: responseDer.toString('base64'),
      sha256: sha256(responseDer),
    },
  }
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`)
  requireTrue(bytes.length <= LIMITS.sidecarBytes, 'sidecar_oversize')
  diskReserve(dirname(sidecar), bytes.length)
  // A local path can change during TSA network time or the final reserve
  // check. This check narrows that race; offline replay must still reopen the
  // artifact because later path mutation cannot be excluded here.
  const finalFile = readDurableArtifact(artifact)
  requireTrue(
    finalFile.byteLength === file.byteLength && finalFile.sha256 === file.sha256,
    'artifact_changed',
  )
  appendSidecar(sidecar, bytes)
  let committedFile
  try {
    committedFile = readDurableArtifact(artifact)
  } catch {
    fail('sidecar_commit_uncertain', 'uncertain')
  }
  if (committedFile.byteLength !== file.byteLength || committedFile.sha256 !== file.sha256)
    fail('sidecar_commit_uncertain', 'uncertain')
  return { status: record.status, sidecarPath: sidecar, artifactSha256: file.sha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flags = new Map()
  if (args[0] !== '--publish' || (args.length - 1) % 2 !== 0) {
    console.error(
      'Usage: node holder-exit-rfc3161-publication.mjs --publish --artifact PATH --tsa-url HTTPS_URL --policy OID [--sidecar PATH]',
    )
    process.exitCode = 2
  } else {
    for (let i = 1; i < args.length; i += 2) flags.set(args[i], args[i + 1])
    if (
      [...flags.keys()].some(
        (key) => !['--artifact', '--tsa-url', '--policy', '--sidecar'].includes(key),
      ) ||
      !flags.has('--artifact') ||
      !flags.has('--tsa-url') ||
      !flags.has('--policy')
    ) {
      console.error('publication_arguments_invalid')
      process.exitCode = 2
    } else {
      publishRfc3161Sidecar({
        artifactPath: flags.get('--artifact'),
        sidecarPath: flags.get('--sidecar'),
        tsaUrl: flags.get('--tsa-url'),
        policyOid: flags.get('--policy'),
      })
        .then((result) => console.log(JSON.stringify(result)))
        .catch((error) => {
          console.error(
            error instanceof Rfc3161PublicationError ? error.code : 'publication_failed',
          )
          process.exitCode = 1
        })
    }
  }
}
