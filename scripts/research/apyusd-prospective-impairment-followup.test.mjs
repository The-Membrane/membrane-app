import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { keccak256, stringToHex } from 'viem'

import { canonical, readChain, sha } from './carry-public-apyusd-exit-common.mjs'
import { RECEIPT } from './carry-public-apyusd-exit-common.mjs'
import { intakeMint } from './apyusd-prospective-receipt-forceability.mjs'
import {
  captureProspectiveImpairment,
  readVerifiedProspectiveImpairment,
  validateImpairmentRows,
} from './apyusd-prospective-impairment-followup.mjs'

const HOLDER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const WORD = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const ADDRESS_TOPIC = (address) => `0x${address.slice(2).padStart(64, '0')}`
const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'))
const header = (number) => ({
  number,
  hash: WORD(number),
  parentHash: WORD(number - 1),
  timestamp: 1000 + (number - 100) * 10,
})
const identity = {
  vaultImpl: HOLDER,
  receiptImpl: OTHER,
  codeHashes: [WORD(1), WORD(2), WORD(3), WORD(4)],
}
const terms = ['1000', '0', '1000', '1025']

function transfer(from, to, blockNumber, logIndex) {
  return {
    blockNumber,
    blockHash: WORD(blockNumber),
    transactionHash: WORD(500 + blockNumber),
    logIndex,
    topics: [
      TRANSFER,
      from ? ADDRESS_TOPIC(from) : WORD(0),
      to ? ADDRESS_TOPIC(to) : WORD(0),
      WORD(7),
    ],
    data: '0x',
  }
}

function fixture() {
  const mint = transfer(null, HOLDER, 100, 2)
  const firstWindow = {
    fromBlock: 100,
    toBlock: 104,
    toHeader: header(104),
    sha256: 'b'.repeat(64),
    transfers: [mint],
    eventBlockHeaders: [header(100)],
    mints: [
      {
        tokenId: '7',
        initialHolder: HOLDER,
        issueBlockNumber: 100,
        issueBlockHash: WORD(100),
        issueBlockTimestamp: 1000,
        transactionHash: mint.transactionHash,
        logIndex: mint.logIndex,
        rawLog: {
          ...mint,
          address: RECEIPT,
          blockNumber: '0x64',
          logIndex: '0x2',
          transactionIndex: '0x0',
          removed: false,
        },
      },
    ],
  }
  const intake = {
    anchor: { sha256: 'a'.repeat(64), origins: ['alpha.example', 'beta.example'] },
    windows: [firstWindow],
    coveredThrough: 104,
    mints: 1,
  }
  const issue = { sha256: 'c'.repeat(64), identity, receiptTerms: terms }
  const boundary = {
    status: 'claim-reverted-or-zero',
    sha256: 'd'.repeat(64),
    issueSha256: issue.sha256,
    firstEligible: header(103),
  }
  return { intake, issue, boundary }
}

function appendWindow(intake, movement = null) {
  intake.windows.push({
    fromBlock: 105,
    toBlock: 105,
    toHeader: header(105),
    sha256: 'e'.repeat(64),
    transfers: movement ? [movement] : [],
    eventBlockHeaders: movement ? [header(105)] : [],
    mints: [],
  })
  intake.coveredThrough = 105
}

async function context(t, data = fixture()) {
  const out = await mkdtemp(join(tmpdir(), 'apyusd-impairment-test-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  let rpcReads = 0
  let recovered = false
  const options = {
    out,
    intakeLoader: async () => data.intake,
    tokensLoader: async () => ['7'],
    forceabilityLoader: async () => ({
      status: data.boundary.status,
      issue: data.issue,
      boundary: data.boundary,
    }),
    freeBytes: () => 2_000_000_000,
    writer: async (row, directory, verify) => {
      await mkdir(directory, { recursive: true })
      await verify(directory)
      await writeFile(
        join(directory, `${String(row.sequence).padStart(8, '0')}.json`),
        `${JSON.stringify(row)}\n`,
        { flag: 'wx' },
      )
    },
    now: () => data.intake.windows.at(-1).toHeader.timestamp * 1000,
    reader: async ({ blockNumber }) => {
      rpcReads++
      return {
        block: header(blockNumber),
        identity,
        terms,
        holderOrigin: { kind: 'eoa', hash: WORD(1) },
        claim: {
          isClaimable: recovered,
          simulation: recovered
            ? { status: 'success', amountRaw: '1000' }
            : { status: 'evm_revert', amountRaw: null },
        },
      }
    },
  }
  return {
    data,
    out,
    options,
    reads: () => rpcReads,
    recover: () => {
      recovered = true
    },
  }
}

test('without a failed first-eligible proof the recorder idles before disk or RPC', async () => {
  let called = false
  const result = await captureProspectiveImpairment({
    intakeLoader: async () => fixture().intake,
    tokensLoader: async () => [],
    freeBytes: () => {
      called = true
      return 0
    },
    reader: async () => {
      throw Error('network')
    },
  })
  assert.equal(result.status, 'no-due-impairment')
  assert.equal(called, false)
})

test('negative then positive exact-holder checks bound recovery to an interval', async (t) => {
  const { data, out, options, reads, recover } = await context(t)
  const impaired = await captureProspectiveImpairment(options)
  assert.equal(impaired.status, 'impaired')
  assert.equal(reads(), 1)
  appendWindow(data.intake)
  recover()
  const recovered = await captureProspectiveImpairment(options)
  assert.equal(recovered.status, 'recovered')
  assert.deepEqual(recovered.recoveryInterval, { lowerSeconds: 10, upperSeconds: 20 })
  assert.equal((await readChain(join(out, '7'))).length, 2)
  const verified = await readVerifiedProspectiveImpairment({
    out,
    intakeLoader: options.intakeLoader,
    tokensLoader: options.tokensLoader,
    forceabilityLoader: options.forceabilityLoader,
  })
  assert.deepEqual(verified.summary, {
    failedFirstEligibleEpisodes: 1,
    recoveredIntervals: 1,
    rightCensoredEpisodes: 0,
    stillImpairedEpisodes: 0,
    awaitingFollowupEpisodes: 0,
  })
  assert.deepEqual(verified.episodes[0].recoveryInterval, { lowerSeconds: 10, upperSeconds: 20 })
  const terminal = await captureProspectiveImpairment(options)
  assert.equal(terminal.status, 'no-due-impairment')
  assert.equal(reads(), 2)
})

test('holder transfer censors at its event block without another claim simulation', async (t) => {
  const { data, options, reads, out } = await context(t)
  await captureProspectiveImpairment(options)
  appendWindow(data.intake, transfer(HOLDER, OTHER, 105, 0))
  const censored = await captureProspectiveImpairment(options)
  assert.equal(censored.status, 'censored_transfer')
  assert.equal(reads(), 1)
  const rows = await readChain(join(out, '7'))
  assert.equal(rows[1].censor.elapsedSeconds, 20)
  assert.equal(rows[1].observation, null)
})

test('a locally resealed optimistic recovery duration fails the interval verifier', async (t) => {
  const { data, options, recover, out } = await context(t)
  await captureProspectiveImpairment(options)
  appendWindow(data.intake)
  recover()
  await captureProspectiveImpairment(options)
  const rows = await readChain(join(out, '7'))
  const forged = { ...rows[1], recoveryInterval: { lowerSeconds: 0, upperSeconds: 20 } }
  const { sha256: _old, ...body } = forged
  forged.sha256 = sha(canonical(body))
  assert.throws(
    () =>
      validateImpairmentRows([rows[0], forged], {
        intake: data.intake,
        issue: data.issue,
        boundary: data.boundary,
        entry: intakeMint(data.intake, '7'),
      }),
    /apyusd_impairment_observation_invalid/,
  )
})

test('an unavailable first receipt advances the durable candidate cursor', async (t) => {
  const data = fixture()
  const secondMint = transfer(null, HOLDER, 100, 6)
  secondMint.topics[3] = WORD(8)
  data.intake.windows[0].transfers.push(secondMint)
  data.intake.windows[0].mints.push({
    ...data.intake.windows[0].mints[0],
    tokenId: '8',
    transactionHash: secondMint.transactionHash,
    logIndex: 6,
    rawLog: {
      ...secondMint,
      address: RECEIPT,
      blockNumber: '0x64',
      logIndex: '0x6',
      transactionIndex: '0x0',
      removed: false,
    },
  })
  data.intake.mints = 2
  const { options } = await context(t, data)
  options.tokensLoader = async () => ['7', '8']
  const originalReader = options.reader
  options.reader = async (input) => {
    if (input.tokenId === '7') throw Error('public_rpc_unavailable')
    return originalReader(input)
  }
  assert.deepEqual(await captureProspectiveImpairment(options), {
    status: 'archive-unavailable',
    tokenId: '7',
  })
  const next = await captureProspectiveImpairment(options)
  assert.equal(next.status, 'impaired')
  assert.equal(next.tokenId, '8')
})
