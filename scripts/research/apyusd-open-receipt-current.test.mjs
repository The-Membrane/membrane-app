import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem'

import { RECEIPT } from './apyusd-receipt-cohort-source.mjs'
import { runCurrentMode, validateCurrent } from './apyusd-open-receipt-current.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const subject = {
  tokenId: '881',
  holder: '0x1111111111111111111111111111111111111111',
  receiptEscrowRaw: '1000',
  issuedAt: 100,
  claimableAt: 259300,
}
const expected = {
  source: {
    transfersSha256: 'a'.repeat(64),
    escrowSha256: 'b'.repeat(64),
    boundariesSha256: 'c'.repeat(64),
  },
  subjects: [subject],
}
const seal = (body) => ({ ...body, sha256: sha(JSON.stringify(body)) })
const fixture = () =>
  seal({
    study: 'apyusd_open_receipt_current_v1',
    source: expected.source,
    receipt: RECEIPT,
    origins: ['eth-mainnet.g.alchemy.com', 'rpc.ankr.com'],
    block: { number: 1, hash: `0x${'d'.repeat(64)}`, timestamp: 300000 },
    subjects: expected.subjects,
    proofs: [
      {
        tokenId: '881',
        status: 'same_holder',
        isClaimable: true,
        claimStatus: 'success',
        claimAmountRaw: '966',
      },
    ],
  })

const ABI = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function getReceipt(uint256) view returns (uint208,uint208,uint48,uint48)',
  'function isClaimable(uint256) view returns (bool)',
  'function claim(uint256,address) returns (uint256)',
])
const BLOCK_HASH = `0x${'d'.repeat(64)}`
const IMPLEMENTATION = `0x${'0'.repeat(24)}54f1c7ffe10bc392f08ae9432a7e21a6e86bb982`
const NOW_MS = Date.parse('2026-10-03T12:00:00.000Z')
const BLOCK_TIME_MS = NOW_MS - 15 * 60_000
const liveSubjects = Array.from({ length: 7 }, (_, index) => ({
  ...subject,
  tokenId: String(881 + index),
}))

function fakeMeasurement({
  secondClaimAmount = 966n,
  secondBlockHash = BLOCK_HASH,
  blockTimeMs = BLOCK_TIME_MS,
  holderCodes = ['0x', '0x'],
  changedOwnerTokenId = null,
} = {}) {
  const urls = ['https://eth-mainnet.g.alchemy.com/fake', 'https://rpc.ankr.com/fake']
  let callCount = 0
  let codeReads = 0
  const clientsForUrls = () =>
    urls.map((url, index) => ({
      url,
      request: async (method, params) => {
        if (method === 'eth_getBlockByNumber') {
          assert.deepEqual(params, ['finalized', false])
          return {
            number: '0x1',
            hash: index === 0 ? BLOCK_HASH : secondBlockHash,
            timestamp: `0x${(blockTimeMs / 1000).toString(16)}`,
          }
        }
        if (method === 'eth_getCode') {
          assert.equal(params[0], subject.holder)
          assert.deepEqual(params[1], { blockHash: BLOCK_HASH, requireCanonical: true })
          const subjectIndex = Math.floor(codeReads / 2)
          codeReads++
          return Array.isArray(holderCodes[index])
            ? holderCodes[index][subjectIndex]
            : holderCodes[index]
        }
        assert.equal(method, 'eth_getStorageAt')
        assert.equal(params[0], RECEIPT)
        assert.deepEqual(params[2], { blockHash: BLOCK_HASH, requireCanonical: true })
        return IMPLEMENTATION
      },
      send: async ({ method, params }) => {
        assert.equal(method, 'eth_call')
        assert.equal(params[0].to, RECEIPT)
        assert.deepEqual(params[1], { blockHash: BLOCK_HASH, requireCanonical: true })
        const { functionName, args } = decodeFunctionData({ abi: ABI, data: params[0].data })
        if (functionName === 'claim') {
          assert.equal(params[0].from, subject.holder)
          callCount++
        }
        const result =
          functionName === 'ownerOf'
            ? String(args[0]) === changedOwnerTokenId
              ? `0x${'2'.repeat(40)}`
              : subject.holder
            : functionName === 'getReceipt'
              ? [1000n, 0n, 100n, 259300n]
              : functionName === 'isClaimable'
                ? true
                : index === 0
                  ? 966n
                  : secondClaimAmount
        return {
          result: encodeFunctionResult({ abi: ABI, functionName, result }),
        }
      },
    }))
  return {
    options: {
      urls,
      sourceLoader: async () => ({ subjects: liveSubjects, source: expected.source }),
      clientsForUrls,
      now: () => NOW_MS,
    },
    calls: () => callCount,
    codeReads: () => codeReads,
  }
}

test('sealed current receipt proof binds cohort identity and a positive bounded claim', () => {
  assert.equal(validateCurrent(fixture(), expected).proofs[0].claimAmountRaw, '966')
  const tooLarge = fixture()
  tooLarge.proofs[0].claimAmountRaw = '1001'
  const { sha256: _old, ...body } = tooLarge
  assert.throws(() => validateCurrent(seal(body), expected), /apyusd_current_proof_invalid/)
})

test('rejects a false claimability flag and changed cohort source even with a fresh seal', () => {
  const falseFlag = fixture()
  falseFlag.proofs[0].isClaimable = false
  const { sha256: _old, ...body } = falseFlag
  assert.throws(() => validateCurrent(seal(body), expected), /apyusd_current_proof_invalid/)
  const changed = fixture()
  changed.source = { ...changed.source, transfersSha256: 'f'.repeat(64) }
  const { sha256: _seal, ...changedBody } = changed
  assert.throws(
    () => validateCurrent(seal(changedBody), expected),
    /apyusd_current_artifact_invalid/,
  )
})

test('--observe returns a dated unsealed seven-receipt observation without invoking a writer', async () => {
  const { options, calls, codeReads } = fakeMeasurement()
  let writes = 0
  const row = await runCurrentMode('--observe', {
    ...options,
    writer: async () => {
      writes++
    },
  })
  assert.equal(writes, 0)
  assert.equal(calls(), 14)
  assert.equal(codeReads(), 14)
  assert.equal(row.observationStatus, 'unsealed')
  assert.equal(row.scope, 'current_status_of_frozen_historical_open_receipts')
  assert.equal(row.prospectiveQForecast, false)
  assert.equal(row.holderCodeChecked, true)
  assert.equal(row.observedAtUtc, '2026-10-03T12:00:00.000Z')
  assert.equal(row.sha256, undefined)
  assert.equal(row.proofs.length, 7)
  assert.ok(row.proofs.every((proof) => proof.claimAmountRaw === '966'))
  assert.ok(row.proofs.every((proof) => proof.holderCodeStatus === 'no_code'))
})

test('--capture still sends the validated sealed result to the exclusive writer', async () => {
  const { options, codeReads } = fakeMeasurement()
  const writes = []
  const row = await runCurrentMode('--capture', {
    ...options,
    out: '/fake/exclusive-output.json',
    writer: async (path, value) => writes.push({ path, value }),
  })
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/fake/exclusive-output.json')
  assert.equal(writes[0].value, row)
  assert.equal(validateCurrent(row, { subjects: liveSubjects, source: expected.source }), row)
  assert.equal(row.observedAtUtc, undefined)
  assert.equal(row.holderCodeChecked, undefined)
  assert.equal(codeReads(), 0)
})

test('--observe distinguishes EIP-7702 delegation, contract code, and divergent code', async () => {
  const perSubjectCode = Array(7).fill('0x')
  perSubjectCode[2] = `0xef0100${'a'.repeat(40)}`
  perSubjectCode[3] = '0x6000'
  const row = await runCurrentMode(
    '--observe',
    fakeMeasurement({ holderCodes: [perSubjectCode, perSubjectCode] }).options,
  )
  assert.equal(row.holderCodeChecked, true)
  assert.equal(
    row.proofs.filter((proof) => proof.holderCodeStatus === 'eip7702_delegated').length,
    1,
  )
  assert.equal(row.proofs.filter((proof) => proof.holderCodeStatus === 'contract_code').length, 1)
  assert.equal(row.proofs.filter((proof) => proof.holderCodeStatus === 'no_code').length, 5)
  await assert.rejects(
    runCurrentMode('--observe', fakeMeasurement({ holderCodes: ['0x', '0x6000'] }).options),
    /apyusd_current_holder_code_diverged/,
  )
  await assert.rejects(
    runCurrentMode('--observe', fakeMeasurement({ holderCodes: ['0x6000', '0x'] }).options),
    /apyusd_current_holder_code_diverged/,
  )
})

test('a transferred receipt stays visible but is excluded from original-holder claimability', async () => {
  const row = await runCurrentMode(
    '--observe',
    fakeMeasurement({ changedOwnerTokenId: '883' }).options,
  )
  assert.deepEqual(row.proofs[2], {
    tokenId: '883',
    status: 'holder_changed',
    currentOwner: `0x${'2'.repeat(40)}`,
    holderCodeStatus: 'no_code',
  })
  assert.equal(row.proofs.filter((proof) => proof.claimStatus === 'success').length, 6)
  const forged = fixture()
  forged.proofs[0] = { tokenId: '881', status: 'holder_changed', currentOwner: subject.holder }
  const { sha256: _seal, ...body } = forged
  assert.throws(() => validateCurrent(seal(body), expected), /apyusd_current_owner_change_invalid/)
})

test('observation fails closed when the two origins disagree on claim or finalized header', async () => {
  await assert.rejects(
    runCurrentMode('--observe', fakeMeasurement({ secondClaimAmount: 965n }).options),
    /apyusd_current_origins_disagree/,
  )
  await assert.rejects(
    runCurrentMode(
      '--observe',
      fakeMeasurement({ secondBlockHash: `0x${'e'.repeat(64)}` }).options,
    ),
    /apyusd_current_headers_disagree/,
  )
})

test('--observe rejects stale finalized blocks while capture preserves its historical behavior', async () => {
  const stale = fakeMeasurement({ blockTimeMs: NOW_MS - 45 * 60_000 - 1000 })
  await assert.rejects(runCurrentMode('--observe', stale.options), /apyusd_current_block_stale/)
  const writes = []
  const captured = await runCurrentMode('--capture', {
    ...stale.options,
    writer: async (_path, row) => writes.push(row),
  })
  assert.equal(writes.length, 1)
  assert.equal(writes[0], captured)
  const boundary = await runCurrentMode(
    '--observe',
    fakeMeasurement({ blockTimeMs: NOW_MS - 45 * 60_000 }).options,
  )
  assert.equal(boundary.observationStatus, 'unsealed')
})

test('--observe rejects implausibly future finalized blocks but allows two minutes of clock skew', async () => {
  await assert.rejects(
    runCurrentMode('--observe', fakeMeasurement({ blockTimeMs: NOW_MS + 121_000 }).options),
    /apyusd_current_block_future/,
  )
  const boundary = await runCurrentMode(
    '--observe',
    fakeMeasurement({ blockTimeMs: NOW_MS + 120_000 }).options,
  )
  assert.equal(boundary.observationStatus, 'unsealed')
})
