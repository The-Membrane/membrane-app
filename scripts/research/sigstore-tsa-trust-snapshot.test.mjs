import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  captureSigstoreTsaTrustSnapshot,
  resolveDefaultTufClient,
} from './sigstore-tsa-trust-snapshot.mjs'

const SCRIPT = fileURLToPath(new URL('./sigstore-tsa-trust-snapshot.mjs', import.meta.url))
const OPENSSL = '/opt/homebrew/bin/openssl'
const fixtureDirectory = mkdtempSync('/private/tmp/sigstore-tsa-fixture-')
after(() => rmSync(fixtureDirectory, { recursive: true, force: true }))

function openssl(args) {
  execFileSync(OPENSSL, args, {
    cwd: fixtureDirectory,
    env: { OPENSSL_CONF: '/dev/null', PATH: '/usr/bin:/bin' },
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    stdio: 'pipe',
  })
}

openssl([
  'req',
  '-x509',
  '-newkey',
  'ec',
  '-pkeyopt',
  'ec_paramgen_curve:prime256v1',
  '-noenc',
  '-days',
  '2',
  '-subj',
  '/CN=Fixture Root',
  '-keyout',
  'root.key',
  '-out',
  'root.pem',
  '-addext',
  'basicConstraints=critical,CA:TRUE',
  '-addext',
  'keyUsage=critical,keyCertSign,cRLSign',
])
openssl([
  'req',
  '-new',
  '-newkey',
  'ec',
  '-pkeyopt',
  'ec_paramgen_curve:prime256v1',
  '-noenc',
  '-subj',
  '/CN=Fixture TSA',
  '-keyout',
  'leaf.key',
  '-out',
  'leaf.csr',
])
writeFileSync(
  join(fixtureDirectory, 'leaf.ext'),
  'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n',
)
openssl([
  'x509',
  '-req',
  '-in',
  'leaf.csr',
  '-CA',
  'root.pem',
  '-CAkey',
  'root.key',
  '-CAcreateserial',
  '-days',
  '2',
  '-extfile',
  'leaf.ext',
  '-out',
  'leaf.pem',
])

const leafDer = new X509Certificate(readFileSync(join(fixtureDirectory, 'leaf.pem'))).raw
const rootDer = new X509Certificate(readFileSync(join(fixtureDirectory, 'root.pem'))).raw

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value))
}

function metadata(type, version, extra = {}) {
  return {
    signatures: [],
    signed: {
      _type: type,
      spec_version: '1.0',
      version,
      expires: '2035-01-01T00:00:00Z',
      ...extra,
    },
  }
}

function testRoot(authorities = 1) {
  const authority = {
    subject: { organization: 'fixture.test', commonName: 'Fixture TSA' },
    uri: 'https://timestamp.sigstore.dev/api/v1/timestamp',
    certChain: {
      certificates: [leafDer, rootDer].map((bytes) => ({ rawBytes: bytes.toString('base64') })),
    },
    validFor: { start: '2020-01-01T00:00:00Z' },
  }
  return {
    mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
    timestampAuthorities: Array.from({ length: authorities }, () => structuredClone(authority)),
  }
}

function decodedRoot(rawRoot) {
  return {
    timestampAuthorities: rawRoot.timestampAuthorities.map((authority) => ({
      uri: authority.uri,
      subject: authority.subject,
      certChain: {
        certificates: authority.certChain.certificates.map((certificate) => ({
          rawBytes: Uint8Array.from(Buffer.from(certificate.rawBytes, 'base64')),
        })),
      },
    })),
  }
}

async function makeCache(
  cachePath,
  rawRoot,
  { corruptTargetHash = false, oversized = false } = {},
) {
  const repository = join(cachePath, 'tuf-repo-cdn.sigstore.dev')
  await mkdir(join(repository, 'targets'), { recursive: true })
  const targetBytes = jsonBytes(rawRoot)
  const targetHash = corruptTargetHash ? '0'.repeat(64) : sha256(targetBytes)
  const targetsBytes = jsonBytes(
    metadata('targets', 4, {
      targets: {
        'trusted_root.json': {
          length: targetBytes.length,
          hashes: { sha256: targetHash },
        },
      },
    }),
  )
  const snapshotBytes = jsonBytes(
    metadata('snapshot', 3, {
      meta: {
        'targets.json': {
          version: 4,
          length: targetsBytes.length,
          hashes: { sha256: sha256(targetsBytes) },
        },
      },
    }),
  )
  const timestampBytes = jsonBytes(
    metadata('timestamp', 5, {
      meta: {
        'snapshot.json': {
          version: 3,
          length: snapshotBytes.length,
          hashes: { sha256: sha256(snapshotBytes) },
        },
      },
    }),
  )
  await Promise.all([
    writeFile(join(repository, 'root.json'), jsonBytes(metadata('root', 2))),
    writeFile(join(repository, 'timestamp.json'), timestampBytes),
    writeFile(join(repository, 'snapshot.json'), snapshotBytes),
    writeFile(join(repository, 'targets.json'), targetsBytes),
    writeFile(join(repository, 'targets', 'trusted_root.json'), targetBytes),
  ])
  if (oversized) await writeFile(join(repository, 'extra'), Buffer.alloc(1024 * 1024 + 1))
}

async function withFixture(run, options = {}) {
  const directory = mkdtempSync('/private/tmp/sigstore-tsa-test-')
  const outputPath = join(directory, 'candidate', 'candidate.json')
  const rawRoot = options.rawRoot ?? testRoot()
  let cachePath
  let callOptions
  const loadTuf = async () => ({
    getTrustedRoot: async (received) => {
      callOptions = received
      cachePath = received.cachePath
      await makeCache(cachePath, rawRoot, options)
      return options.decodedRoot ?? decodedRoot(rawRoot)
    },
  })
  try {
    await run({
      outputPath,
      loadTuf,
      rawRoot,
      getCachePath: () => cachePath,
      getCallOptions: () => callOptions,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('requires the explicit --capture flag before any TUF request', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage: .* --capture/)
})

test('resolves the audited npm-bundled TUF client without making a request', async () => {
  const client = await resolveDefaultTufClient()
  assert.equal(typeof client.getTrustedRoot, 'function')
  assert.equal(client.provenance.name, '@sigstore/tuf')
  assert.equal(client.provenance.version, '3.1.1')
  assert.equal(client.provenance.source, 'npm_bundled_global')
  assert.equal(
    client.provenance.packageLocation,
    '/opt/homebrew/lib/node_modules/npm/node_modules/@sigstore/tuf',
  )
  assert.equal(sha256(Buffer.from(client.seedRootJson)), client.provenance.seedRootSha256)
  assert.match(client.provenance.entrySha256, /^[a-f\d]{64}$/)
})

test('writes a bounded candidate tied to the TUF target and cleans the fresh cache', async () => {
  await withFixture(async ({ outputPath, loadTuf, rawRoot, getCachePath, getCallOptions }) => {
    const { candidate } = await captureSigstoreTsaTrustSnapshot({ loadTuf, outputPath })
    const bytes = readFileSync(outputPath)
    assert.ok(bytes.length < 256 * 1024)
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), candidate)
    assert.equal(candidate.status, 'candidate_local_tuf_client_result')
    assert.equal(candidate.offlineTufReplay, false)
    assert.equal(candidate.rootProvenanceGateSatisfied, false)
    assert.equal(candidate.source.tufClient.source, 'injected_loader')
    assert.equal(candidate.tuf.target.sha256, sha256(jsonBytes(rawRoot)))
    assert.equal(candidate.tuf.target.targetsMetadataVersion, 4)
    assert.equal(candidate.tuf.metadata.timestamp.version, 5)
    assert.equal(candidate.timestampAuthority.leaf.sha256, sha256(leafDer))
    assert.equal(candidate.timestampAuthority.root.sha256, sha256(rootDer))
    assert.equal(candidate.timestampAuthority.leaf.derBase64, leafDer.toString('base64'))
    assert.equal(candidate.timestampAuthority.root.derBase64, rootDer.toString('base64'))
    assert.equal(candidate.trustedRoot.timestampAuthorities.length, 1)
    assert.equal(sha256(Buffer.from(candidate.trustedRootJson)), candidate.tuf.target.sha256)
    for (const [name, metadata] of Object.entries(candidate.tuf.metadata)) {
      assert.equal(sha256(Buffer.from(candidate.tuf.signedMetadataJson[name])), metadata.sha256)
    }
    assert.equal(candidate.tuf.bootstrap, null)
    assert.ok(!bytes.includes(Buffer.from('independently_witnessed_utc')))
    assert.ok(!bytes.includes(Buffer.from('tuf_authenticated')))
    assert.ok(!existsSync(getCachePath()))
    assert.match(getCachePath(), /^\/private\/tmp\/sigstore-tsa-tuf-/)
    assert.equal(getCallOptions().mirrorURL, 'https://tuf-repo-cdn.sigstore.dev')
    assert.equal(getCallOptions().rootPath, undefined)
    assert.equal(getCallOptions().forceCache, false)
  })
})

test('rejects multiple timestamp authorities without writing a candidate', async () => {
  await withFixture(
    async ({ outputPath, loadTuf, getCachePath }) => {
      await assert.rejects(
        captureSigstoreTsaTrustSnapshot({ loadTuf, outputPath }),
        /expected_one_timestamp_authority/,
      )
      assert.ok(!existsSync(outputPath))
      assert.ok(!existsSync(getCachePath()))
    },
    { rawRoot: testRoot(2) },
  )
})

test('rejects a target whose bytes differ from TUF target metadata', async () => {
  await withFixture(
    async ({ outputPath, loadTuf, getCachePath }) => {
      await assert.rejects(
        captureSigstoreTsaTrustSnapshot({ loadTuf, outputPath }),
        /target_hash_mismatch/,
      )
      assert.ok(!existsSync(outputPath))
      assert.ok(!existsSync(getCachePath()))
    },
    { corruptTargetHash: true },
  )
})

test('rejects oversized TUF cache before writing a candidate', async () => {
  await withFixture(
    async ({ outputPath, loadTuf, getCachePath }) => {
      await assert.rejects(
        captureSigstoreTsaTrustSnapshot({ loadTuf, outputPath }),
        /cache_size_limit/,
      )
      assert.ok(!existsSync(outputPath))
      assert.ok(!existsSync(getCachePath()))
    },
    { oversized: true },
  )
})

test('rejects a decoded TUF result that differs from the cached target', async () => {
  const rawRoot = testRoot()
  const decoded = decodedRoot(rawRoot)
  decoded.timestampAuthorities[0].certChain.certificates[0].rawBytes = rootDer
  await withFixture(
    async ({ outputPath, loadTuf, getCachePath }) => {
      await assert.rejects(
        captureSigstoreTsaTrustSnapshot({ loadTuf, outputPath }),
        /certificate_0_differs_from_tuf_result/,
      )
      assert.ok(!existsSync(outputPath))
      assert.ok(!existsSync(getCachePath()))
    },
    { rawRoot, decodedRoot: decoded },
  )
})
