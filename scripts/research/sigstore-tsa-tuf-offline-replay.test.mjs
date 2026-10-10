import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  replayRetainedSigstoreTufCandidate,
  replaySigstoreTufCandidate,
} from './sigstore-tsa-tuf-offline-replay.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DATA = join(ROOT, 'scripts/research/fixtures/sigstore-tuf-candidate')
const ROTATIONS = join(ROOT, 'scripts/research/fixtures/sigstore-tuf-roots')
const [candidateBytes, root13Bytes, root14Bytes] = await Promise.all([
  readFile(join(DATA, 'candidate.json')),
  readFile(join(ROTATIONS, '13.root.json')),
  readFile(join(ROTATIONS, '14.root.json')),
])
const observedAt = new Date('2026-10-04T22:30:00.000Z')

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function candidateWith(change) {
  const candidate = JSON.parse(candidateBytes.toString('utf8'))
  change(candidate)
  return Buffer.from(JSON.stringify(candidate))
}

function tamperSignedMetadata(candidate, role, mutate) {
  const metadata = JSON.parse(candidate.tuf.signedMetadataJson[role])
  mutate(metadata)
  const raw = JSON.stringify(metadata)
  candidate.tuf.signedMetadataJson[role] = raw
  candidate.tuf.metadata[role].sha256 = hash(Buffer.from(raw))
  candidate.tuf.metadata[role].version = metadata.signed.version
  candidate.tuf.metadata[role].expires = new Date(metadata.signed.expires).toISOString()
}

function replay(overrides = {}) {
  return replaySigstoreTufCandidate({
    candidateBytes,
    root13Bytes,
    root14Bytes,
    now: observedAt,
    ...overrides,
  })
}

test('replays root 12→15 and signed timestamp, snapshot, targets, target offline', async () => {
  const result = await replay()
  assert.equal(result.status, 'locally_verified_under_selected_bootstrap_pin')
  assert.equal(result.rootProvenanceGateSatisfied, false)
  assert.equal(result.independentUtcWitness, false)
  assert.equal(result.portableVerifier, false)
  assert.deepEqual(result.rotatedRootVersions, [13, 14, 15])
  assert.deepEqual(result.signedMetadataVersions, { timestamp: 799, snapshot: 165, targets: 14 })
  assert.equal(
    result.trustedRootTargetSha256,
    '6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66',
  )
  assert.deepEqual(result.timestampAuthority, {
    uri: 'https://timestamp.sigstore.dev/api/v1/timestamp',
    subject: { organization: 'sigstore.dev', commonName: 'sigstore-tsa-selfsigned' },
    validFor: { start: '2025-07-04T00:00:00.000Z', end: null },
    leafSha256: '85f927bc07ab62cac3b44356c10efc81b2c6883fda7ab9e6d870d9d13acd05b7',
    rootSha256: '2aca8fea5d3ce48b01cc77076293c280e6c23ffe44034757ee7833ca9f45d633',
  })
})

test('the tracked fixture is the exact retained public candidate and replays without ignored data', async () => {
  assert.equal(
    hash(candidateBytes),
    '5ae8f58367fc8d81149ffcb6f539cadbb786249081ef543ef41abdac1fe8c541',
  )
  const result = await replayRetainedSigstoreTufCandidate(DATA, ROTATIONS, observedAt)
  assert.equal(result.status, 'locally_verified_under_selected_bootstrap_pin')
})

test('rejects a forged unsigned timestamp-authority summary after verified-target replay', async () => {
  for (const change of [
    (authority) => {
      authority.uri = 'https://attacker.example/timestamp'
    },
    (authority) => {
      authority.leaf.sha256 = '0'.repeat(64)
    },
    (authority) => {
      authority.root.derBase64 = authority.leaf.derBase64
    },
    (authority) => {
      authority.validFor.start = '2024-01-01T00:00:00.000Z'
    },
  ]) {
    const modified = candidateWith((candidate) => change(candidate.timestampAuthority))
    await assert.rejects(
      replay({ candidateBytes: modified }),
      /candidate_authority_differs_from_verified_target/,
    )
  }
})

test('rejects a changed selected bootstrap root', async () => {
  const modified = candidateWith((candidate) => {
    candidate.tuf.bootstrap.seedRootJson += ' '
  })
  await assert.rejects(replay({ candidateBytes: modified }), /bootstrap_pin_mismatch/)
})

test('rejects a missing or changed root rotation file', async () => {
  await assert.rejects(replay({ root13Bytes: undefined }), /root_13_size/)
  const modified = Buffer.from(root14Bytes)
  modified[0] = modified[0] === 0x7b ? 0x5b : 0x7b
  await assert.rejects(replay({ root14Bytes: modified }), /root_14_digest/)
})

test('rejects final root whose saved summary was updated around a forged signature', async () => {
  const modified = candidateWith((candidate) => {
    tamperSignedMetadata(candidate, 'root', (metadata) => {
      for (const signature of metadata.signatures) {
        signature.sig = '00' + signature.sig.slice(2)
      }
    })
  })
  await assert.rejects(replay({ candidateBytes: modified }))
})

test('rejects timestamp whose saved summary was updated around a forged signature', async () => {
  const modified = candidateWith((candidate) => {
    tamperSignedMetadata(candidate, 'timestamp', (metadata) => {
      metadata.signatures[0].sig = '00' + metadata.signatures[0].sig.slice(2)
    })
  })
  await assert.rejects(replay({ candidateBytes: modified }))
})

test('rejects a snapshot changed after the signed timestamp', async () => {
  const modified = candidateWith((candidate) => {
    tamperSignedMetadata(candidate, 'snapshot', (metadata) => {
      metadata.signed.version += 1
    })
  })
  await assert.rejects(replay({ candidateBytes: modified }))
})

test('rejects targets changed after the signed snapshot', async () => {
  const modified = candidateWith((candidate) => {
    tamperSignedMetadata(candidate, 'targets', (metadata) => {
      metadata.signed.version += 1
    })
  })
  await assert.rejects(replay({ candidateBytes: modified }))
})

test('rejects target bytes even when candidate bookkeeping is updated', async () => {
  const modified = candidateWith((candidate) => {
    candidate.trustedRootJson += ' '
    candidate.tuf.target.length = Buffer.byteLength(candidate.trustedRootJson)
    candidate.tuf.target.sha256 = hash(Buffer.from(candidate.trustedRootJson))
  })
  await assert.rejects(replay({ candidateBytes: modified }))
})

test('rejects expired signed metadata at verification time', async () => {
  await assert.rejects(replay({ now: new Date('2026-10-11T00:00:00.000Z') }))
})
