import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  publishRfc3161Sidecar,
  Rfc3161PublicationError,
} from './holder-exit-rfc3161-publication.mjs'

const TSA_URL = 'https://timestamp.sigstore.dev/api/v1/timestamp'
const POLICY = '1.3.6.1.4.1.57264.2'
const SHA256_OID = '2.16.840.1.101.3.4.2.1'
const SIGNED_DATA_OID = '1.2.840.113549.1.7.2'

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function der(tag, content) {
  const bytes = Buffer.from(content)
  const length =
    bytes.length < 128
      ? Buffer.from([bytes.length])
      : Buffer.from([0x82, bytes.length >> 8, bytes.length & 255])
  return Buffer.concat([Buffer.from([tag]), length, bytes])
}

function oid(value) {
  const arcs = value.split('.').map(BigInt)
  const values = [arcs[0] * 40n + arcs[1], ...arcs.slice(2)]
  const encoded = []
  for (const value of values) {
    const groups = [Number(value & 127n)]
    for (let remaining = value >> 7n; remaining > 0n; remaining >>= 7n)
      groups.unshift(Number(remaining & 127n) | 128)
    encoded.push(...groups)
  }
  return der(0x06, encoded)
}

function queryFor(artifactSha256, policyOid) {
  return der(
    0x30,
    Buffer.concat([
      der(0x02, [1]),
      der(
        0x30,
        Buffer.concat([
          der(0x30, Buffer.concat([oid(SHA256_OID), der(0x05, [])])),
          der(0x04, Buffer.from(artifactSha256, 'hex')),
        ]),
      ),
      oid(policyOid),
      der(0x02, [1]),
      der(0x01, [0xff]),
    ]),
  )
}

// Only an envelope fixture. It deliberately is not a signed TSA token; a
// publication sidecar makes no verification or independent-clock claim.
const RESPONSE = der(
  0x30,
  Buffer.concat([
    der(0x30, der(0x02, [0])),
    der(0x30, Buffer.concat([oid(SIGNED_DATA_OID), der(0xa0, der(0x30, []))])),
  ]),
)

function fixture(t, artifactBytes = Buffer.from('final bytes\n')) {
  const directory = mkdtempSync(join(tmpdir(), 'holder-exit-tsa-publication-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const artifactPath = join(directory, 'issue.json')
  writeFileSync(artifactPath, artifactBytes)
  const sidecarPath = `${artifactPath}.rfc3161-witness`
  const input = { artifactPath, tsaUrl: TSA_URL, policyOid: POLICY }
  return { artifactPath, sidecarPath, input }
}

function injected(overrides = {}) {
  const ticks = [new Date('2026-10-04T23:00:00.000Z'), new Date('2026-10-04T23:00:01.000Z')]
  return {
    opensslQuery: async ({ artifactSha256, policyOid }) => queryFor(artifactSha256, policyOid),
    transport: async () => RESPONSE,
    diskReserve: () => {},
    clock: () => ticks.shift(),
    ...overrides,
  }
}

test('retains exact query/response DER and labels local times untrusted', async (t) => {
  const { artifactPath, sidecarPath, input } = fixture(t, Buffer.from('{"a":1}\n'))
  let submitted
  const result = await publishRfc3161Sidecar(
    input,
    injected({
      transport: async (request) => {
        submitted = request
        return RESPONSE
      },
    }),
  )
  const row = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  assert.equal(result.status, 'pending_trust_root')
  assert.equal(result.sidecarPath, sidecarPath)
  assert.equal(row.status, 'pending_trust_root')
  assert.equal(row.trustedUtc, null)
  assert.equal(row.localClockStatus, 'observed_untrusted')
  assert.equal(row.artifact.filename, 'issue.json')
  assert.equal(row.artifact.sha256, hash(readFileSync(artifactPath)))
  assert.equal(row.artifact.byteLength, 8)
  assert.equal(row.request.policyOid, POLICY)
  assert.equal(row.request.tsaUrl, TSA_URL)
  assert.equal(row.request.contentType, 'application/timestamp-query')
  assert.equal(row.response.contentType, 'application/timestamp-reply')
  assert.equal(row.request.sentAtLocalUtc, '2026-10-04T23:00:00.000Z')
  assert.equal(row.response.receivedAtLocalUtc, '2026-10-04T23:00:01.000Z')
  assert.deepEqual(Buffer.from(row.request.derBase64, 'base64'), submitted.queryDer)
  assert.deepEqual(Buffer.from(row.response.derBase64, 'base64'), RESPONSE)
  assert.equal(row.request.sha256, hash(submitted.queryDer))
  assert.equal(row.response.sha256, hash(RESPONSE))
  assert.equal(submitted.url.toString(), TSA_URL)
  assert.equal(submitted.timeoutMs, 15_000)
  assert.equal(submitted.maxBytes, 1024 * 1024)
  assert.equal(readFileSync(sidecarPath, 'utf8').endsWith('\n'), true)
  assert.equal(sidecarPath.endsWith('.json'), false)
  assert.equal(statSync(sidecarPath).mode & 0o777, 0o444)
})

test('exact file digest distinguishes a trailing newline', async (t) => {
  const without = fixture(t, Buffer.from('{"a":1}'))
  const withNewline = fixture(t, Buffer.from('{"a":1}\n'))
  await publishRfc3161Sidecar(without.input, injected())
  await publishRfc3161Sidecar(withNewline.input, injected())
  const first = JSON.parse(readFileSync(without.sidecarPath, 'utf8'))
  const second = JSON.parse(readFileSync(withNewline.sidecarPath, 'utf8'))
  assert.equal(first.artifact.sha256, hash(Buffer.from('{"a":1}')))
  assert.equal(second.artifact.sha256, hash(Buffer.from('{"a":1}\n')))
  assert.notEqual(first.artifact.sha256, second.artifact.sha256)
  assert.notDeepEqual(first.request.derBase64, second.request.derBase64)
})

test('a failed TSA request leaves the durable artifact and no sidecar', async (t) => {
  const { artifactPath, sidecarPath, input } = fixture(t)
  await assert.rejects(
    publishRfc3161Sidecar(
      input,
      injected({
        transport: async () => {
          throw new Error('secret remote response')
        },
      }),
    ),
    (error) =>
      error instanceof Rfc3161PublicationError &&
      error.code === 'tsa_request_failed' &&
      error.artifactUnaffected === true &&
      !error.message.includes('secret'),
  )
  assert.equal(existsSync(sidecarPath), false)
  assert.equal(readFileSync(artifactPath, 'utf8'), 'final bytes\n')
})

test('an existing sidecar is never repaired, overwritten, or resubmitted', async (t) => {
  const { sidecarPath, input } = fixture(t)
  writeFileSync(sidecarPath, 'old witness bytes')
  let calls = 0
  await assert.rejects(
    publishRfc3161Sidecar(
      input,
      injected({
        opensslQuery: async () => {
          calls += 1
          return Buffer.alloc(0)
        },
        transport: async () => {
          calls += 1
          return RESPONSE
        },
      }),
    ),
    (error) => error.code === 'sidecar_exists' && error.sidecarStatus === 'existing',
  )
  assert.equal(calls, 0)
  assert.equal(readFileSync(sidecarPath, 'utf8'), 'old witness bytes')
})

test('oversize artifact is rejected before query or network activity', async (t) => {
  const { artifactPath, sidecarPath, input } = fixture(t)
  truncateSync(artifactPath, 64 * 1024 * 1024 + 1)
  let calls = 0
  await assert.rejects(
    publishRfc3161Sidecar(
      input,
      injected({
        opensslQuery: async () => {
          calls += 1
        },
        transport: async () => {
          calls += 1
        },
      }),
    ),
    (error) => error.code === 'artifact_oversize',
  )
  assert.equal(calls, 0)
  assert.equal(existsSync(sidecarPath), false)
})

test('changed artifact and oversized response do not get a sidecar', async (t) => {
  const changed = fixture(t)
  await assert.rejects(
    publishRfc3161Sidecar(
      changed.input,
      injected({
        transport: async () => {
          writeFileSync(changed.artifactPath, 'replaced bytes\n')
          return RESPONSE
        },
      }),
    ),
    (error) => error.code === 'artifact_changed',
  )
  assert.equal(existsSync(changed.sidecarPath), false)

  const oversized = fixture(t)
  await assert.rejects(
    publishRfc3161Sidecar(
      oversized.input,
      injected({ transport: async () => Buffer.alloc(1024 * 1024 + 1) }),
    ),
    (error) => error.code === 'response_size',
  )
  assert.equal(existsSync(oversized.sidecarPath), false)
})

test('mutation during the final disk check is caught before linking a sidecar', async (t) => {
  const { input, artifactPath, sidecarPath } = fixture(t)
  let checks = 0
  await assert.rejects(
    publishRfc3161Sidecar(
      input,
      injected({
        diskReserve: () => {
          checks += 1
          if (checks === 2) writeFileSync(artifactPath, 'changed in reserve check\n')
        },
      }),
    ),
    (error) => error.code === 'artifact_changed' && error.artifactUnaffected === true,
  )
  assert.equal(checks, 2)
  assert.equal(existsSync(sidecarPath), false)
})

test('bad or regressed local clocks retain valid DER as untrusted evidence', async (t) => {
  const unavailable = fixture(t)
  let tick = 0
  await publishRfc3161Sidecar(
    unavailable.input,
    injected({
      clock: () => {
        tick += 1
        if (tick === 2) throw new Error('local clock failure')
        return new Date('2026-10-04T23:00:00.000Z')
      },
    }),
  )
  const missing = JSON.parse(readFileSync(unavailable.sidecarPath, 'utf8'))
  assert.equal(missing.localClockStatus, 'unavailable')
  assert.equal(missing.request.sentAtLocalUtc, '2026-10-04T23:00:00.000Z')
  assert.equal(missing.response.receivedAtLocalUtc, null)
  assert.deepEqual(Buffer.from(missing.response.derBase64, 'base64'), RESPONSE)

  const regressed = fixture(t)
  const dates = [new Date('2026-10-04T23:00:02.000Z'), new Date('2026-10-04T23:00:00.000Z')]
  await publishRfc3161Sidecar(regressed.input, injected({ clock: () => dates.shift() }))
  const backwards = JSON.parse(readFileSync(regressed.sidecarPath, 'utf8'))
  assert.equal(backwards.localClockStatus, 'regressed')
  assert.equal(backwards.request.sentAtLocalUtc, '2026-10-04T23:00:02.000Z')
  assert.equal(backwards.response.receivedAtLocalUtc, '2026-10-04T23:00:00.000Z')
  assert.deepEqual(Buffer.from(backwards.response.derBase64, 'base64'), RESPONSE)
})

test('a non-granted TSA envelope is not published as a witness', async (t) => {
  const { input, sidecarPath } = fixture(t)
  const rejected = der(0x30, der(0x30, der(0x02, [2])))
  await assert.rejects(
    publishRfc3161Sidecar(input, injected({ transport: async () => rejected })),
    (error) => error.code === 'tsa_not_granted' && error.artifactUnaffected === true,
  )
  assert.equal(existsSync(sidecarPath), false)
})

test('HTTPS transport accepts documented 201 and rejects redirects without following them', async (t) => {
  function fakeHttps(statusCode, observation) {
    return (url, options, onResponse) => {
      const request = new EventEmitter()
      request.destroy = () => {}
      request.end = (body) => {
        observation.url = url.toString()
        observation.options = options
        observation.body = body
        queueMicrotask(() => {
          const response = new EventEmitter()
          response.statusCode = statusCode
          response.headers = { 'content-type': 'application/timestamp-reply' }
          onResponse(response)
          if (statusCode === 201)
            queueMicrotask(() => {
              response.emit('data', RESPONSE)
              response.emit('end')
            })
        })
      }
      return request
    }
  }

  const accepted = fixture(t)
  const sent = {}
  const result = await publishRfc3161Sidecar(accepted.input, {
    ...injected(),
    transport: undefined,
    httpsRequest: fakeHttps(201, sent),
  })
  assert.equal(result.status, 'pending_trust_root')
  assert.equal(sent.url, TSA_URL)
  assert.equal(sent.options.method, 'POST')
  assert.equal(sent.options.headers['Content-Type'], 'application/timestamp-query')
  assert.equal(sent.options.headers.Accept, 'application/timestamp-reply')
  assert.deepEqual(
    sent.body,
    Buffer.from(JSON.parse(readFileSync(accepted.sidecarPath, 'utf8')).request.derBase64, 'base64'),
  )

  const redirected = fixture(t)
  const blocked = {}
  await assert.rejects(
    publishRfc3161Sidecar(redirected.input, {
      ...injected(),
      transport: undefined,
      httpsRequest: fakeHttps(302, blocked),
    }),
    (error) => error.code === 'tsa_http_status',
  )
  assert.equal(blocked.url, TSA_URL)
  assert.equal(existsSync(redirected.sidecarPath), false)
})

test('userinfo, query secrets and non-HTTPS endpoints are rejected before publication', async (t) => {
  const { input, sidecarPath } = fixture(t)
  for (const tsaUrl of [
    'https://user:password@timestamp.sigstore.dev/api/v1/timestamp',
    'https://timestamp.sigstore.dev/api/v1/timestamp?api_key=secret',
    'http://timestamp.sigstore.dev/api/v1/timestamp',
  ]) {
    await assert.rejects(
      publishRfc3161Sidecar({ ...input, tsaUrl }, injected()),
      (error) => error.code === 'tsa_url_invalid',
    )
  }
  assert.equal(existsSync(sidecarPath), false)
})

test('real OpenSSL query includes nonce, explicit policy and exact SHA-256 imprint', async (t) => {
  const { input, sidecarPath } = fixture(t)
  const result = await publishRfc3161Sidecar(input, {
    ...injected(),
    opensslQuery: undefined,
  })
  const row = JSON.parse(readFileSync(sidecarPath, 'utf8'))
  assert.equal(result.status, 'pending_trust_root')
  assert.equal(row.artifact.sha256, hash(Buffer.from('final bytes\n')))
  assert.ok(Buffer.from(row.request.derBase64, 'base64').length > 0)
})
