import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyRfc3161Witness } from './holder-exit-rfc3161-witness.mjs'

const OPENSSL = '/opt/homebrew/bin/openssl'
const POLICY = '1.2.3.4.5'

function openssl(directory, args) {
  execFileSync(OPENSSL, args, {
    cwd: directory,
    env: { OPENSSL_CONF: '/dev/null', PATH: '/usr/bin:/bin' },
    timeout: 10_000,
    maxBuffer: 16 * 1024,
    stdio: 'pipe',
  })
}

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rfc3161-local-test-'))
  try {
    const artifactPath = join(directory, 'artifact')
    const rootPath = join(directory, 'root.pem')
    const rootKeyPath = join(directory, 'root.key')
    const signerPath = join(directory, 'tsa.pem')
    const signerKeyPath = join(directory, 'tsa.key')
    const signerCsrPath = join(directory, 'tsa.csr')
    const signerExtPath = join(directory, 'tsa.ext')
    const queryPath = join(directory, 'query.der')
    const alternateQueryPath = join(directory, 'alternate-query.der')
    const noNonceQueryPath = join(directory, 'no-nonce-query.der')
    const noPolicyQueryPath = join(directory, 'no-policy-query.der')
    const sha384QueryPath = join(directory, 'sha384-query.der')
    const responsePath = join(directory, 'response.der')
    const noAccuracyResponsePath = join(directory, 'no-accuracy-response.der')
    const sha1SignerResponsePath = join(directory, 'sha1-signer-response.der')
    const configPath = join(directory, 'tsa.cnf')
    const noAccuracyConfigPath = join(directory, 'tsa-no-accuracy.cnf')
    const sha1SignerConfigPath = join(directory, 'tsa-sha1-signer.cnf')
    const artifactBytes = Buffer.from('exact holder exit issue bytes\n', 'utf8')
    writeFileSync(artifactPath, artifactBytes)

    openssl(directory, [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-noenc',
      '-days',
      '2',
      '-subj',
      '/CN=Local RFC3161 Test Root',
      '-keyout',
      rootKeyPath,
      '-out',
      rootPath,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ])
    openssl(directory, [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-noenc',
      '-subj',
      '/CN=Local Test TSA',
      '-keyout',
      signerKeyPath,
      '-out',
      signerCsrPath,
    ])
    writeFileSync(
      signerExtPath,
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n',
    )
    openssl(directory, [
      'x509',
      '-req',
      '-in',
      signerCsrPath,
      '-CA',
      rootPath,
      '-CAkey',
      rootKeyPath,
      '-CAcreateserial',
      '-days',
      '2',
      '-extfile',
      signerExtPath,
      '-out',
      signerPath,
    ])

    const config = (includeAccuracy, signerDigest = 'sha256') =>
      `[tsa]\ndefault_tsa=local_tsa\n[local_tsa]\nserial=${join(directory, 'serial')}\nsigner_cert=${signerPath}\nsigner_key=${signerKeyPath}\nsigner_digest=${signerDigest}\ndefault_policy=${POLICY}\ndigests=sha256,sha384\n${includeAccuracy ? 'accuracy=secs:1,millisecs:500,microsecs:100\n' : ''}ordering=yes\n`
    writeFileSync(configPath, config(true))
    writeFileSync(noAccuracyConfigPath, config(false))
    writeFileSync(sha1SignerConfigPath, config(true, 'sha1'))
    openssl(directory, [
      'ts',
      '-query',
      '-data',
      artifactPath,
      '-sha256',
      '-cert',
      '-tspolicy',
      POLICY,
      '-out',
      queryPath,
    ])
    openssl(directory, [
      'ts',
      '-query',
      '-data',
      artifactPath,
      '-sha256',
      '-cert',
      '-tspolicy',
      POLICY,
      '-out',
      alternateQueryPath,
    ])
    openssl(directory, [
      'ts',
      '-query',
      '-data',
      artifactPath,
      '-sha256',
      '-no_nonce',
      '-cert',
      '-tspolicy',
      POLICY,
      '-out',
      noNonceQueryPath,
    ])
    openssl(directory, [
      'ts',
      '-query',
      '-data',
      artifactPath,
      '-sha384',
      '-cert',
      '-tspolicy',
      POLICY,
      '-out',
      sha384QueryPath,
    ])
    openssl(directory, [
      'ts',
      '-query',
      '-data',
      artifactPath,
      '-sha256',
      '-cert',
      '-out',
      noPolicyQueryPath,
    ])
    openssl(directory, [
      'ts',
      '-reply',
      '-config',
      configPath,
      '-queryfile',
      queryPath,
      '-out',
      responsePath,
    ])
    openssl(directory, [
      'ts',
      '-reply',
      '-config',
      noAccuracyConfigPath,
      '-queryfile',
      queryPath,
      '-out',
      noAccuracyResponsePath,
    ])
    openssl(directory, [
      'ts',
      '-reply',
      '-config',
      sha1SignerConfigPath,
      '-queryfile',
      queryPath,
      '-out',
      sha1SignerResponsePath,
    ])
    // This is a valid signed response at a permissive security level; the
    // verifier's SHA-256-only signing rule is what must reject it.
    openssl(directory, [
      'ts',
      '-verify',
      '-queryfile',
      queryPath,
      '-in',
      sha1SignerResponsePath,
      '-CAfile',
      rootPath,
      '-untrusted',
      signerPath,
      '-auth_level',
      '0',
    ])

    const rootPem = readFileSync(rootPath, 'utf8')
    const rootDer = new X509Certificate(rootPem).raw
    return {
      artifactBytes,
      queryDer: readFileSync(queryPath),
      alternateQueryDer: readFileSync(alternateQueryPath),
      noNonceQueryDer: readFileSync(noNonceQueryPath),
      noPolicyQueryDer: readFileSync(noPolicyQueryPath),
      sha384QueryDer: readFileSync(sha384QueryPath),
      responseDer: readFileSync(responsePath),
      noAccuracyResponseDer: readFileSync(noAccuracyResponsePath),
      sha1SignerResponseDer: readFileSync(sha1SignerResponsePath),
      chainPem: readFileSync(signerPath, 'utf8'),
      rootPem,
      expectedRootSha256: createHash('sha256').update(rootDer).digest('hex'),
      expectedPolicyOid: POLICY,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const fixture = makeFixture()
const input = (changes = {}) => ({ ...fixture, ...changes })

test('valid local TSA response verifies only under the separately supplied root pin', async () => {
  const privateTemps = () =>
    readdirSync(tmpdir())
      .filter((name) => name.startsWith('holder-exit-rfc3161-'))
      .sort()
  const before = privateTemps()
  const result = await verifyRfc3161Witness(input())
  assert.deepEqual(privateTemps(), before)
  assert.equal(result.status, 'verified_under_supplied_pin')
  assert.equal(
    result.artifactSha256,
    createHash('sha256').update(fixture.artifactBytes).digest('hex'),
  )
  assert.equal(result.rootSha256, fixture.expectedRootSha256)
  assert.equal(result.policyOid, POLICY)
  assert.equal(result.accuracyMicros, 1_500_100)
  assert.match(result.genTimeUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  assert.ok(Date.parse(result.intervalUtc.earliest) < Date.parse(result.genTimeUtc))
  assert.ok(Date.parse(result.intervalUtc.latest) > Date.parse(result.genTimeUtc))
  assert.equal('independently_witnessed_utc' in result, false)
})

test('changed artifact byte fails exact SHA-256 imprint binding', async () => {
  const changed = Buffer.from(fixture.artifactBytes)
  changed[0] ^= 1
  assert.deepEqual(await verifyRfc3161Witness(input({ artifactBytes: changed })), {
    status: 'unverified',
    reason: 'artifact_imprint_mismatch',
  })
})

test('swapped query nonce fails even when artifact and policy match', async () => {
  assert.deepEqual(await verifyRfc3161Witness(input({ queryDer: fixture.alternateQueryDer })), {
    status: 'unverified',
    reason: 'nonce_mismatch',
  })
})

test('incorrect root fingerprint fails before trust is delegated to OpenSSL', async () => {
  assert.deepEqual(await verifyRfc3161Witness(input({ expectedRootSha256: '00'.repeat(32) })), {
    status: 'unverified',
    reason: 'root_pin_mismatch',
  })
})

test('response without signed accuracy cannot establish a bounded UTC interval', async () => {
  assert.deepEqual(
    await verifyRfc3161Witness(input({ responseDer: fixture.noAccuracyResponseDer })),
    {
      status: 'unverified',
      reason: 'missing_accuracy',
    },
  )
})

test('request without nonce and configured wrong policy both fail closed', async () => {
  assert.deepEqual(await verifyRfc3161Witness(input({ queryDer: fixture.noNonceQueryDer })), {
    status: 'unverified',
    reason: 'missing_request_nonce',
  })
  assert.deepEqual(await verifyRfc3161Witness(input({ expectedPolicyOid: '1.2.3.4.6' })), {
    status: 'unverified',
    reason: 'policy_mismatch',
  })
})

test('caller policy and request policy are mandatory', async () => {
  assert.deepEqual(await verifyRfc3161Witness(input({ expectedPolicyOid: undefined })), {
    status: 'unverified',
    reason: 'missing_expected_policy',
  })
  assert.deepEqual(await verifyRfc3161Witness(input({ queryDer: fixture.noPolicyQueryDer })), {
    status: 'unverified',
    reason: 'missing_request_policy',
  })
})

test('SHA-1 CMS signer digest is rejected despite a SHA-256 message imprint', async () => {
  assert.deepEqual(
    await verifyRfc3161Witness(input({ responseDer: fixture.sha1SignerResponseDer })),
    {
      status: 'unverified',
      reason: 'non_sha256_signature_digest',
    },
  )
})

test('non-SHA256 request imprint and non-granted response status are rejected', async () => {
  assert.deepEqual(await verifyRfc3161Witness(input({ queryDer: fixture.sha384QueryDer })), {
    status: 'unverified',
    reason: 'non_sha256_imprint',
  })
  const rejected = Buffer.from(fixture.responseDer)
  const grantedStatus = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00])
  const offset = rejected.indexOf(grantedStatus)
  assert.notEqual(offset, -1)
  rejected[offset + grantedStatus.length - 1] = 2
  assert.deepEqual(await verifyRfc3161Witness(input({ responseDer: rejected })), {
    status: 'unverified',
    reason: 'non_granted_status',
  })
})

test('a changed CMS signature fails OpenSSL signature and chain verification', async () => {
  const changedSignature = Buffer.from(fixture.responseDer)
  changedSignature[changedSignature.length - 1] ^= 1
  assert.deepEqual(await verifyRfc3161Witness(input({ responseDer: changedSignature })), {
    status: 'unverified',
    reason: 'query_verification_failed',
  })
})
