import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeEventLog, parseAbiItem, toEventHash } from 'viem'

import { normalizeFlowLogs } from '../record-carry-morpho-v2-flows.mjs'

import {
  appendLocalMorphoRange,
  enrollLocalMorpho,
  verifyLocalMorphoEnrollment,
  verifyLocalMorphoVault,
} from './localMorphoV2FlowStore.mjs'

const hex = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const address = (n) => `0x${BigInt(n).toString(16).padStart(40, '0')}`
const sha = (value) => createHash('sha256').update(value).digest('hex')
const subjects = Array.from({ length: 49 }, (_, i) => ({
  vault: address(i + 1),
  asset: address(100),
  routeKeys: ['USDC → VaultV2 [USDC]'],
  manifestSha256: sha('manifest'),
  seedSha256: sha('seed'),
  boardSha256: sha('board'),
  displayedRoutesSha256: sha('display'),
  cohortId: 'fixture',
}))
const block = { number: 100n, hash: hex(100), timestamp: 1_780_000_000n }

function emptyRange(subject, from, to, priorHash) {
  return {
    vault: subject.vault,
    asset: subject.asset,
    manifestSha256: subject.manifestSha256,
    seedSha256: subject.seedSha256,
    boardSha256: subject.boardSha256,
    displayedRoutesSha256: subject.displayedRoutesSha256,
    cohortId: subject.cohortId,
    fromBlock: String(from),
    toBlock: String(to),
    priorHash,
    toHash: hex(to),
    finalizedHeadBlock: String(to),
    finalizedHeadHash: hex(to),
    toObservedAt: new Date(1_780_000_000_000 + to * 12000).toISOString(),
    combinedSetSha256: sha('[]'),
    events: [],
    payloadSha256: sha('payload'),
  }
}

test('local enrollment and quiet ranges replay with contiguous hash cursor', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-morpho-test-'))
  try {
    const enrolled = enrollLocalMorpho(subjects, block, root)
    assert.equal(verifyLocalMorphoEnrollment(subjects, root).sha256, enrolled.sha256)
    const subject = subjects[0]
    const first = appendLocalMorphoRange(
      subject,
      enrolled,
      emptyRange(subject, 101, 112, hex(100)),
      [],
      [],
      root,
    )
    const second = appendLocalMorphoRange(
      subject,
      enrolled,
      emptyRange(subject, 113, 120, hex(112)),
      [],
      [],
      root,
    )
    assert.equal(first.previousSha256, enrolled.sha256)
    assert.equal(second.previousSha256, first.sha256)
    assert.equal(verifyLocalMorphoVault(subject, enrolled, root).length, 2)
    assert.throws(
      () =>
        appendLocalMorphoRange(
          subject,
          enrolled,
          emptyRange(subject, 122, 124, hex(121)),
          [],
          [],
          root,
        ),
      /local_morpho_cursor_gap/,
    )
    assert.equal(verifyLocalMorphoVault(subject, enrolled, root).length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('changed physical receipt bytes fail replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-morpho-test-'))
  try {
    const enrolled = enrollLocalMorpho(subjects, block, root)
    const subject = subjects[0]
    appendLocalMorphoRange(subject, enrolled, emptyRange(subject, 101, 102, hex(100)), [], [], root)
    const path = join(root, subject.vault, '000000000001.json')
    writeFileSync(path, readFileSync(path, 'utf8').replace('not_measured', 'executable'))
    assert.throws(
      () => verifyLocalMorphoVault(subject, enrolled, root),
      /local_morpho_hash_mismatch/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('raw deposit provenance decodes to the sealed normalized event', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-morpho-test-'))
  try {
    const enrolled = enrollLocalMorpho(subjects, block, root)
    const subject = subjects[0]
    const abi = parseAbiItem(
      'event Deposit(address indexed sender,address indexed onBehalf,uint256 assets,uint256 shares)',
    )
    const log = {
      kind: 'deposit',
      address: subject.vault,
      blockNumber: '101',
      blockHash: hex(101),
      transactionHash: hex(1001),
      transactionIndex: 0,
      logIndex: 0,
      topics: [toEventHash(abi).toLowerCase(), hex(501), hex(502)],
      data: `0x${1000n.toString(16).padStart(64, '0')}${900n.toString(16).padStart(64, '0')}`,
    }
    const parsed = {
      ...log,
      blockNumber: 101n,
      args: decodeEventLog({ abi: [abi], topics: log.topics, data: log.data, strict: true }).args,
    }
    const payload = {
      ...emptyRange(subject, 101, 101, hex(100)),
      events: normalizeFlowLogs(subject.vault, [parsed], [], [], 101n, 101n),
      combinedSetSha256: sha(
        JSON.stringify([
          JSON.stringify([
            subject.vault,
            '101',
            hex(101),
            hex(1001),
            0,
            0,
            'deposit',
            log.topics,
            log.data,
          ]),
        ]),
      ),
    }
    appendLocalMorphoRange(
      subject,
      enrolled,
      payload,
      [log],
      [{ block: '101', hash: hex(101) }],
      root,
    )
    assert.equal(verifyLocalMorphoVault(subject, enrolled, root)[0].events[0].assets_raw, '1000')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
