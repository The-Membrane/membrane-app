import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { keccak256, stringToHex } from 'viem'

import { ASSET, RECEIPT } from './carry-public-apyusd-exit-common.mjs'
import {
  buildPostcutoffPayout,
  capturePostcutoffPayout,
  findPostcutoffBurn,
  validatePostcutoffPayout,
  verifyPostcutoffPayout,
  verifyPostcutoffPayoutLocal,
} from './apyusd-open-receipt-postcutoff-payouts.mjs'

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`
const topic = keccak256(stringToHex('Transfer(address,address,uint256)'))
const holder = `0x${'0'.repeat(39)}1`
const sourceMint = {
  blockNumber: 25_900_000,
  blockHash: word(1),
  transactionHash: word(2),
  logIndex: 4,
  topics: [topic, word(0), word(1), word(881)],
  data: '0x',
}
const burn = {
  blockNumber: 26_110_000,
  blockHash: word(3),
  transactionHash: word(4),
  logIndex: 7,
  topics: [topic, word(1), word(0), word(881)],
  data: '0x',
}
const source = { sha256: 'a'.repeat(64), mints: [sourceMint] }
const transfers = {
  sha256: 'b'.repeat(64),
  cohort: { openIds: ['881'] },
  transfers: [sourceMint],
}
const scanRows = [
  {
    sha256: 'c'.repeat(64),
    transfers: [burn],
    eventBlockHeaders: [{ number: burn.blockNumber, hash: burn.blockHash, timestamp: 2_000 }],
  },
]
const escrow = {
  sha256: 'd'.repeat(64),
  proofs: [{ tokenId: '881', issuedAt: 1_000, grossWithdrawRaw: '1000' }],
}
const proof = {
  tokenId: '881',
  holder,
  request: {
    blockNumber: sourceMint.blockNumber,
    blockHash: sourceMint.blockHash,
    transactionHash: sourceMint.transactionHash,
    logIndex: sourceMint.logIndex,
    timestamp: 1_000,
    requestedAssetRaw: '1000',
  },
  payout: {
    blockNumber: burn.blockNumber,
    blockHash: burn.blockHash,
    transactionHash: burn.transactionHash,
    logIndex: burn.logIndex,
    timestamp: 2_000,
    paidAssetRaw: '900',
    payoutTransferWitness: {
      address: ASSET,
      logIndex: 8,
      topics: [
        topic,
        `0x${RECEIPT.slice(2).padStart(64, '0')}`,
        `0x${holder.slice(2).padStart(64, '0')}`,
      ],
      data: word(900),
    },
  },
  requestToPayoutSeconds: 1_000,
  payoutBpsFloor: 9_000,
}

test('only an uninterrupted original-holder burn becomes a payout candidate', () => {
  const candidate = findPostcutoffBurn('881', source, transfers, scanRows)
  assert.equal(candidate.holder, holder)
  assert.equal(candidate.burn.transactionHash, burn.transactionHash)
  assert.equal(findPostcutoffBurn('881', source, transfers, []), null)
  const intermediate = {
    ...burn,
    blockNumber: burn.blockNumber - 1,
    topics: [topic, word(1), word(2), word(881)],
  }
  assert.throws(
    () =>
      findPostcutoffBurn('881', source, transfers, [
        { ...scanRows[0], transfers: [intermediate, burn] },
      ]),
    /apyusd_postcutoff_payout_intermediate_transfer/,
  )
  assert.throws(
    () =>
      findPostcutoffBurn(
        '881',
        source,
        { ...transfers, transfers: [sourceMint, intermediate] },
        scanRows,
      ),
    /apyusd_postcutoff_payout_prior_transfer/,
  )
})

test('sealed terminal proof binds exact mint, burn, positive paid amount and elapsed time', () => {
  const candidate = findPostcutoffBurn('881', source, transfers, scanRows)
  const row = buildPostcutoffPayout(proof, candidate, source, transfers, escrow)
  assert.equal(row.terminalPayoutVerified, true)
  assert.equal(row.prospectiveQForecast, false)
  assert.equal(validatePostcutoffPayout(row, candidate, source, transfers, escrow), row)
  assert.throws(
    () =>
      validatePostcutoffPayout(
        { ...row, proof: { ...proof, requestToPayoutSeconds: 999 } },
        candidate,
        source,
        transfers,
        escrow,
      ),
    /apyusd_postcutoff_payout_invalid/,
  )
  assert.throws(
    () =>
      validatePostcutoffPayout(
        { ...row, scanWindowSha256: 'd'.repeat(64) },
        candidate,
        source,
        transfers,
        escrow,
      ),
    /apyusd_postcutoff_payout_invalid/,
  )
  assert.throws(
    () =>
      buildPostcutoffPayout(
        { ...proof, payout: { ...proof.payout, paidAssetRaw: '899' } },
        candidate,
        source,
        transfers,
        escrow,
      ),
    /apyusd_postcutoff_payout_invalid/,
  )
  assert.throws(
    () =>
      buildPostcutoffPayout(
        { ...proof, payout: { ...proof.payout, timestamp: 2_001 } },
        candidate,
        source,
        transfers,
        escrow,
      ),
    /apyusd_postcutoff_payout_invalid/,
  )
})

test('disk reserve and no-burn case cannot open RPC or write an optimistic payout', async () => {
  let calls = 0
  const out = join(tmpdir(), `apyusd-postcutoff-payout-test-${randomUUID()}`)
  const base = {
    out,
    sourceLoader: async () => source,
    transfersLoader: async () => transfers,
    scanLoader: async () => [],
    escrowLoader: async () => escrow,
    clientsForUrls: () => {
      calls++
      return []
    },
    writer: async () => {
      calls++
    },
  }
  await assert.rejects(
    capturePostcutoffPayout('881', { ...base, freeBytes: () => 0 }),
    /apyusd_postcutoff_payout_disk_reserve/,
  )
  await assert.rejects(
    capturePostcutoffPayout('881', { ...base, freeBytes: () => 2_000_000_000 }),
    /apyusd_postcutoff_payout_no_burn/,
  )
  assert.equal(calls, 0)
})

test('two payout origins must return the same mined proof before writing', async () => {
  let writes = 0
  await assert.rejects(
    capturePostcutoffPayout('881', {
      out: join(tmpdir(), `apyusd-postcutoff-payout-test-${randomUUID()}`),
      sourceLoader: async () => source,
      transfersLoader: async () => transfers,
      scanLoader: async () => scanRows,
      escrowLoader: async () => escrow,
      clientsForUrls: () => [
        { url: 'https://eth-mainnet.g.alchemy.com/test', provider: 'alchemy' },
        { url: 'https://rpc.ankr.com/test', provider: 'ankr' },
      ],
      urls: ['https://eth-mainnet.g.alchemy.com/test', 'https://rpc.ankr.com/test'],
      reader: async (origin) => ({
        ...proof,
        payout: { ...proof.payout, paidAssetRaw: origin.provider === 'alchemy' ? '900' : '899' },
      }),
      writer: async () => {
        writes++
      },
      freeBytes: () => 2_000_000_000,
    }),
    /apyusd_postcutoff_payout_origins_disagree/,
  )
  assert.equal(writes, 0)
})

test('capture and verify require two canonical mined reads for the same saved payout', async () => {
  const out = join(tmpdir(), `apyusd-postcutoff-payout-test-${randomUUID()}`)
  const readOptions = []
  const options = {
    out,
    sourceLoader: async () => source,
    transfersLoader: async () => transfers,
    scanLoader: async () => scanRows,
    escrowLoader: async () => escrow,
    clientsForUrls: () => [
      { url: 'https://eth-mainnet.g.alchemy.com/test', provider: 'alchemy' },
      { url: 'https://rpc.ankr.com/test', provider: 'ankr' },
    ],
    urls: ['https://eth-mainnet.g.alchemy.com/test', 'https://rpc.ankr.com/test'],
    reader: async (_origin, _mint, _burn, flags) => {
      readOptions.push(flags)
      return proof
    },
    writer: async (path, row) => {
      await mkdir(out, { recursive: true })
      await writeFile(path, `${JSON.stringify(row)}\n`)
    },
    freeBytes: () => 2_000_000_000,
  }
  try {
    const captured = await capturePostcutoffPayout('881', options)
    assert.equal(captured.terminalPayoutVerified, true)
    assert.equal((await verifyPostcutoffPayoutLocal('881', options)).sha256, captured.sha256)
    assert.equal((await verifyPostcutoffPayout('881', options)).sha256, captured.sha256)
    assert.equal(readOptions.length, 4)
    assert.ok(
      readOptions.every(
        (flags) =>
          flags.requireUniqueBurn && flags.includePayoutWitness && flags.requireCanonicalBurn,
      ),
    )
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('live verify catches a resealed paid amount that passes local structure checks', async () => {
  const out = join(tmpdir(), `apyusd-postcutoff-payout-test-${randomUUID()}`)
  const candidate = findPostcutoffBurn('881', source, transfers, scanRows)
  const forgedProof = {
    ...proof,
    payout: {
      ...proof.payout,
      paidAssetRaw: '950',
      payoutTransferWitness: { ...proof.payout.payoutTransferWitness, data: word(950) },
    },
    payoutBpsFloor: 9_500,
  }
  const forged = buildPostcutoffPayout(forgedProof, candidate, source, transfers, escrow)
  const options = {
    out,
    sourceLoader: async () => source,
    transfersLoader: async () => transfers,
    scanLoader: async () => scanRows,
    escrowLoader: async () => escrow,
    clientsForUrls: () => [
      { url: 'https://eth-mainnet.g.alchemy.com/test', provider: 'alchemy' },
      { url: 'https://rpc.ankr.com/test', provider: 'ankr' },
    ],
    urls: ['https://eth-mainnet.g.alchemy.com/test', 'https://rpc.ankr.com/test'],
    reader: async () => proof,
  }
  try {
    await mkdir(out, { recursive: true })
    await writeFile(join(out, '881.json'), `${JSON.stringify(forged)}\n`)
    assert.equal((await verifyPostcutoffPayoutLocal('881', options)).sha256, forged.sha256)
    await assert.rejects(
      verifyPostcutoffPayout('881', options),
      /apyusd_postcutoff_payout_live_disagree/,
    )
    await assert.rejects(
      capturePostcutoffPayout('881', { ...options, freeBytes: () => 2_000_000_000 }),
      /apyusd_postcutoff_payout_live_disagree/,
    )
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('postcutoff payout stops an excessive RPC request sequence before writing', async () => {
  let writes = 0
  const options = {
    out: join(tmpdir(), `apyusd-postcutoff-payout-test-${randomUUID()}`),
    sourceLoader: async () => source,
    transfersLoader: async () => transfers,
    scanLoader: async () => scanRows,
    escrowLoader: async () => escrow,
    clientsForUrls: () => [
      {
        url: 'https://eth-mainnet.g.alchemy.com/test',
        provider: 'alchemy',
        request: async () => null,
      },
      { url: 'https://rpc.ankr.com/test', provider: 'ankr', request: async () => null },
    ],
    urls: ['https://eth-mainnet.g.alchemy.com/test', 'https://rpc.ankr.com/test'],
    reader: async (origin) => {
      for (let index = 0; index < 25; index++) await origin.request('eth_test', [])
      return proof
    },
    writer: async () => {
      writes++
    },
    freeBytes: () => 2_000_000_000,
  }
  await assert.rejects(
    capturePostcutoffPayout('881', options),
    /apyusd_postcutoff_payout_rpc_budget/,
  )
  assert.equal(writes, 0)
})
