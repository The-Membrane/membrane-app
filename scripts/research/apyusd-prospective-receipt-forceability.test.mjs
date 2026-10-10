import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { keccak256, stringToHex, toFunctionSelector } from 'viem'

import { ASSET, RECEIPT, VAULT } from './carry-public-apyusd-exit-common.mjs'
import {
  captureProspectiveForceability,
  readProspectiveClaimAt,
  replayAtBoundary,
  verifyProspectiveForceability,
} from './apyusd-prospective-receipt-forceability.mjs'

const HOLDER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const ZERO = `0x${'0'.repeat(64)}`
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`
const addr = (value) => `0x${value.slice(2).padStart(64, '0')}`
const topic = (signature) => keccak256(stringToHex(signature))
const TRANSFER = topic('Transfer(address,address,uint256)')
const WITHDRAW = topic('Withdraw(address,address,address,uint256,uint256)')
const ISSUED = topic('ReceiptIssued(address,address,uint256,uint256)')
const selector = Object.fromEntries(
  ['unlockingFee()', 'getReceipt(uint256)', 'isClaimable(uint256)', 'claim(uint256,address)'].map(
    (name) => [name.split('(')[0], toFunctionSelector(name)],
  ),
)
const terms = (claimableAt = 1_025) =>
  `0x${[1000, 0, 1000, claimableAt].map((value) => word(value).slice(2)).join('')}`
const identity = {
  vaultImpl: HOLDER,
  receiptImpl: OTHER,
  codeHashes: [word(1), word(2), word(3), word(4)],
}

function header(number) {
  return {
    number,
    hash: word(number),
    parentHash: word(number - 1),
    timestamp: 1000 + (number - 100) * 10,
  }
}

function event(id, from, to, blockNumber, logIndex, transactionHash = word(800 + blockNumber)) {
  return {
    blockNumber,
    blockHash: word(blockNumber),
    transactionHash,
    logIndex,
    topics: [TRANSFER, from ? addr(from) : ZERO, to ? addr(to) : ZERO, word(id)],
    data: '0x',
  }
}

function raw(eventValue) {
  return {
    ...eventValue,
    address: RECEIPT,
    blockNumber: `0x${eventValue.blockNumber.toString(16)}`,
    logIndex: `0x${eventValue.logIndex.toString(16)}`,
    transactionIndex: '0x0',
    removed: false,
  }
}

function fixture({ through = 104, transferAt = 104, burnAt = null, two = false } = {}) {
  const mints = [event(7, null, HOLDER, 100, 2, word(500))]
  if (two) mints.push(event(8, null, HOLDER, 100, 6, word(501)))
  const events = [...mints]
  if (transferAt !== null && transferAt <= through)
    events.push(event(7, HOLDER, OTHER, transferAt, 0))
  if (burnAt !== null && burnAt <= through) events.push(event(7, HOLDER, null, burnAt, 0))
  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
  const row = {
    sequence: 1,
    sha256: 'b'.repeat(64),
    fromBlock: 100,
    toBlock: through,
    toHeader: header(through),
    eventBlockHeaders: [...new Set(events.map((item) => item.blockNumber))].map(header),
    transfers: events,
    mints: mints.map((item) => ({
      tokenId: BigInt(item.topics[3]).toString(),
      initialHolder: HOLDER,
      issueBlockNumber: 100,
      issueBlockHash: word(100),
      issueBlockTimestamp: 1000,
      transactionHash: item.transactionHash,
      logIndex: item.logIndex,
      rawLog: raw(item),
      requestAssets: { status: 'unknown', assetsRaw: null, source: null },
    })),
  }
  return {
    anchor: { sha256: 'a'.repeat(64), origins: ['alpha.example', 'beta.example'] },
    windows: [row],
    coveredThrough: through,
    mints: row.mints.length,
  }
}

function transactionReceipt(mint) {
  const first = mint.logIndex - 2
  const at = (address, index, topics, data) => ({
    address,
    logIndex: `0x${index.toString(16)}`,
    topics,
    data,
  })
  return {
    status: '0x1',
    transactionHash: mint.transactionHash,
    blockHash: mint.issueBlockHash,
    blockNumber: '0x64',
    logs: [
      at(
        VAULT,
        first,
        [WITHDRAW, addr(HOLDER), addr(VAULT), addr(HOLDER)],
        `0x${word(1010).slice(2)}${word(1000).slice(2)}`,
      ),
      at(ASSET, first + 1, [TRANSFER, addr(VAULT), addr(RECEIPT)], word(1000)),
      raw(
        mint.rawLog
          ? {
              blockNumber: 100,
              blockHash: word(100),
              transactionHash: mint.transactionHash,
              logIndex: mint.logIndex,
              topics: mint.rawLog.topics,
              data: '0x',
            }
          : mint,
      ),
      at(VAULT, first + 3, [ISSUED, addr(HOLDER), addr(HOLDER), word(mint.tokenId)], word(1000)),
    ],
  }
}

function fakeClients(intake, options = {}) {
  const calls = []
  const clientsForUrls = () =>
    ['alpha.example', 'beta.example'].map((host) => ({
      url: `https://${host}/rpc`,
      provider: host,
      async request(method, params) {
        calls.push({ host, method, params })
        if (method === 'eth_getBlockByNumber') {
          const number =
            params[0] === 'finalized' ? (options.head ?? 104) : Number(BigInt(params[0]))
          const value = header(number)
          return {
            ...value,
            number: `0x${number.toString(16)}`,
            timestamp: `0x${value.timestamp.toString(16)}`,
          }
        }
        if (method === 'eth_getTransactionReceipt') {
          if (options.archiveUnavailableId === '8' && params[0] === word(501))
            throw Error('public_rpc_unavailable')
          const mint = intake.windows[0].mints.find((item) => item.transactionHash === params[0])
          return transactionReceipt(mint)
        }
        if (method === 'eth_getCode') {
          assert.deepEqual(params[1], { blockHash: word(103), requireCanonical: true })
          if (options.divergentHolderCode && host === 'beta.example') return '0x6000'
          return Object.hasOwn(options, 'holderCode') ? options.holderCode : '0x'
        }
        if (method === 'eth_call') {
          const call = params[0]
          assert.equal(params[1].requireCanonical, true)
          assert.ok([word(100), word(103)].includes(params[1].blockHash))
          if (call.data.startsWith(selector.unlockingFee))
            assert.equal(params[1].blockHash, word(100))
          if (call.data.startsWith(selector.isClaimable))
            assert.equal(params[1].blockHash, word(103))
          if (call.data.startsWith(selector.unlockingFee)) return word(10n ** 16n)
          if (call.data.startsWith(selector.getReceipt))
            return params[1].blockHash === word(103) && options.changedTerms
              ? terms(1_026)
              : terms()
          if (call.data.startsWith(selector.isClaimable))
            return word(options.claimable === false ? 0 : 1)
        }
        throw Error(`unexpected_test_method:${method}`)
      },
      async send(envelope) {
        calls.push({ host, method: 'send', params: envelope.params })
        assert.equal(envelope.method, 'eth_call')
        assert.deepEqual(envelope.params[1], { blockHash: word(103), requireCanonical: true })
        assert.equal(envelope.params[0].from, HOLDER)
        assert.equal(envelope.params[0].data.slice(0, 10), selector.claim)
        return options.revert
          ? { error: { message: 'execution reverted' } }
          : { result: word(options.claimAmount ?? 1000) }
      },
    }))
  return { clientsForUrls, calls }
}

async function context(t, intake = fixture(), options = {}) {
  const out = await mkdtemp(join(tmpdir(), 'apyusd-forceability-test-'))
  t.after(() => rm(out, { recursive: true, force: true }))
  const fake = fakeClients(intake, options)
  const attestations = []
  const args = {
    out,
    intakeLoader: async () => intake,
    urls: ['https://alpha.example/rpc', 'https://beta.example/rpc'],
    clientsForUrls: fake.clientsForUrls,
    attestor: async (_origin, hash) => {
      attestations.push(hash)
      return identity
    },
    freeBytes: () => 2_000_000_000,
    now: () => 1_100_000,
    rpcClock: () => 1_100_000,
    payoutReader: async () =>
      options.paid
        ? {
            status: 'burned_with_saved_payout_proof',
            payoutProofSha256: 'c'.repeat(64),
            burnBlock: 102,
          }
        : { status: 'burned_no_verified_payout' },
  }
  return { out, args, calls: fake.calls, attestations, intake }
}

test('anchor-only intake returns before client construction or RPC', async () => {
  let called = false
  const result = await captureProspectiveForceability({
    intakeLoader: async () => ({
      anchor: { sha256: 'a'.repeat(64) },
      windows: [],
      coveredThrough: 99,
      mints: 0,
    }),
    clientsForUrls: () => {
      called = true
      throw Error('network')
    },
    freeBytes: () => 0,
  })
  assert.equal(result.status, 'no-enrolled-mints-yet')
  assert.equal(called, false)
})

test('pins issue economics and exact first eligible claim despite a later holder transfer', async (t) => {
  const { args, calls, attestations, out, intake } = await context(t)
  const result = await captureProspectiveForceability({ ...args, tokenId: '7' })
  assert.equal(result.status, 'claim-positive')
  assert.equal(result.timingStatus, 'late-boundary')
  assert.equal(result.firstEligibleBlock, 103)
  assert.equal(result.simulatedAmountRaw, '1000')
  assert.deepEqual([...new Set(attestations)], [word(100), word(103)])
  assert.equal(calls.filter((call) => call.method === 'send').length, 2)
  const saved = await verifyProspectiveForceability('7', { out, intakeLoader: async () => intake })
  assert.equal(saved.issue.proof.grossWithdrawRaw, '1010')
  assert.equal(saved.issue.proof.vaultFeeRaw, '10')
  assert.equal(saved.issue.proof.receiptEscrowRaw, '1000')
  assert.equal(saved.boundary.before.timestamp, 1020)
  assert.equal(saved.boundary.firstEligible.timestamp, 1030)
  assert.equal(
    replayAtBoundary(
      intake,
      { mint: intake.windows[0].mints[0], event: intake.windows[0].transfers[0] },
      103,
    ).lostOriginalControl,
    false,
  )
  assert.equal(
    (await captureProspectiveForceability({ ...args, tokenId: '7' })).evidence,
    'saved_two_origin_capture_not_live_reverified',
  )
  assert.equal(calls.filter((call) => call.method === 'send').length, 2)
  const path = join(out, '7.boundary.json')
  const tampered = JSON.parse(await readFile(path, 'utf8'))
  tampered.status = 'claim-reverted-or-zero'
  await writeFile(path, `${JSON.stringify(tampered)}\n`)
  await assert.rejects(
    verifyProspectiveForceability('7', { out, intakeLoader: async () => intake }),
    /apyusd_forceability_boundary_invalid/,
  )
})

test('scheduled eligibility distinguishes not due from transfer coverage pending', async (t) => {
  const intake = fixture({ through: 101, transferAt: null })
  const dueLater = await context(t, intake, { head: 101 })
  const notDue = await captureProspectiveForceability({ ...dueLater.args, tokenId: '7' })
  assert.equal(notDue.status, 'not-due')
  const dueNow = await context(t, intake, { head: 104 })
  const pending = await captureProspectiveForceability({ ...dueNow.args, tokenId: '7' })
  assert.equal(pending.status, 'coverage-pending')
  assert.equal(
    dueNow.calls.some((call) => call.method === 'send'),
    false,
  )
})

test('boundary replay separates transferred, unproved burn, and paid before assay', async (t) => {
  const moved = await context(t, fixture({ transferAt: 102 }))
  assert.equal(
    (await captureProspectiveForceability({ ...moved.args, tokenId: '7' })).status,
    'holder-transferred',
  )
  assert.equal(
    (
      await verifyProspectiveForceability('7', {
        out: moved.out,
        intakeLoader: async () => moved.intake,
      })
    ).status,
    'holder-transferred',
  )
  const burned = await context(t, fixture({ transferAt: null, burnAt: 102 }))
  assert.equal(
    (await captureProspectiveForceability({ ...burned.args, tokenId: '7' })).status,
    'burn-unproved',
  )
  assert.equal(
    (
      await verifyProspectiveForceability('7', {
        out: burned.out,
        intakeLoader: async () => burned.intake,
      })
    ).status,
    'boundary-proof-pending',
  )
  const paid = await context(t, fixture({ transferAt: null, burnAt: 102 }), { paid: true })
  assert.equal(
    (await captureProspectiveForceability({ ...paid.args, tokenId: '7' })).status,
    'paid-before-assay',
  )
  assert.equal(
    (
      await verifyProspectiveForceability('7', {
        out: paid.out,
        intakeLoader: async () => paid.intake,
        payoutReader: paid.args.payoutReader,
      })
    ).status,
    'paid-before-assay',
  )
  await assert.rejects(
    verifyProspectiveForceability('7', {
      out: paid.out,
      intakeLoader: async () => paid.intake,
      payoutReader: async () => ({ status: 'burned_no_verified_payout' }),
    }),
    /apyusd_forceability_payout_binding_changed/,
  )
})

test('terms change and exact-holder revert cannot become positive claims', async (t) => {
  const changed = await context(t, fixture({ transferAt: null }), { changedTerms: true })
  assert.equal(
    (await captureProspectiveForceability({ ...changed.args, tokenId: '7' })).status,
    'identity-or-terms-changed',
  )
  const reverted = await context(t, fixture({ transferAt: null }), { revert: true })
  assert.equal(
    (await captureProspectiveForceability({ ...reverted.args, tokenId: '7' })).status,
    'claim-reverted-or-zero',
  )
  const zero = await context(t, fixture({ transferAt: null }), { claimAmount: 0 })
  assert.equal(
    (await captureProspectiveForceability({ ...zero.args, tokenId: '7' })).status,
    'claim-reverted-or-zero',
  )
  const contract = await context(t, fixture({ transferAt: null }), { holderCode: '0x6000' })
  assert.equal(
    (await captureProspectiveForceability({ ...contract.args, tokenId: '7' })).status,
    'holder-origin-unproven',
  )
  const delegated = await context(t, fixture({ transferAt: null }), {
    holderCode: `0xef0100${'a'.repeat(40)}`,
  })
  assert.equal(
    (await captureProspectiveForceability({ ...delegated.args, tokenId: '7' })).status,
    'claim-positive',
  )
  const missingCode = await context(t, fixture({ transferAt: null }), { holderCode: null })
  assert.equal(
    (await captureProspectiveForceability({ ...missingCode.args, tokenId: '7' })).status,
    'archive-unavailable',
  )
  const divergentCode = await context(t, fixture({ transferAt: null }), {
    divergentHolderCode: true,
  })
  assert.equal(
    (await captureProspectiveForceability({ ...divergentCode.args, tokenId: '7' })).status,
    'source-disagreement',
  )
})

test('one archive failure leaves the next enrolled receipt assayable', async (t) => {
  const intake = fixture({ transferAt: null, two: true })
  const { args } = await context(t, intake, { archiveUnavailableId: '8' })
  const result = await captureProspectiveForceability(args)
  assert.equal(result.status, 'claim-positive')
  assert.equal(result.tokenId, '7')
})

test('later exact-holder reader pins both origins to an intake-covered block', async (t) => {
  const intake = fixture({ through: 103, transferAt: null })
  const { args, calls } = await context(t, intake)
  const result = await readProspectiveClaimAt({
    intake,
    tokenId: '7',
    blockNumber: 103,
    urls: args.urls,
    clientsForUrls: args.clientsForUrls,
    attestor: args.attestor,
    rpcClock: args.rpcClock,
  })
  assert.equal(result.block.hash, word(103))
  assert.equal(result.claim.simulation.amountRaw, '1000')
  assert.equal(result.holderOrigin.kind, 'eoa')
  assert.equal(calls.filter((call) => call.method === 'send').length, 2)
})

test('rotating auto capture reaches older pending mints through repeated transient results', async (t) => {
  const intake = fixture({ transferAt: null })
  for (let token = 8; token <= 12; token++) {
    const transfer = event(token, null, HOLDER, 100, (token - 7) * 4 + 2, word(500 + token - 7))
    intake.windows[0].transfers.push(transfer)
    intake.windows[0].mints.push({
      ...intake.windows[0].mints[0],
      tokenId: String(token),
      transactionHash: transfer.transactionHash,
      logIndex: transfer.logIndex,
      rawLog: raw(transfer),
    })
  }
  intake.windows[0].transfers.sort((a, b) => a.logIndex - b.logIndex)
  intake.mints = 6
  const { args, calls, out } = await context(t, intake, { changedTerms: true })
  await captureProspectiveForceability(args)
  await captureProspectiveForceability(args)
  const visited = new Set(
    calls
      .filter((call) => call.method === 'eth_getTransactionReceipt')
      .map((call) => call.params[0]),
  )
  assert.equal(visited.size, 6)
  const cursor = JSON.parse(await readFile(join(out, 'selection-cursor.json'), 'utf8'))
  assert.equal(cursor.nextIndex, 0)
})
