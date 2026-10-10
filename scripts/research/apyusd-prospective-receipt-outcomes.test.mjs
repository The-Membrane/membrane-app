import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { keccak256, stringToHex } from 'viem'

import { ASSET } from './carry-public-apyusd-exit-common.mjs'
import { RECEIPT } from './apyusd-receipt-cohort-source.mjs'
import {
  buildProspectivePayout,
  captureProspectivePayout,
  classifyProspectiveReceipt,
  readProspectiveOutcomes,
  readProspectiveStatus,
  replayProspectiveReceipt,
  validateProspectivePayout,
  verifyProspectivePayout,
} from './apyusd-prospective-receipt-outcomes.mjs'

const TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'))
const ZERO = `0x${'0'.repeat(64)}`
const HOLDER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const hexWord = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const addressWord = (address) => `0x${address.slice(2).padStart(64, '0')}`
const hash = (letter) => `0x${letter.repeat(64)}`
const seal = (body) => ({
  ...body,
  sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
})

function transfer(tokenId, from, to, blockNumber, logIndex, txLetter) {
  return {
    blockNumber,
    blockHash: hash(blockNumber === 100 ? 'a' : blockNumber === 101 ? 'b' : 'f'),
    transactionHash: hash(txLetter),
    logIndex,
    topics: [
      TOPIC,
      from === null ? ZERO : addressWord(from),
      to === null ? ZERO : addressWord(to),
      hexWord(tokenId),
    ],
    data: '0x',
  }
}

function rawTransfer(event) {
  return {
    address: RECEIPT,
    blockNumber: `0x${event.blockNumber.toString(16)}`,
    blockHash: event.blockHash,
    transactionHash: event.transactionHash,
    transactionIndex: '0x0',
    logIndex: `0x${event.logIndex.toString(16)}`,
    topics: event.topics,
    data: event.data,
    removed: false,
  }
}

function fixture({ events = null, secondMint = false } = {}) {
  const mintEvent = transfer(1, null, HOLDER, 100, 0, 'c')
  const mint = {
    tokenId: '1',
    initialHolder: HOLDER,
    issueBlockNumber: 100,
    issueBlockHash: hash('a'),
    issueBlockTimestamp: 1_000,
    transactionHash: hash('c'),
    logIndex: 0,
    rawLog: rawTransfer(mintEvent),
    requestAssets: { status: 'unknown', assetsRaw: null, source: null },
  }
  const h100 = { number: 100, hash: hash('a'), parentHash: hash('0'), timestamp: 1_000 }
  const h101 = { number: 101, hash: hash('b'), parentHash: hash('a'), timestamp: 1_100 }
  const burn = transfer(1, HOLDER, null, 101, 0, 'd')
  const w1 = {
    sequence: 1,
    sha256: '1'.repeat(64),
    fromBlock: 100,
    toBlock: 100,
    observedAtUtc: '1970-01-01T00:16:40.000Z',
    toHeader: h100,
    eventBlockHeaders: [h100],
    transfers: [mintEvent],
    mints: [mint],
  }
  const w2 = {
    sequence: 2,
    sha256: '2'.repeat(64),
    fromBlock: 101,
    toBlock: 101,
    observedAtUtc: '1970-01-01T00:18:20.000Z',
    toHeader: h101,
    eventBlockHeaders: [h101],
    transfers: events ?? [burn],
    mints: [],
  }
  if (secondMint) {
    const m2 = transfer(2, null, OTHER, 100, 1, 'e')
    w1.transfers.push(m2)
    w1.mints.push({
      ...mint,
      tokenId: '2',
      initialHolder: OTHER,
      transactionHash: hash('e'),
      logIndex: 1,
      rawLog: rawTransfer(m2),
    })
  }
  return {
    intake: {
      anchor: { sha256: '0'.repeat(64), origins: ['a.example', 'b.example'] },
      windows: [w1, w2],
      coveredThrough: 101,
      mints: secondMint ? 2 : 1,
    },
    mint,
    burn,
  }
}

function payoutProof(mint, burn, paidRaw = '95', payoutTimestamp = 1_100) {
  const witness = {
    address: ASSET,
    logIndex: 1,
    topics: [TOPIC, addressWord(RECEIPT), addressWord(mint.initialHolder)],
    data: hexWord(paidRaw),
  }
  return {
    tokenId: mint.tokenId,
    holder: mint.initialHolder,
    request: {
      blockNumber: mint.issueBlockNumber,
      blockHash: mint.issueBlockHash,
      transactionHash: mint.transactionHash,
      logIndex: mint.logIndex,
      timestamp: mint.issueBlockTimestamp,
      requestedAssetRaw: '100',
    },
    payout: {
      blockNumber: burn.blockNumber,
      blockHash: burn.blockHash,
      transactionHash: burn.transactionHash,
      logIndex: burn.logIndex,
      timestamp: payoutTimestamp,
      paidAssetRaw: paidRaw,
      payoutTransferWitness: witness,
    },
    requestToPayoutSeconds: payoutTimestamp - mint.issueBlockTimestamp,
    payoutBpsFloor: Number((BigInt(paidRaw) * 10_000n) / 100n),
  }
}

function fakeOrigins() {
  return [
    { url: 'https://a.example', provider: 'a', request: async () => 'same' },
    { url: 'https://b.example', provider: 'b', request: async () => 'same' },
  ]
}

const writeProof = async (path, row) => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(row)}\n`, { flag: 'wx' })
}

test('offline replay distinguishes original-holder event chain, lost control, and unproved burn', () => {
  const held = fixture({ events: [] })
  assert.deepEqual(classifyProspectiveReceipt(held.intake, '1'), {
    tokenId: '1',
    initialHolder: HOLDER,
    status: 'original_holder_by_transfer_replay_unburned',
    issuedAt: 1_000,
    observedThroughBlock: 101,
    observedThroughTimestamp: 1_100,
    observedSeconds: 100,
    burnBlock: null,
    paidAt: null,
    requestToPayoutSeconds: null,
    paymentEvidence: 'none',
  })
  const selfTransfer = fixture({
    events: [transfer(1, HOLDER, HOLDER, 101, 0, 'd')],
  })
  assert.equal(
    classifyProspectiveReceipt(selfTransfer.intake, '1').status,
    'original_holder_by_transfer_replay_unburned',
  )
  const burned = fixture()
  assert.equal(classifyProspectiveReceipt(burned.intake, '1').status, 'burned_no_verified_payout')
  const moved = fixture({
    events: [
      transfer(1, HOLDER, OTHER, 101, 0, 'd'),
      transfer(1, OTHER, HOLDER, 101, 1, 'd'),
      transfer(1, HOLDER, null, 101, 2, 'd'),
    ],
  })
  assert.equal(classifyProspectiveReceipt(moved.intake, '1').status, 'transferred_lost_control')
  assert.equal(replayProspectiveReceipt(moved.intake, '1').lostOriginalControl, true)
})

test('broken ownership, transfer after burn, and duplicate token IDs fail closed', () => {
  const broken = fixture({ events: [transfer(1, OTHER, null, 101, 0, 'd')] })
  assert.throws(() => classifyProspectiveReceipt(broken.intake, '1'), /ownership_chain_invalid/)
  const afterBurn = fixture({
    events: [transfer(1, HOLDER, null, 101, 0, 'd'), transfer(1, HOLDER, OTHER, 101, 1, 'd')],
  })
  assert.throws(() => classifyProspectiveReceipt(afterBurn.intake, '1'), /post_burn_transfer/)
  const duplicate = fixture()
  duplicate.intake.windows[1].mints.push(duplicate.mint)
  assert.throws(() => classifyProspectiveReceipt(duplicate.intake, '1'), /duplicate_mint/)
})

test('one bounded two-origin capture seals exact mint and burn, and online recheck agrees', async () => {
  const { intake, mint, burn } = fixture()
  const out = await mkdtemp(join(tmpdir(), 'apyusd-outcomes-'))
  try {
    let reads = 0
    const reader = async (origin, seenMint, seenBurn, options) => {
      reads++
      await origin.request('eth_probe', [])
      assert.deepEqual(seenMint, intake.windows[0].transfers[0])
      assert.deepEqual(seenBurn, burn)
      assert.deepEqual(options, {
        requireUniqueBurn: true,
        includePayoutWitness: true,
        requireCanonicalBurn: true,
      })
      return payoutProof(mint, burn)
    }
    const options = {
      out,
      intakeLoader: async () => intake,
      clientsForUrls: fakeOrigins,
      urls: ['https://a.example', 'https://b.example'],
      reader,
      writer: writeProof,
      freeBytes: () => 2_000_000_000,
      capturedAtUtc: '2026-10-03T00:00:00.000Z',
    }
    const row = await captureProspectivePayout(options)
    assert.equal(reads, 2)
    assert.equal(row.proof.payout.paidAssetRaw, '95')
    assert.equal(row.proof.requestToPayoutSeconds, 100)
    assert.equal(
      classifyProspectiveReceipt(intake, '1', row).status,
      'burned_with_saved_payout_proof',
    )
    assert.equal(
      (await readProspectiveStatus('1', options)).paymentEvidence,
      'sealed_two_origin_capture_not_live_reverified',
    )
    assert.equal((await readProspectiveOutcomes(options)).receipts[0].paidAt, 1_100)
    assert.equal((await verifyProspectivePayout('1', options)).sha256, row.sha256)
    assert.equal(reads, 4)
    assert.equal((await captureProspectivePayout({ ...options, tokenId: '1' })).sha256, row.sha256)
    assert.equal(reads, 6)
    assert.equal((await captureProspectivePayout(options)).status, 'no_unproved_eligible_burn')
    assert.equal(reads, 6)
    const saved = JSON.parse(await readFile(join(out, '1.json'), 'utf8'))
    assert.deepEqual(saved, row)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('divergent origin, missing payout, and disk guard cannot create paid status', async () => {
  const { intake, mint, burn } = fixture()
  const out = await mkdtemp(join(tmpdir(), 'apyusd-outcomes-'))
  try {
    const base = {
      out,
      intakeLoader: async () => intake,
      clientsForUrls: fakeOrigins,
      urls: ['https://a.example', 'https://b.example'],
      writer: writeProof,
      freeBytes: () => 2_000_000_000,
      capturedAtUtc: '2026-10-03T00:00:00.000Z',
    }
    await assert.rejects(
      captureProspectivePayout({
        ...base,
        reader: async (origin) => payoutProof(mint, burn, origin.provider === 'a' ? '95' : '94'),
      }),
      /origins_disagree/,
    )
    await assert.rejects(
      captureProspectivePayout({
        ...base,
        reader: async () => {
          throw Error('apyusd_cohort_holder_payout_invalid')
        },
      }),
      /holder_payout_invalid/,
    )
    await assert.rejects(
      captureProspectivePayout({
        ...base,
        freeBytes: () => 1_000_000,
        reader: async () => {
          throw Error('should_not_run')
        },
      }),
      /disk_reserve/,
    )
    assert.equal(classifyProspectiveReceipt(intake, '1').status, 'burned_no_verified_payout')
    await assert.rejects(readFile(join(out, '1.json')), /ENOENT/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('locally resealed but mismatched witness, burn, or mint is rejected', () => {
  const { intake, mint, burn } = fixture()
  const candidate = replayProspectiveReceipt(intake, '1')
  const row = buildProspectivePayout(
    payoutProof(mint, burn),
    candidate,
    intake,
    '2026-10-03T00:00:00.000Z',
  )
  const changedAmount = structuredClone(row)
  changedAmount.proof.payout.paidAssetRaw = '96'
  assert.throws(
    () =>
      validateProspectivePayout(
        seal(Object.fromEntries(Object.entries(changedAmount).filter(([key]) => key !== 'sha256'))),
        candidate,
        intake,
      ),
    /payout_invalid/,
  )
  const changedMint = fixture()
  changedMint.intake.windows[0].sha256 = '3'.repeat(64)
  assert.throws(() => classifyProspectiveReceipt(changedMint.intake, '1', row), /payout_invalid/)
  const changedBurn = fixture({ events: [transfer(1, HOLDER, null, 101, 0, 'e')] })
  assert.throws(() => classifyProspectiveReceipt(changedBurn.intake, '1', row), /payout_invalid/)
  const backdated = { ...row, capturedAtUtc: '1970-01-01T00:10:00.000Z' }
  assert.throws(
    () =>
      validateProspectivePayout(
        seal(Object.fromEntries(Object.entries(backdated).filter(([key]) => key !== 'sha256'))),
        candidate,
        intake,
      ),
    /payout_invalid/,
  )
})

test('a transferred receipt cannot be selected for payout capture', async () => {
  const { intake } = fixture({
    events: [transfer(1, HOLDER, OTHER, 101, 0, 'd'), transfer(1, OTHER, null, 101, 1, 'd')],
  })
  await assert.rejects(
    captureProspectivePayout({
      tokenId: '1',
      intakeLoader: async () => intake,
      freeBytes: () => 2_000_000_000,
    }),
    /no_eligible_burn/,
  )
})

test('anchor-only intake idles before disk check or payout RPC', async () => {
  let called = false
  const result = await captureProspectivePayout({
    intakeLoader: async () => ({
      anchor: { sha256: '0'.repeat(64) },
      windows: [],
      coveredThrough: 99,
      mints: 0,
    }),
    freeBytes: () => {
      called = true
      return 0
    },
    clientsForUrls: () => {
      throw Error('must_not_call_rpc')
    },
  })
  assert.deepEqual(result, { status: 'no_enrolled_mints_yet', coveredThrough: 99 })
  assert.equal(called, false)
})

test('recent burn is tried ahead of nine old failures and older burns still rotate', async () => {
  const { intake } = fixture()
  let newBurn
  for (let tokenId = 2; tokenId <= 10; tokenId++) {
    const mintEvent = transfer(tokenId, null, HOLDER, 100, tokenId - 1, 'c')
    mintEvent.transactionHash = hexWord(1_000 + tokenId)
    intake.windows[0].transfers.push(mintEvent)
    intake.windows[0].mints.push({
      ...intake.windows[0].mints[0],
      tokenId: String(tokenId),
      transactionHash: mintEvent.transactionHash,
      logIndex: tokenId - 1,
      rawLog: rawTransfer(mintEvent),
    })
    const isNew = tokenId === 10
    const burn = transfer(tokenId, HOLDER, null, isNew ? 102 : 101, isNew ? 0 : tokenId - 1, 'd')
    burn.transactionHash = hexWord(2_000 + tokenId)
    if (isNew) newBurn = burn
    else intake.windows[1].transfers.push(burn)
  }
  const h102 = { number: 102, hash: hash('f'), parentHash: hash('b'), timestamp: 1_200 }
  intake.windows.push({
    sequence: 3,
    sha256: '3'.repeat(64),
    fromBlock: 102,
    toBlock: 102,
    observedAtUtc: '1970-01-01T00:20:00.000Z',
    toHeader: h102,
    eventBlockHeaders: [h102],
    transfers: [newBurn],
    mints: [],
  })
  intake.coveredThrough = 102
  intake.mints = 10
  const out = await mkdtemp(join(tmpdir(), 'apyusd-outcomes-'))
  try {
    const seen = []
    const base = {
      out,
      intakeLoader: async () => intake,
      clientsForUrls: fakeOrigins,
      urls: ['https://a.example', 'https://b.example'],
      writer: writeProof,
      freeBytes: () => 2_000_000_000,
      capturedAtUtc: '2026-10-03T00:00:00.000Z',
      reader: async (_origin, mintEvent) => {
        const tokenId = BigInt(mintEvent.topics[3]).toString()
        seen.push(tokenId)
        if (tokenId !== '10') throw Error('apyusd_cohort_holder_payout_invalid')
        return payoutProof(intake.windows[0].mints[9], newBurn, '95', 1_200)
      },
    }
    for (let tokenId = 1; tokenId <= 9; tokenId++)
      await assert.rejects(
        captureProspectivePayout({ ...base, tokenId: String(tokenId), rpcClock: () => 0 }),
        /holder_payout_invalid/,
      )
    const row = await captureProspectivePayout({
      ...base,
      rpcClock: () => 0,
    })
    assert.equal(row.tokenId, '10')
    assert.equal((await readProspectiveStatus('10', base)).status, 'burned_with_saved_payout_proof')
    await assert.rejects(
      captureProspectivePayout({ ...base, rpcClock: () => 3 * 3 * 60 * 60 * 1_000 }),
      /holder_payout_invalid/,
    )
    assert.equal(seen.at(-1), '5')
    await assert.rejects(
      captureProspectivePayout({ ...base, rpcClock: () => 7 * 3 * 60 * 60 * 1_000 }),
      /holder_payout_invalid/,
    )
    assert.equal(seen.at(-1), '4')
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('RPC count and wall-clock budgets prevent an incomplete proof write', async () => {
  const { intake, mint, burn } = fixture()
  const out = await mkdtemp(join(tmpdir(), 'apyusd-outcomes-'))
  try {
    const base = {
      out,
      intakeLoader: async () => intake,
      clientsForUrls: fakeOrigins,
      urls: ['https://a.example', 'https://b.example'],
      writer: writeProof,
      freeBytes: () => 2_000_000_000,
    }
    await assert.rejects(
      captureProspectivePayout({
        ...base,
        rpcClock: (() => {
          let calls = 0
          return () => (calls++ < 2 ? 0 : 120_000)
        })(),
        reader: async () => payoutProof(mint, burn),
      }),
      /rpc_budget/,
    )
    await assert.rejects(
      captureProspectivePayout({
        ...base,
        rpcClock: () => 0,
        reader: async (origin) => {
          for (let i = 0; i < 49; i++) await origin.request('eth_probe', [])
          return payoutProof(mint, burn)
        },
      }),
      /rpc_budget/,
    )
    await assert.rejects(readFile(join(out, '1.json')), /ENOENT/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})
