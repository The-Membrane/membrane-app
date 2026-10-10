import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { replayRfc3161Sidecar } from './holder-exit-rfc3161-sidecar-replay.mjs'

const POLICY = '1.3.6.1.4.1.57264.2'
const ROOT_PIN = 'a'.repeat(64)
const QUERY = Buffer.from([0x30, 0x02, 0x02, 0x00])
const RESPONSE = Buffer.from([0x30, 0x02, 0x02, 0x01])
const TRUST = {
  expectedPolicyOid: POLICY,
  rootPem: 'caller-supplied root certificate',
  chainPem: 'caller-supplied signer chain',
  expectedRootSha256: ROOT_PIN,
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fixture(t, artifactBytes = Buffer.from('{"issue":1}\n')) {
  const directory = mkdtempSync(join(tmpdir(), 'holder-exit-tsa-replay-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const artifactPath = join(directory, 'issue.json')
  const sidecarPath = `${artifactPath}.rfc3161-witness`
  writeFileSync(artifactPath, artifactBytes)
  const record = {
    schema: 'holder_exit_rfc3161_publication_v1',
    status: 'pending_trust_root',
    trustedUtc: null,
    localClockStatus: 'observed_untrusted',
    artifact: {
      filename: 'issue.json',
      byteLength: artifactBytes.length,
      sha256: hash(artifactBytes),
    },
    request: {
      tsaUrl: 'https://timestamp.sigstore.dev/api/v1/timestamp',
      policyOid: POLICY,
      contentType: 'application/timestamp-query',
      sentAtLocalUtc: '2026-10-04T23:00:00.000Z',
      derBase64: QUERY.toString('base64'),
      sha256: hash(QUERY),
    },
    response: {
      contentType: 'application/timestamp-reply',
      receivedAtLocalUtc: '2026-10-04T23:00:01.000Z',
      derBase64: RESPONSE.toString('base64'),
      sha256: hash(RESPONSE),
    },
  }
  const save = () => writeFileSync(sidecarPath, `${JSON.stringify(record)}\n`)
  save()
  return { artifactPath, sidecarPath, record, save, input: { artifactPath, sidecarPath, ...TRUST } }
}

function fakeVerified({ artifactBytes, expectedRootSha256, expectedPolicyOid }) {
  return {
    status: 'verified_under_supplied_pin',
    artifactSha256: hash(artifactBytes),
    rootSha256: expectedRootSha256,
    policyOid: expectedPolicyOid,
    genTimeUtc: '2026-10-04T23:00:01Z',
    accuracyMicros: 1000,
    intervalUtc: {
      earliest: '2026-10-04T23:00:00.999Z',
      latest: '2026-10-04T23:00:01.001Z',
    },
  }
}

test('replays exact bytes with separately supplied trust and returns only supplied-pin status', async (t) => {
  const { input, artifactPath } = fixture(t)
  let checked = 0
  const result = await replayRfc3161Sidecar(input, {
    verify: async (args) => {
      checked += 1
      assert.deepEqual(args.artifactBytes, readFileSync(artifactPath))
      assert.deepEqual(args.queryDer, QUERY)
      assert.deepEqual(args.responseDer, RESPONSE)
      assert.equal(args.expectedPolicyOid, POLICY)
      assert.equal(args.rootPem, TRUST.rootPem)
      assert.equal(args.chainPem, TRUST.chainPem)
      assert.equal(args.expectedRootSha256, ROOT_PIN)
      return fakeVerified(args)
    },
  })
  assert.equal(checked, 1)
  assert.equal(result.status, 'verified_under_supplied_pin')
  assert.equal(result.artifactSha256, hash(readFileSync(artifactPath)))
  assert.deepEqual(result.intervalUtc, {
    earliest: '2026-10-04T23:00:00.999Z',
    latest: '2026-10-04T23:00:01.001Z',
  })
  assert.equal(Object.hasOwn(result, 'independently_witnessed_utc'), false)
})

test('missing files, symlinks and oversize files abstain before token verification', async (t) => {
  const missing = fixture(t)
  unlinkSync(missing.sidecarPath)
  assert.deepEqual(await replayRfc3161Sidecar(missing.input), {
    status: 'unverified',
    reason: 'sidecar_missing',
  })

  const artifactLink = fixture(t)
  const alias = join(artifactLink.artifactPath, '..', 'alias.json')
  symlinkSync(artifactLink.artifactPath, alias)
  assert.equal(
    (await replayRfc3161Sidecar({ ...artifactLink.input, artifactPath: alias })).reason,
    'artifact_open_failed',
  )

  const sidecarLink = fixture(t)
  const original = `${sidecarLink.sidecarPath}.original`
  writeFileSync(original, readFileSync(sidecarLink.sidecarPath))
  unlinkSync(sidecarLink.sidecarPath)
  symlinkSync(original, sidecarLink.sidecarPath)
  assert.equal((await replayRfc3161Sidecar(sidecarLink.input)).reason, 'sidecar_open_failed')

  const oversizedSidecar = fixture(t)
  truncateSync(oversizedSidecar.sidecarPath, 1536 * 1024 + 1)
  assert.equal((await replayRfc3161Sidecar(oversizedSidecar.input)).reason, 'sidecar_size')

  const oversizedArtifact = fixture(t)
  truncateSync(oversizedArtifact.artifactPath, 64 * 1024 * 1024 + 1)
  assert.equal((await replayRfc3161Sidecar(oversizedArtifact.input)).reason, 'artifact_size')
})

test('canonical JSON, filename, length, SHA and trailing newline bind the artifact', async (t) => {
  const noncanonical = fixture(t)
  writeFileSync(noncanonical.sidecarPath, JSON.stringify(noncanonical.record, null, 2))
  assert.equal((await replayRfc3161Sidecar(noncanonical.input)).reason, 'sidecar_not_canonical')

  const wrongName = fixture(t)
  wrongName.record.artifact.filename = 'other.json'
  wrongName.save()
  assert.equal((await replayRfc3161Sidecar(wrongName.input)).reason, 'artifact_binding_mismatch')

  const wrongLength = fixture(t)
  wrongLength.record.artifact.byteLength += 1
  wrongLength.save()
  assert.equal((await replayRfc3161Sidecar(wrongLength.input)).reason, 'artifact_binding_mismatch')

  const wrongSha = fixture(t)
  wrongSha.record.artifact.sha256 = 'b'.repeat(64)
  wrongSha.save()
  assert.equal((await replayRfc3161Sidecar(wrongSha.input)).reason, 'artifact_binding_mismatch')

  const newline = fixture(t)
  writeFileSync(newline.artifactPath, '{"issue":1}')
  assert.equal((await replayRfc3161Sidecar(newline.input)).reason, 'artifact_binding_mismatch')
})

test('DER base64 and SHA fields are independently checked before verifier', async (t) => {
  const malformedBase64 = fixture(t)
  malformedBase64.record.request.derBase64 += '='
  malformedBase64.save()
  assert.equal((await replayRfc3161Sidecar(malformedBase64.input)).reason, 'query_base64')

  const changedQuerySha = fixture(t)
  changedQuerySha.record.request.sha256 = 'b'.repeat(64)
  changedQuerySha.save()
  assert.equal((await replayRfc3161Sidecar(changedQuerySha.input)).reason, 'query_sha256')

  const changedResponseSha = fixture(t)
  changedResponseSha.record.response.sha256 = 'b'.repeat(64)
  changedResponseSha.save()
  assert.equal((await replayRfc3161Sidecar(changedResponseSha.input)).reason, 'response_sha256')
})

test('caller must supply policy, root pin and chain; sidecar cannot supply a root', async (t) => {
  const { input, record, save } = fixture(t)
  let calls = 0
  const verify = async () => {
    calls += 1
    return { status: 'independently_witnessed_utc' }
  }
  assert.equal(
    (await replayRfc3161Sidecar({ ...input, expectedPolicyOid: undefined }, { verify })).reason,
    'expected_policy_missing',
  )
  assert.equal(
    (await replayRfc3161Sidecar({ ...input, rootPem: undefined }, { verify })).reason,
    'root_pem_missing',
  )
  assert.equal(
    (await replayRfc3161Sidecar({ ...input, expectedRootSha256: undefined }, { verify })).reason,
    'root_pin_missing',
  )
  assert.equal(
    (await replayRfc3161Sidecar({ ...input, chainPem: undefined }, { verify })).reason,
    'chain_pem_missing',
  )
  record.rootPem = 'attacker-supplied trust root'
  save()
  assert.equal((await replayRfc3161Sidecar(input, { verify })).reason, 'sidecar_shape')
  assert.equal(calls, 0)
})

test('sidecar policy and local claim fields cannot replace verified token checks', async (t) => {
  const policy = fixture(t)
  policy.record.request.policyOid = '1.2.3'
  policy.save()
  assert.equal((await replayRfc3161Sidecar(policy.input)).reason, 'policy_mismatch')

  const claimedUtc = fixture(t)
  claimedUtc.record.trustedUtc = '2026-10-04T23:00:00Z'
  claimedUtc.save()
  assert.equal((await replayRfc3161Sidecar(claimedUtc.input)).reason, 'sidecar_claim_invalid')

  const fakeClock = fixture(t)
  fakeClock.record.localClockStatus = 'regressed'
  fakeClock.save()
  assert.equal((await replayRfc3161Sidecar(fakeClock.input)).reason, 'sidecar_local_clock_fields')
})

test('failed or overclaiming verifier and files changed during replay abstain', async (t) => {
  const failed = fixture(t)
  assert.equal(
    (
      await replayRfc3161Sidecar(failed.input, {
        verify: async () => ({ status: 'unverified', reason: 'nonce_mismatch' }),
      })
    ).reason,
    'nonce_mismatch',
  )
  const overclaimed = fixture(t)
  assert.equal(
    (
      await replayRfc3161Sidecar(overclaimed.input, {
        verify: async () => ({ status: 'independently_witnessed_utc' }),
      })
    ).reason,
    'verifier_result_invalid',
  )
  const wrongInterval = fixture(t)
  assert.equal(
    (
      await replayRfc3161Sidecar(wrongInterval.input, {
        verify: async (args) => ({
          ...fakeVerified(args),
          intervalUtc: {
            earliest: '2026-10-04T23:00:00.999Z',
            latest: '2026-10-04T23:00:01.002Z',
          },
        }),
      })
    ).reason,
    'verifier_result_invalid',
  )
  const changed = fixture(t)
  assert.equal(
    (
      await replayRfc3161Sidecar(changed.input, {
        verify: async (args) => {
          writeFileSync(changed.artifactPath, '{"issue":2}\n')
          return fakeVerified(args)
        },
      })
    ).reason,
    'files_changed_during_replay',
  )
  const sidecarChanged = fixture(t)
  assert.equal(
    (
      await replayRfc3161Sidecar(sidecarChanged.input, {
        verify: async (args) => {
          writeFileSync(sidecarChanged.sidecarPath, `${JSON.stringify(sidecarChanged.record)}\n `)
          return fakeVerified(args)
        },
      })
    ).reason,
    'files_changed_during_replay',
  )
})

test('real token verifier does not promote an envelope-only fixture', async (t) => {
  const { input } = fixture(t)
  const result = await replayRfc3161Sidecar(input)
  assert.equal(result.status, 'unverified')
})
