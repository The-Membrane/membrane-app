import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadMorphoFlowSubjects } from '../record-carry-morpho-v2-flows.mjs'
import {
  appendRange,
  PILOT_VAULT,
  rpcOrigin,
  runArchive,
} from './record-carry-morpho-v2-archive-local.mjs'

const hash = (number) => `0x${BigInt(number).toString(16).padStart(64, '0')}`
const finalized = 1_000_000n
function fakeClient({ disagreeAt = null, extraLog = false, failLogs = false } = {}) {
  return {
    getChainId: async () => 1,
    getBlock: async ({ blockTag, blockNumber }) => {
      const number = blockTag === 'finalized' ? finalized : BigInt(blockNumber)
      return {
        number,
        hash: hash(number === disagreeAt ? number + 1n : number),
        timestamp: 1_700_000_000n + number * 12n,
      }
    },
    getLogs: async () => {
      if (failLogs) throw Error('fixture_log_unavailable')
      return extraLog ? [{ unexpected: true }] : []
    },
  }
}

test('retrospective 64-block quiet pilot seals two independent empty raw witnesses and replays offline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-retro-test-'))
  try {
    const result = await runArchive(['--pilot'], {
      root,
      rpcUrls: 'https://one.example/rpc,https://two.example/rpc',
      clientFactory: () => fakeClient(),
    })
    assert.equal(result.vault, PILOT_VAULT)
    assert.equal(BigInt(result.toBlock) - BigInt(result.fromBlock) + 1n, 64n)
    assert.equal(result.events, 0)
    const replay = await runArchive(['--verify'], { root })
    assert.equal(replay.coveredBlocks, 64)
    assert.equal(replay.ranges, 1)
    assert.equal(replay.tipSha256, result.sha256)
    const attestation = join(root, PILOT_VAULT, 'header-attestation.json')
    const originalAttestation = readFileSync(attestation, 'utf8')
    const changedAttestation = JSON.parse(originalAttestation)
    changedAttestation.rangeSha256 = '0'.repeat(64)
    writeFileSync(attestation, `${JSON.stringify(changedAttestation)}\n`)
    await assert.rejects(runArchive(['--verify'], { root }), /hash_mismatch/)
    writeFileSync(attestation, originalAttestation)
    const forgedAttestation = JSON.parse(originalAttestation)
    forgedAttestation.views[0].headers.start.hash = hash(42)
    forgedAttestation.views[1].headers.start.hash = hash(42)
    const { sha256: unused, ...forgedBody } = forgedAttestation
    void unused
    forgedAttestation.sha256 = createHash('sha256').update(JSON.stringify(forgedBody)).digest('hex')
    writeFileSync(attestation, `${JSON.stringify(forgedAttestation)}\n`)
    await assert.rejects(runArchive(['--verify'], { root }), /header_attestation_boundary/)
    writeFileSync(attestation, originalAttestation)
    const repeat = await runArchive(['--pilot'], {
      root,
      rpcUrls: 'https://one.example/rpc,https://two.example/rpc',
      clientFactory: () => fakeClient(),
    })
    assert.equal(repeat.tipSha256, result.sha256)
    const staleTemp = join(
      root,
      PILOT_VAULT,
      '000000000002.json.12345678-1234-1234-1234-123456789abc.tmp',
    )
    writeFileSync(staleTemp, 'interrupted temporary write')
    assert.equal((await runArchive(['--verify'], { root })).complete, true)
    const unknownFinal = join(root, PILOT_VAULT, 'unexpected.json')
    writeFileSync(unknownFinal, '{}\n')
    await assert.rejects(runArchive(['--verify'], { root }), /unexpected_archive_file/)
    rmSync(unknownFinal)
    rmSync(staleTemp)
    rmSync(attestation)
    await assert.rejects(runArchive(['--verify'], { root }), /header_attestation_missing/)
    const noSidecar = await runArchive(['--verify-partial'], { root })
    assert.equal(noSidecar.rangeComplete, true)
    assert.equal(noSidecar.complete, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('completion verifier rejects enrollment-only and a partial quiet range', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-retro-test-'))
  try {
    await assert.rejects(
      runArchive(['--pilot'], {
        root,
        rpcUrls: 'https://one.example,https://two.example',
        clientFactory: () => fakeClient({ failLogs: true }),
      }),
      /fixture_log_unavailable/,
    )
    await assert.rejects(runArchive(['--verify'], { root }), /pilot_incomplete/)
    const empty = await runArchive(['--verify-partial'], { root })
    assert.equal(empty.complete, false)
    assert.equal(empty.coveredBlocks, 0)

    const enrollment = JSON.parse(readFileSync(join(root, 'enrollment.json'), 'utf8'))
    const subject = (await loadMorphoFlowSubjects()).find((row) => row.vault === PILOT_VAULT)
    const from = BigInt(enrollment.startBlock) + 1n
    const to = from + 31n
    appendRange(
      subject,
      enrollment,
      {
        ...Object.fromEntries(
          [
            'vault',
            'asset',
            'manifestSha256',
            'seedSha256',
            'boardSha256',
            'displayedRoutesSha256',
            'cohortId',
          ].map((key) => [key, subject[key]]),
        ),
        fromBlock: String(from),
        toBlock: String(to),
        priorHash: enrollment.priorHash,
        toHash: hash(to),
        finalizedHeadBlock: String(to),
        finalizedHeadHash: hash(to),
        toObservedAt: new Date().toISOString(),
        combinedSetSha256: createHash('sha256').update('[]').digest('hex'),
        events: [],
      },
      [
        { origin: 'one.example', rawLogs: [], eventBlocks: [] },
        { origin: 'two.example', rawLogs: [], eventBlocks: [] },
      ],
      root,
    )
    await assert.rejects(runArchive(['--verify'], { root }), /pilot_incomplete/)
    const partial = await runArchive(['--verify-partial'], { root })
    assert.equal(partial.complete, false)
    assert.equal(partial.coveredBlocks, 32)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('origin collision, historical boundary disagreement and tampered receipt fail closed', async () => {
  assert.equal(rpcOrigin('https://www.example.com/a'), rpcOrigin('https://example.com/b'))
  const root = mkdtempSync(join(tmpdir(), 'morpho-retro-test-'))
  try {
    await assert.rejects(
      runArchive(['--pilot'], {
        root,
        rpcUrls: 'https://one.example/a,https://one.example/b',
        clientFactory: () => fakeClient(),
      }),
      /two_origins_required/,
    )
    await assert.rejects(
      runArchive(['--pilot'], {
        root,
        rpcUrls: 'https://one.example,https://two.example',
        clientFactory: (url) => fakeClient({ disagreeAt: url.includes('two') ? 784_000n : null }),
      }),
      /anchor_header_disagreement/,
    )
    const result = await runArchive(['--pilot'], {
      root,
      rpcUrls: 'https://one.example,https://two.example',
      clientFactory: () => fakeClient(),
    })
    const path = join(root, PILOT_VAULT, '000000000001.json')
    const record = JSON.parse(readFileSync(path, 'utf8'))
    record.toHash = hash(BigInt(result.toBlock) + 1n)
    writeFileSync(path, `${JSON.stringify(record)}\n`)
    await assert.rejects(runArchive(['--verify'], { root }), /hash_mismatch/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pilot can select a working pair by configured origin without exposing URLs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'morpho-retro-test-'))
  try {
    const result = await runArchive(['--pilot', '--origins', 'two.example,three.example'], {
      root,
      rpcUrls: 'https://one.example/key,https://two.example/key,https://three.example/key',
      clientFactory: () => fakeClient(),
    })
    assert.equal(result.events, 0)
    const attestation = JSON.parse(
      readFileSync(join(root, PILOT_VAULT, 'header-attestation.json'), 'utf8'),
    )
    assert.deepEqual(
      attestation.views.map((view) => view.origin),
      ['two.example', 'three.example'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
